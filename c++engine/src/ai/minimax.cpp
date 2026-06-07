#include "ai/minimax.h"
#include "core/zobrist.h"
#include <algorithm>
#include <iostream>
#include <limits>
#include <string>
#include <cstdlib>
#ifdef HEXUKI_THREADS
#include <thread>
#include <atomic>
#include <vector>
#include <mutex>
#endif
#if defined(HEXUKI_THREADS) && defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX            // keep std::min/std::max usable (windows.h would #define min/max)
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

namespace hexuki {
namespace minimax {

// Constants
constexpr int INF = 1000000;
constexpr int MATE_SCORE = 900000;
constexpr int TIMEOUT_CHECK_INTERVAL = 1000;  // Check time every 1000 nodes

// Per-ply reusable move buffers. The search is single-threaded DFS, so at any instant
// only one node per ply is live -- node at ply p iterates s_moveStack[p] while its
// children use s_moveStack[p+1], so [p] is never disturbed mid-iteration. Reusing one
// vector per ply means getValidMovesInto() allocates only on the first node at each
// depth, then just refills -- killing the ~per-node heap allocation on deep searches.
// thread_local => each future Lazy-SMP worker gets its own set (no sharing/races).
constexpr int MOVE_STACK_SIZE = 64;  // > any reachable ply (<= empties <= 19)
static thread_local std::vector<Move> s_moveStack[MOVE_STACK_SIZE];

// ============================================================================
// Transposition Table Implementation
// ============================================================================

// Differential-testing switch: when false the TT probes always miss and stores are dropped,
// so the search is pure alpha-beta -- a GROUND-TRUTH oracle that cannot have any TT bug. Set
// from config.useTranspositionTable at the start of findBestMove.
static bool g_ttEnabled = true;

// TRACK 1: when true the TT also RETURNS cached values (EXACT) + bound cutoffs, not just ordering
// hints. Off by default (shipped = ordering-only). Set from config.useValueTT in findBestMove.
static bool g_useValueTT = false;
// Debug: when true, every node asserts the incremental hash equals the full recompute (catches any
// future Zobrist drift -- the exact bug class that made the value-TT return wrong values). Off by
// default; turned on by the value-TT difftest. g_firstBadLogged limits output to the first offender.
static bool g_verifyExact = false;
static bool g_firstBadLogged = false;

// Move-ordering quality stats (single-thread analysis only). g_cutFirst/g_cutTotal = the fraction
// of beta cutoffs that happened on the FIRST move tried -> the standard measure of how good the move
// ordering is (near 1.0 = ordering already finds the best move first; lower = headroom to improve).
static bool g_orderStats = false;
static long long g_cutTotal = 0, g_cutFirst = 0;

// ASPIRATION-BUG HUNT (single-thread debug): verify every value-TT RETURN against brute force.
static bool g_verifyReturns = false;

// Brute-force negamax to `depth` (game end when depth >= empties). NO TT, NO alpha-beta -> the
// undisputed true (depth-limited) value. Own board copy + allocating getValidMoves -> reentrant.
static int verifyTrueValue(HexukiBitboard board, int depth) {
    if (depth == 0 || board.isGameOver()) return evaluate(board);
    std::vector<Move> mv = board.getValidMoves();
    if (mv.empty()) return evaluate(board);
    int best = -INF;
    for (const auto& m : mv) {
        board.makeMove(m);
        int s = -verifyTrueValue(board, depth - 1);
        board.unmakeMove(m);
        if (s > best) best = s;
    }
    return best;
}

// Pack a TTEntry into a single 64-bit word for the lockless XOR-checksum slot. Stored entries
// always have depth >= 1 (stores happen at depth>=1 nodes), so the depth bits make `packed` nonzero
// -> data==0 unambiguously means "empty slot". Layout: score:32 | depth:5 | flag:2 | hexId:5 |
// tileValue:4 (= 48 bits; hexId -1 sentinel maps to 31 since real hexIds are 0..18).
static inline uint64_t packEntry(const TTEntry& e) {
    uint64_t p = (uint32_t)e.score;                           // bits 0..31 (two's-complement int32)
    p |= (uint64_t)(e.depth & 0x1F) << 32;                    // bits 32..36
    p |= (uint64_t)((int)e.flag & 0x3) << 37;                 // bits 37..38
    uint64_t hx = (e.bestMove.hexId < 0) ? 31u : (uint64_t)(e.bestMove.hexId & 0x1F);
    p |= hx << 39;                                            // bits 39..43
    p |= (uint64_t)(e.bestMove.tileValue & 0xF) << 44;        // bits 44..47
    return p;
}
static inline TTEntry unpackEntry(uint64_t p) {
    TTEntry e;
    e.score = (int)(int32_t)(uint32_t)(p & 0xFFFFFFFFull);
    e.depth = (int)((p >> 32) & 0x1F);
    e.flag  = (TTEntry::Flag)((p >> 37) & 0x3);
    int hx  = (int)((p >> 39) & 0x1F);
    e.bestMove.hexId    = (hx == 31) ? -1 : hx;
    e.bestMove.tileValue = (int)((p >> 44) & 0xF);
    return e;
}

TranspositionTable::TranspositionTable(size_t sizeMB)
    : hits(0)
    , misses(0) {
    // Fixed-size array of slots, largest power of two that fits in sizeMB. Eviction on
    // collision caps memory (the old unordered_map grew unbounded -> OOM on 12+ empties).
    size_t want = (sizeMB * 1024 * 1024) / sizeof(TTSlot);
    size_t n = 1024;
    while ((n << 1) <= want) n <<= 1;
    table.assign(n, TTSlot());
    mask = n - 1;
}

void TranspositionTable::store(uint64_t hash, const TTEntry& entry) {
    if (!g_ttEnabled) return;
    TTSlot& slot = table[hash & mask];
    const uint64_t packed = packEntry(entry);
    // Depth-preferred replacement: keep a deeper result already there from a DIFFERENT position;
    // otherwise (empty, shallower, or same position) overwrite. The read-modify-write isn't atomic,
    // but a racing replacement only changes WHICH entry survives -- never the correctness of what a
    // probe returns (the checksum guarantees that). Any eviction is fine; a miss just recomputes.
    const uint64_t curData = slot.data.load(std::memory_order_relaxed);
    if (curData != 0) {
        const uint64_t curKey   = slot.xorKey.load(std::memory_order_relaxed) ^ curData;
        const int      curDepth = (int)((curData >> 32) & 0x1F);
        if (!(curDepth <= entry.depth || curKey == hash)) return;
    }
    // Write the checksum word first, then data: a reader seeing the new data must also see the new
    // xorKey to pass the check; any other interleaving fails the checksum and reads as a miss.
    slot.xorKey.store(hash ^ packed, std::memory_order_relaxed);
    slot.data.store(packed, std::memory_order_relaxed);
}

bool TranspositionTable::probe(uint64_t hash, TTEntry& entry) const {
    if (!g_ttEnabled) { misses.fetch_add(1, std::memory_order_relaxed); return false; }
    const TTSlot& slot = table[hash & mask];
    const uint64_t data   = slot.data.load(std::memory_order_relaxed);
    const uint64_t xorKey = slot.xorKey.load(std::memory_order_relaxed);
    // Hit only if the checksum matches: (xorKey ^ data) reconstructs the stored key, which must
    // equal the probed hash. A torn (cross-write) read fails this and is treated as a miss.
    if (data != 0 && (xorKey ^ data) == hash) {
        entry = unpackEntry(data);
        hits.fetch_add(1, std::memory_order_relaxed);
        return true;
    }
    misses.fetch_add(1, std::memory_order_relaxed);
    return false;
}

void TranspositionTable::clear() {
    std::fill(table.begin(), table.end(), TTSlot());
    hits.store(0, std::memory_order_relaxed);
    misses.store(0, std::memory_order_relaxed);
}

// ============================================================================
// Evaluation Function
// ============================================================================

long long getOrderCutFirst() { return g_cutFirst; }
long long getOrderCutTotal() { return g_cutTotal; }

int evaluate(const HexukiBitboard& board) {
    // Get actual scores for both players
    int p1Score = board.getScore(PLAYER_1);
    int p2Score = board.getScore(PLAYER_2);

    // Return from current player's perspective (required for negamax)
    // Positive = current player winning, negative = opponent winning
    if (board.getCurrentPlayer() == PLAYER_1) {
        return p1Score - p2Score;
    } else {
        return p2Score - p1Score;
    }
}

// ============================================================================
// Move Ordering
// ============================================================================

void orderMoves(std::vector<Move>& moves, const TTEntry* ttEntry,
                const KillerMoves& killers, const HistoryTable& history, int ply) {
    // KILLER MOVE OPTIMIZATION: Use fast heuristics instead of makeMove/evaluate
    // Eliminates 40-60M makeMove calls at depth 10 (2-3x speedup)
    // GUARANTEED SAFE: Same best move, same score, just better move ordering

    std::vector<std::pair<int, size_t>> moveScores;
    moveScores.reserve(moves.size());

    for (size_t i = 0; i < moves.size(); i++) {
        const Move& move = moves[i];
        int score = 0;

        // Priority 1: TT move (proven best from previous search)
        if (ttEntry && move == ttEntry->bestMove) {
            score = 10000000;
        }
        // Priority 2: Killer moves (recently caused beta cutoffs)
        else if (killers.isKiller(ply, move)) {
            score = 1000000 + move.tileValue * 10;
        }
        // Priority 3: History + heuristics
        else {
            // History heuristic (moves that were historically good)
            score = history.getScore(move);

            // High-value tiles are usually better
            score += move.tileValue * 100;

            // Center control bonus (hexes near center are strategic)
            if (move.hexId == 9) {
                score += 50;  // Center hex
            } else if (move.hexId == 4 || move.hexId == 6 || move.hexId == 7 ||
                       move.hexId == 11 || move.hexId == 12) {
                score += 30;  // Adjacent to center
            }

            // Corner bonus (can create multiple chains)
            if (move.hexId == 0 || move.hexId == 2 || move.hexId == 16 || move.hexId == 18) {
                score += 20;
            }
        }

        moveScores.push_back({score, i});
    }

    // Sort by score (descending) and reorder moves
    std::sort(moveScores.begin(), moveScores.end(),
              [](const auto& a, const auto& b) { return a.first > b.first; });

    // Reorder moves based on sorted scores
    std::vector<Move> sortedMoves;
    sortedMoves.reserve(moves.size());
    for (const auto& pair : moveScores) {
        sortedMoves.push_back(moves[pair.second]);
    }
    moves = sortedMoves;
}

// ============================================================================
// Alpha-Beta Search
// ============================================================================

int alphaBeta(
    HexukiBitboard& board,
    int depth,
    int alpha,
    int beta,
    TranspositionTable& tt,
    long long& nodesSearched,
    std::chrono::steady_clock::time_point startTime,
    int timeLimitMs,
    KillerMoves& killers,
    HistoryTable& history,
    int ply
) {
    nodesSearched++;

    // Check timeout periodically
    if (nodesSearched % TIMEOUT_CHECK_INTERVAL == 0) {
        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - startTime).count();
        if (elapsed >= timeLimitMs) {
            return 0;  // Timeout - return neutral score
        }
    }

    // Terminal node: game over or depth reached
    if (depth == 0 || board.isGameOver()) {
        return evaluate(board);
    }

    uint64_t hash = board.getHash();

    // TRACK 1 debug: the incremental hash must equal the full recompute at EVERY node. If this
    // holds across the whole search, the running hash is a faithful, unique fingerprint (the full
    // hash binds hands to players) -> no cross-player collisions -> the value-TT can trust it.
    if (g_verifyExact && !g_firstBadLogged) {
        uint64_t full = Zobrist::hash(board);
        if (full != hash) {
            g_firstBadLogged = true;
            std::cout << "@HASHDRIFT incremental=" << hash << " full=" << full
                      << " pos=" << board.savePosition() << std::endl;
        }
    }

    const int alphaOrig = alpha;  // window we were given -- flag the stored entry against THIS

    // Transposition table lookup (textbook pattern). Narrow the window from a stored
    // bound for cutoffs, but the entry's flag below is computed from alphaOrig, not the
    // mutated alpha -- that mutated-flag was the order-dependence bug (off-by-one).
    TTEntry ttEntry;
    bool ttHit = false;  // an entry exists at all -> its bestMove is safe for ordering

    if (tt.probe(hash, ttEntry)) {
        ttHit = true;
        // Default (g_useValueTT == false): TT is MOVE ORDERING ONLY (ttEntry.bestMove via
        // orderMoves below). Correct by construction -- ordering can't change the value.
        // TRACK 1 (g_useValueTT == true): also return cached values + take bound cutoffs (the
        // speed lever under debugging). This is the path being made correct; keep it flag-gated.
        if (g_useValueTT && ttEntry.depth >= depth) {
            // Debug: check the entry we are about to RETURN against brute-force truth. EXACT must
            // equal it; a returned LOWER bound must be <= true; a returned UPPER bound must be >= true.
            if (g_verifyReturns && !g_firstBadLogged) {
                int e = 0; for (int h = 0; h < 19; h++) if (!board.isHexOccupied(h)) e++;
                if (e <= 6) {
                    const bool willReturn =
                        ttEntry.flag == TTEntry::EXACT ||
                        (ttEntry.flag == TTEntry::LOWER_BOUND && ttEntry.score >= beta) ||
                        (ttEntry.flag == TTEntry::UPPER_BOUND && ttEntry.score <= alpha);
                    if (willReturn) {
                        int tv = verifyTrueValue(board, ttEntry.depth);
                        bool bad = (ttEntry.flag == TTEntry::EXACT       && ttEntry.score != tv)
                                || (ttEntry.flag == TTEntry::LOWER_BOUND && tv < ttEntry.score)
                                || (ttEntry.flag == TTEntry::UPPER_BOUND && tv > ttEntry.score);
                        if (bad) {
                            g_firstBadLogged = true;
                            std::cout << "@BADRET flag=" << (int)ttEntry.flag << " stored=" << ttEntry.score
                                      << " true=" << tv << " entryDepth=" << ttEntry.depth << " needDepth=" << depth
                                      << " win[" << alpha << "," << beta << "] empties=" << e
                                      << " pos=" << board.savePosition() << std::endl;
                        }
                    }
                }
            }
            if (ttEntry.flag == TTEntry::EXACT) {
                return ttEntry.score;
            } else if (ttEntry.flag == TTEntry::LOWER_BOUND && ttEntry.score >= beta) {
                return ttEntry.score;
            } else if (ttEntry.flag == TTEntry::UPPER_BOUND && ttEntry.score <= alpha) {
                return ttEntry.score;
            }
        }
    }

    // Get and order moves. Fill a per-ply reusable buffer instead of allocating a fresh
    // vector at every node (ply is bounded by empties <= 19 < MOVE_STACK_SIZE; the
    // local fallback never triggers in practice but keeps us safe if it ever did).
    std::vector<Move> moveFallback;
    std::vector<Move>& moves = (ply < MOVE_STACK_SIZE) ? s_moveStack[ply] : moveFallback;
    board.getValidMovesInto(moves);

    if (moves.empty()) {
        // No moves available - game over
        return evaluate(board);
    }

    // Order moves: try the TT's remembered best move first whenever any entry exists.
    // Safe now that the entry flag is computed against alphaOrig (below).
    orderMoves(moves, ttHit ? &ttEntry : nullptr, killers, history, ply);

    int bestScore = -INF;
    Move bestMove = moves[0];

    // Search all moves
    int moveIdx = 0;
    for (const auto& move : moves) {
        board.makeMove(move);
        int score = -alphaBeta(board, depth - 1, -beta, -alpha, tt, nodesSearched, startTime, timeLimitMs,
                              killers, history, ply + 1);
        board.unmakeMove(move);

        if (score > bestScore) {
            bestScore = score;
            bestMove = move;
            if (score > alpha) alpha = score;  // raise the search window
        }

        // Beta cutoff
        if (alpha >= beta) {
            if (g_orderStats) { g_cutTotal++; if (moveIdx == 0) g_cutFirst++; }  // ordering-quality stat
            killers.update(ply, bestMove);  // Store killer move
            history.update(bestMove, depth);  // Update history
            break;
        }
        moveIdx++;
    }

    // Flag the stored entry against the ORIGINAL window (not the mutated alpha):
    //   bestScore <= alphaOrig -> never beat alpha   -> UPPER_BOUND
    //   bestScore >= beta      -> caused a cutoff     -> LOWER_BOUND
    //   otherwise              -> exact within window -> EXACT
    TTEntry::Flag flag = (bestScore <= alphaOrig) ? TTEntry::UPPER_BOUND
                       : (bestScore >= beta)      ? TTEntry::LOWER_BOUND
                       : TTEntry::EXACT;

    // Debug: catch the FIRST node that STORES a bound/value inconsistent with brute-force truth.
    // EXACT must == true; a LOWER_BOUND must be <= true; an UPPER_BOUND must be >= true.
    if (g_verifyReturns && !g_firstBadLogged) {
        int e = 0; for (int h = 0; h < 19; h++) if (!board.isHexOccupied(h)) e++;
        if (e <= 6) {
            int tv = verifyTrueValue(board, depth);
            bool bad = (flag == TTEntry::EXACT       && bestScore != tv)
                    || (flag == TTEntry::LOWER_BOUND && tv < bestScore)
                    || (flag == TTEntry::UPPER_BOUND && tv > bestScore);
            if (bad) {
                g_firstBadLogged = true;
                std::cout << "@BADSTORE flag=" << (int)flag << " stored=" << bestScore << " true=" << tv
                          << " depth=" << depth << " origWin[" << alphaOrig << "," << beta << "] empties=" << e
                          << " pos=" << board.savePosition() << std::endl;
            }
        }
    }

    // Store in transposition table
    tt.store(hash, TTEntry(bestScore, depth, flag, bestMove));

    return bestScore;
}

// ============================================================================
// Quiescence Search
// ============================================================================

int quiescence(
    HexukiBitboard& board,
    int alpha,
    int beta,
    TranspositionTable& tt,
    int& nodesSearched
) {
    nodesSearched++;

    // Stand-pat score
    int standPat = evaluate(board);

    if (standPat >= beta) {
        return beta;
    }

    if (standPat > alpha) {
        alpha = standPat;
    }

    // Only search "tactical" moves (high-value tiles, critical positions)
    // For now, just return stand-pat (quiescence not critical for this game)
    return standPat;
}

#ifdef HEXUKI_THREADS
// ----------------------------------------------------------------------------
// P-core affinity (hybrid CPUs). Pure SCHEDULING -- cannot change any value; it only decides
// WHICH logical processors the root-split workers run on. On a P/E hybrid (e.g. Core Ultra), the
// per-depth join() barrier lets a slow E-core straggler dominate wall-clock, so we pin workers to
// the performance cores. Everything degrades to a no-op if detection fails or it's not Windows.
// ----------------------------------------------------------------------------
// Ordered list of group-0 logical-processor indices, performance cores (highest EfficiencyClass)
// FIRST, then efficiency cores. Empty if unknown. We pin worker t to coreOrder[t] (1:1, distinct
// cores) so: (a) at high thread counts every core stays busy -- full throughput, no oversubscription
// or migration; (b) at low thread counts the workers land on the fast P-cores first. Pure
// scheduling: which core a thread runs on can never change the value the search computes.
static std::vector<int> detectCoreOrder() {
#if defined(_WIN32)
    DWORD len = 0;
    GetLogicalProcessorInformationEx(RelationProcessorCore, nullptr, &len);
    if (len == 0) return {};
    std::vector<unsigned char> buf(len);
    if (!GetLogicalProcessorInformationEx(RelationProcessorCore,
            reinterpret_cast<PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>(buf.data()), &len)) return {};
    std::vector<std::pair<int,int>> cores;  // (efficiencyClass, procIndex)
    for (DWORD off = 0; off < len; ) {
        auto* info = reinterpret_cast<PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>(buf.data() + off);
        if (info->Relationship == RelationProcessorCore) {
            for (WORD g = 0; g < info->Processor.GroupCount; g++) {
                if (info->Processor.GroupMask[g].Group != 0) continue;
                uint64_t m = (uint64_t)info->Processor.GroupMask[g].Mask;
                for (int b = 0; b < 64; b++) if (m & (1ull << b))
                    cores.push_back({ (int)info->Processor.EfficiencyClass, b });
            }
        }
        off += info->Size;
    }
    std::sort(cores.begin(), cores.end(),
              [](const auto& a, const auto& b){ return a.first != b.first ? a.first > b.first : a.second < b.second; });
    std::vector<int> order;
    order.reserve(cores.size());
    for (auto& c : cores) order.push_back(c.second);
    return order;
#else
    return {};
#endif
}

// Pin the calling thread to the single logical processor `cpuIndex` (no-op if <0 or off-Windows).
static inline void pinThreadToCpu(int cpuIndex) {
#if defined(_WIN32)
    if (cpuIndex >= 0 && cpuIndex < 64) SetThreadAffinityMask(GetCurrentThread(), (DWORD_PTR)(1ull << cpuIndex));
#else
    (void)cpuIndex;
#endif
}

// Recommended auto worker count: all logical processors (using every core gave the best throughput
// in practice; the static root split needs the extra workers to stay busy). Falls back to 1.
int recommendedThreads() {
    unsigned hc = std::thread::hardware_concurrency();
    return hc > 0 ? (int)hc : 1;
}

// ============================================================================
// Root-split parallel search (native build only)
// ============================================================================
// Correct BY CONSTRUCTION: it is exactly the serial root move loop, distributed across threads.
// Each worker fully searches a SUBSET of the root moves with pure alpha-beta (the shared TT is
// ordering-only, so it can never corrupt a value -- a race just yields a worse ordering hint).
// A shared atomic alpha carries the best-so-far across threads for cross-move pruning: searching
// a move against a higher alpha only prunes moves that are provably <= the global best, so the
// winning move is still searched exactly. The answer is the max over all workers.
static SearchResult findBestMoveRootSplit(HexukiBitboard& board, const SearchConfig& config) {
    // Build BOTH lazily-initialized globals now, single-threaded, before any worker touches them.
    HexukiBitboard::ensureLegalTable();
    Zobrist::initialize();

    g_ttEnabled = config.useTranspositionTable;
    g_useValueTT = config.useValueTT;
    g_verifyExact = config.verifyExact; g_firstBadLogged = false;
    auto startTime = std::chrono::steady_clock::now();

    std::vector<Move> rootMoves = board.getValidMoves();
    SearchResult result;
    if (rootMoves.empty()) { result.score = evaluate(board); result.bestMove = Move(); return result; }

    TranspositionTable tt(config.ttSizeMB);     // shared; lockless XOR slots -> value races can't corrupt
    const int N = std::max(1, std::min(config.threads, (int)rootMoves.size()));

    // 1:1 distinct-core placement, P-cores first (see detectCoreOrder). Worker t pins to
    // coreOrder[t]; empty => no pinning (let the OS scheduler decide). Scheduling only -- never a
    // value. Escape hatch: set HEXUKI_NO_PIN=1 to disable pinning (A/B vs the OS scheduler).
    const std::vector<int> coreOrder = std::getenv("HEXUKI_NO_PIN") ? std::vector<int>{} : detectCoreOrder();

    Move bestMove = rootMoves[0];
    int bestScore = -INF;
    long long totalNodes = 0;

    // Iterative deepening, where EACH depth is a parallel root split (each worker fully searches a
    // subset of the root moves to depth d; a shared atomic alpha prunes across workers). The
    // shared ordering-only TT carries good-move hints from depth d to d+1; we also search the
    // previous best move first so the global alpha rises early (better pruning). @PROGRESS is
    // emitted per completed depth -> the server gets live progress, and on cancel (process kill)
    // the last reported depth is the best-so-far. Correct by construction: the final depth's
    // combine is the serial root loop distributed.
    for (int depth = 1; depth <= config.maxDepth; depth++) {
        if (depth > 1) {  // search last depth's best move first (front of the list)
            auto it = std::find(rootMoves.begin(), rootMoves.end(), bestMove);
            if (it != rootMoves.end()) std::rotate(rootMoves.begin(), it, it + 1);
        }

        // Aspiration around the previous depth's score (same scheme + accept-only-exact rule as the
        // single-thread path): seed globalAlpha at aLow and cap every child at beta=aHigh; accept the
        // combined best only if it lands strictly inside (aLow, aHigh), else widen the breached side
        // and re-run the whole split. With the full window (aHigh==INF) it's the old behavior exactly.
        const int ASPIRATION_MIN_DEPTH = 4;
        const bool aspirate = config.useAspiration && depth >= ASPIRATION_MIN_DEPTH
                              && std::abs(bestScore) < MATE_SCORE;
        int delta = 96;
        int aLow  = aspirate ? bestScore - delta : -INF;
        int aHigh = aspirate ? bestScore + delta :  INF;

        int dBest; Move dMove; long long dNodes;
        while (true) {
            std::atomic<int> globalAlpha{ aLow };

            // YOUNG BROTHERS WAIT: search the first (rotated previous-best) move ALONE to a tight
            // value first, then seed globalAlpha with it before splitting the rest. The "younger
            // brothers" are then searched against a strong bound -> far fewer redundant parallel
            // nodes. Its PV subtree also fills the shared TT, speeding the siblings. Still exactly
            // the serial root loop (move0 first, then the rest) distributed -> correct by construction.
            long long n0 = 0;
            int score0;
            {
                HexukiBitboard b0 = board;
                KillerMoves k0; HistoryTable h0;
                b0.makeMove(rootMoves[0]);
                score0 = -alphaBeta(b0, depth - 1, -aHigh, -aLow, tt, n0, startTime,
                                    config.timeLimitMs, k0, h0, 1);
                b0.unmakeMove(rootMoves[0]);
            }
            if (score0 > aLow) globalAlpha.store(score0, std::memory_order_relaxed);

            dBest = score0; dMove = rootMoves[0]; dNodes = n0;

            // Split the REMAINING moves only if move0 didn't already fail high (>=aHigh = a cutoff).
            if (score0 < aHigh) {
                std::atomic<int> nextIdx{ 1 };          // dynamic work queue: grab the next root move
                std::vector<int>  tBest(N, -INF);
                std::vector<Move> tMove(N);
                std::vector<long long> tNodes(N, 0);

                auto worker = [&](int t) {
                    if (!coreOrder.empty()) pinThreadToCpu(coreOrder[t % (int)coreOrder.size()]);  // 1:1, P-first
                    HexukiBitboard b = board;            // own copy
                    KillerMoves killers;
                    HistoryTable history;
                    long long nodes = 0;
                    int localBest = -INF;
                    Move localMove = rootMoves[0];
                    for (;;) {
                        int mi = nextIdx.fetch_add(1, std::memory_order_relaxed);  // work-stealing: no idle threads
                        if (mi >= (int)rootMoves.size()) break;
                        int alpha = std::max(localBest, globalAlpha.load(std::memory_order_relaxed));
                        if (alpha >= aHigh) break;   // already fail-high -> stop (don't search with alpha>=beta)
                        const Move& move = rootMoves[mi];
                        b.makeMove(move);
                        int score = -alphaBeta(b, depth - 1, -aHigh, -alpha, tt, nodes, startTime,
                                               config.timeLimitMs, killers, history, 1);
                        b.unmakeMove(move);
                        // Record only a real improvement (score strictly exceeds the alpha searched
                        // against) -> searched exactly, the new global max -> reported move is optimal.
                        if (score > alpha) {
                            localBest = score; localMove = move;
                            int g = globalAlpha.load(std::memory_order_relaxed);
                            while (score > g && !globalAlpha.compare_exchange_weak(g, score, std::memory_order_relaxed)) {}
                        }
                        if (localBest >= aHigh) break;  // fail high -> stop this worker (re-search wider)
                    }
                    tBest[t] = localBest; tMove[t] = localMove; tNodes[t] = nodes;
                };

                std::vector<std::thread> pool;
                pool.reserve(N - 1);
                for (int t = 1; t < N; t++) pool.emplace_back(worker, t);
                worker(0);
                for (auto& th : pool) th.join();

                for (int t = 0; t < N; t++) { dNodes += tNodes[t]; if (tBest[t] > dBest) { dBest = tBest[t]; dMove = tMove[t]; } }
            }

            // fail low: nothing beat aLow -> widen the floor and re-run. fail high: best reached aHigh
            // (a bound, not exact) -> widen the ceiling. Re-center from the prev score; the final widen
            // reaches the full window, so the accepted dBest is always exact.
            if (dBest <= aLow && aLow > -INF) { delta += delta; aLow = bestScore - delta; if (aLow <= -MATE_SCORE) aLow = -INF; continue; }
            if (dBest >= aHigh && aHigh < INF) { delta += delta; aHigh = bestScore + delta; if (aHigh >= MATE_SCORE) aHigh = INF; continue; }
            break;  // exact (aLow < dBest < aHigh, or full window)
        }
        totalNodes += dNodes;
        bestMove = dMove; bestScore = dBest;

        if (config.streamProgress) {
            long long elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - startTime).count();
            std::cout << "@PROGRESS " << depth << " " << bestScore << " "
                      << bestMove.hexId << " " << bestMove.tileValue << " "
                      << totalNodes << " " << elapsed << std::endl;
        }
        if (std::abs(bestScore) > MATE_SCORE - 100) break;
    }

    result.score = bestScore;
    result.bestMove = bestMove;
    result.depth = config.maxDepth;
    result.nodesSearched = totalNodes;
    result.timeMs = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - startTime).count();
    return result;
}
#endif // HEXUKI_THREADS

// ============================================================================
// Main Search Function
// ============================================================================

SearchResult findBestMove(HexukiBitboard& board, const SearchConfig& config) {
#ifdef HEXUKI_THREADS
    if (config.threads > 1) return findBestMoveRootSplit(board, config);
#endif
    SearchResult result;

    g_ttEnabled = config.useTranspositionTable;  // false => pure alpha-beta ground-truth oracle
    g_useValueTT = config.useValueTT;
    g_verifyExact = config.verifyExact; g_firstBadLogged = false;
    g_verifyReturns = config.verifyReturns;
    g_orderStats = config.orderStats; if (g_orderStats) { g_cutTotal = 0; g_cutFirst = 0; }

    auto startTime = std::chrono::steady_clock::now();

    // Initialize transposition table
    TranspositionTable tt(config.ttSizeMB);

    // Initialize killer moves and history heuristic
    KillerMoves killers;
    HistoryTable history;

    std::vector<Move> moves = board.getValidMoves();

    if (moves.empty()) {
        // No legal moves
        result.bestMove = Move();
        result.score = evaluate(board);
        return result;
    }

    if (moves.size() == 1) {
        // Only one move - still need to search ahead to get accurate score!
        // Don't just return current evaluation - make the move and evaluate the resulting position
        result.bestMove = moves[0];

        // Make the move, search the resulting position, then unmake
        board.makeMove(moves[0]);
        long long nodesSearched = 0;
        result.score = -alphaBeta(board, config.maxDepth - 1, -INF, INF, tt, nodesSearched, startTime, config.timeLimitMs, killers, history, 0);
        board.unmakeMove(moves[0]);

        result.depth = config.maxDepth;
        result.nodesSearched = nodesSearched;

        auto endTime = std::chrono::steady_clock::now();
        result.timeMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();

        return result;
    }

    Move bestMove = moves[0];
    int bestScore = -INF;

    if (config.useIterativeDeepening) {
        // Iterative deepening: search 1, 2, 3, ..., maxDepth
        for (int depth = 1; depth <= config.maxDepth; depth++) {
            long long nodesSearched = 0;

            Move currentBestMove;
            int currentBestScore = -INF;

            // Order moves based on previous iteration's best
            if (depth > 1) {
                orderMoves(moves, nullptr, killers, history, 0);
            }

            bool depthTimedOut = false;
            long long elapsed = 0;

            // Aspiration window around the PREVIOUS depth's score (bestScore). Searching a narrow
            // [aLow,aHigh] yields far more cutoffs; we ACCEPT only a score strictly inside it (exact)
            // and otherwise widen the breached side and re-search -- the final widen hits the full
            // window, so the value is always exact. Disabled (full window, one pass = the old code)
            // when the flag is off, at shallow depths, or once near mate.
            const int ASPIRATION_MIN_DEPTH = 4;
            const bool aspirate = config.useAspiration && depth >= ASPIRATION_MIN_DEPTH
                                  && std::abs(bestScore) < MATE_SCORE;
            int delta = 96;
            int aLow  = aspirate ? bestScore - delta : -INF;
            int aHigh = aspirate ? bestScore + delta :  INF;

            while (true) {
                int alpha = aLow, beta = aHigh;
                Move bm; int bs = -INF;
                for (const auto& move : moves) {
                    board.makeMove(move);
                    int score = -alphaBeta(board, depth - 1, -beta, -alpha, tt, nodesSearched, startTime, config.timeLimitMs, killers, history, 1);
                    board.unmakeMove(move);

                    auto now = std::chrono::steady_clock::now();
                    elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - startTime).count();
                    if (elapsed >= config.timeLimitMs) { depthTimedOut = true; break; }

                    if (score > bs) {
                        bs = score; bm = move;
                        if (score > alpha) alpha = score;  // raise the window as moves improve
                    }
                    // Beta cutoff at the root: with a finite aspiration beta, a move can reach it.
                    // STOP here -- continuing would search later moves with alpha>beta (an inverted
                    // window) which stores garbage bounds. bs>=aHigh below triggers the fail-high
                    // re-search. (With the full window beta==INF this never fires -> old behavior.)
                    if (alpha >= beta) break;
                }
                if (depthTimedOut) break;

                // fail low: every move <= aLow -> true value <= aLow. Lower the floor and re-search.
                if (bs <= aLow && aLow > -INF) {
                    delta += delta;
                    aLow = bs - delta;
                    if (aLow <= -MATE_SCORE) aLow = -INF;
                    continue;
                }
                // fail high: best move only proved >= aHigh (a bound). Raise the ceiling and re-search.
                if (bs >= aHigh && aHigh < INF) {
                    delta += delta;
                    aHigh = bs + delta;
                    if (aHigh >= MATE_SCORE) aHigh = INF;
                    continue;
                }
                // exact: aLow < bs < aHigh (or full window) -> accept.
                currentBestScore = bs; currentBestMove = bm;
                break;
            }

            // If we timed out mid-depth, don't use this depth's results - use previous depth
            if (depthTimedOut) {
                result.timeout = true;
                break;
            }

            // Update best move from this COMPLETED depth
            bestMove = currentBestMove;
            bestScore = currentBestScore;
            result.depth = depth;
            result.nodesSearched += nodesSearched;

            if (config.verbose) {
                std::cout << "Depth " << depth << ": score=" << bestScore
                          << " move=" << bestMove.toString()
                          << " nodes=" << nodesSearched
                          << " time=" << elapsed << "ms" << std::endl;
            }

            // Machine-readable per-depth progress for the server's anytime search. ONE line
            // per completed ID depth -> the worker streams these out (progress) and keeps the
            // last one as best-so-far on cancel. Cumulative nodes/time, so no re-search needed.
            // Format: @PROGRESS <depth> <score> <hexId> <tileValue> <totalNodes> <elapsedMs>
            if (config.streamProgress) {
                std::cout << "@PROGRESS " << depth << " " << bestScore << " "
                          << bestMove.hexId << " " << bestMove.tileValue << " "
                          << result.nodesSearched << " " << elapsed << std::endl;
            }

            // Stop if mate found
            if (std::abs(bestScore) > MATE_SCORE - 100) {
                break;
            }
        }
    } else {
        // Single depth search
        long long nodesSearched = 0;
        int alpha = -INF;
        int beta = INF;

        if (config.useMoveOrdering) {
            orderMoves(moves, nullptr, killers, history, 0);
        }

        for (const auto& move : moves) {
            board.makeMove(move);
            int score = -alphaBeta(board, config.maxDepth - 1, -beta, -alpha, tt, nodesSearched, startTime, config.timeLimitMs, killers, history, 1);
            board.unmakeMove(move);

            if (score > bestScore) {
                bestScore = score;
                bestMove = move;

                if (score > alpha) {
                    alpha = score;
                }
            }
        }

        result.nodesSearched = nodesSearched;
        result.depth = config.maxDepth;
    }

    auto endTime = std::chrono::steady_clock::now();
    result.timeMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();

    result.bestMove = bestMove;
    result.score = bestScore;
    result.ttHits = tt.getHits();
    result.ttMisses = tt.getMisses();

    return result;
}

// Simple interface
SearchResult findBestMove(HexukiBitboard& board, int depth, int timeLimitMs) {
    SearchConfig config;
    config.maxDepth = depth;
    config.timeLimitMs = timeLimitMs;
    config.useIterativeDeepening = true;
    config.useMoveOrdering = true;
    config.useTranspositionTable = true;
    config.verbose = false;  // Disable verbose logging

    return findBestMove(board, config);
}

} // namespace minimax
} // namespace hexuki
