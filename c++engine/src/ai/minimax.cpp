#include "ai/minimax.h"
#include "core/zobrist.h"
#include <algorithm>
#include <iostream>
#include <limits>
#ifdef HEXUKI_THREADS
#include <thread>
#include <vector>
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

TranspositionTable::TranspositionTable(size_t sizeMB) {
    // Largest power-of-two slot count that fits in sizeMB.
    size_t want = (sizeMB * 1024 * 1024) / sizeof(TTSlot);
    size_t n = 1024;
    while ((n << 1) <= want) n <<= 1;
    table = std::make_unique<TTSlot[]>(n);  // all slots default to 0 (empty)
    tableSize = n;
    mask = n - 1;
}

#ifdef HEXUKI_THREADS
// ---- Lockless packed TT (native multi-threaded): pack TTEntry into one 64-bit word ----
//  bits  [0..23]  score + TT_SCORE_OFFSET  (24 bits; score is within [-INF, INF] = +/-1e6)
//  bits [24..29]  depth                    (6 bits; 0 = empty)
//  bits [30..31]  flag                     (2 bits)
//  bits [32..36]  hexId + 1                (5 bits; default move hexId -1 -> 0)
//  bits [37..40]  tileValue                (4 bits)
namespace {
    constexpr int64_t TT_SCORE_OFFSET = 1 << 23;  // 8,388,608 > |score|, so score+OFFSET >= 0
    inline uint64_t packTT(const TTEntry& e) {
        return ((uint64_t)(int64_t)(e.score + TT_SCORE_OFFSET) & 0xFFFFFFull)
             | ((uint64_t)(e.depth & 0x3F) << 24)
             | ((uint64_t)((int)e.flag & 0x3) << 30)
             | ((uint64_t)((e.bestMove.hexId + 1) & 0x1F) << 32)
             | ((uint64_t)(e.bestMove.tileValue & 0xF) << 37);
    }
    inline void unpackTT(uint64_t w, TTEntry& e) {
        e.score = (int)((int64_t)(w & 0xFFFFFFull) - TT_SCORE_OFFSET);
        e.depth = (int)((w >> 24) & 0x3F);
        e.flag  = (TTEntry::Flag)((w >> 30) & 0x3);
        e.bestMove.hexId = (int)((w >> 32) & 0x1F) - 1;
        e.bestMove.tileValue = (int)((w >> 37) & 0xF);
    }
    inline int unpackTTDepth(uint64_t w) { return (int)((w >> 24) & 0x3F); }
}

void TranspositionTable::store(uint64_t hash, const TTEntry& entry) {
    TTSlot& slot = table[hash & mask];
    const uint64_t curData = slot.dataWord;   // racy read OK: only the replacement DECISION uses it
    const uint64_t curKey  = slot.keyWord;
    const bool empty   = (curData == 0 && curKey == 0);
    const bool samePos = ((curKey ^ curData) == hash);
    if (empty || samePos || unpackTTDepth(curData) <= entry.depth) {  // depth-preferred replacement
        const uint64_t data = packTT(entry);
        slot.dataWord = data;
        slot.keyWord  = hash ^ data;   // key ^ data == hash iff a reader sees this consistent pair
    }
}

bool TranspositionTable::probe(uint64_t hash, TTEntry& entry) const {
    const TTSlot& slot = table[hash & mask];
    const uint64_t key  = slot.keyWord;
    const uint64_t data = slot.dataWord;
    if ((key ^ data) == hash && unpackTTDepth(data) > 0) {  // consistent pair + real entry
        unpackTT(data, entry);
        return true;
    }
    return false;
}

void TranspositionTable::clear() {
    for (size_t i = 0; i < tableSize; i++) { table[i].keyWord = 0; table[i].dataWord = 0; }
}

#else  // single-threaded (WASM / default): simple fast slot, no packing

void TranspositionTable::store(uint64_t hash, const TTEntry& entry) {
    TTSlot& slot = table[hash & mask];
    // Depth-preferred replacement: keep a deeper result from a different position; otherwise
    // (empty, shallower, or same position) overwrite. Any eviction is correct (recompute).
    if (slot.entry.depth <= entry.depth || slot.key == hash) {
        slot.key = hash;
        slot.entry = entry;
    }
}

bool TranspositionTable::probe(uint64_t hash, TTEntry& entry) const {
    const TTSlot& slot = table[hash & mask];
    if (slot.key == hash && slot.entry.depth > 0) {  // this exact position, real entry
        entry = slot.entry;
        return true;
    }
    return false;
}

void TranspositionTable::clear() {
    for (size_t i = 0; i < tableSize; i++) { table[i].key = 0; table[i].entry = TTEntry(); }
}

#endif // HEXUKI_THREADS

// ============================================================================
// Evaluation Function
// ============================================================================

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
    int ply,
    std::atomic<bool>* stop
) {
    nodesSearched++;

    // Check timeout / Lazy-SMP stop periodically
    if (nodesSearched % TIMEOUT_CHECK_INTERVAL == 0) {
        if (stop && stop->load(std::memory_order_relaxed)) {
            return 0;  // another Lazy-SMP thread finished -> abandon this (discarded) search
        }
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
    const int alphaOrig = alpha;  // window we were given -- flag the stored entry against THIS

    // Transposition table lookup (textbook pattern). Narrow the window from a stored
    // bound for cutoffs, but the entry's flag below is computed from alphaOrig, not the
    // mutated alpha -- that mutated-flag was the order-dependence bug (off-by-one).
    TTEntry ttEntry;
    bool ttHit = false;  // an entry exists at all -> its bestMove is safe for ordering

    if (tt.probe(hash, ttEntry)) {
        ttHit = true;
        if (ttEntry.depth >= depth) {
            if (ttEntry.flag == TTEntry::EXACT) {
                return ttEntry.score;
            } else if (ttEntry.flag == TTEntry::LOWER_BOUND) {
                alpha = std::max(alpha, ttEntry.score);
            } else if (ttEntry.flag == TTEntry::UPPER_BOUND) {
                beta = std::min(beta, ttEntry.score);
            }
            if (alpha >= beta) {
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
    for (const auto& move : moves) {
        board.makeMove(move);
        int score = -alphaBeta(board, depth - 1, -beta, -alpha, tt, nodesSearched, startTime, timeLimitMs,
                              killers, history, ply + 1, stop);
        board.unmakeMove(move);

        if (score > bestScore) {
            bestScore = score;
            bestMove = move;
            if (score > alpha) alpha = score;  // raise the search window
        }

        // Beta cutoff
        if (alpha >= beta) {
            killers.update(ply, bestMove);  // Store killer move
            history.update(bestMove, depth);  // Update history
            break;
        }
    }

    // Flag the stored entry against the ORIGINAL window (not the mutated alpha):
    //   bestScore <= alphaOrig -> never beat alpha   -> UPPER_BOUND
    //   bestScore >= beta      -> caused a cutoff     -> LOWER_BOUND
    //   otherwise              -> exact within window -> EXACT
    TTEntry::Flag flag = (bestScore <= alphaOrig) ? TTEntry::UPPER_BOUND
                       : (bestScore >= beta)      ? TTEntry::LOWER_BOUND
                       : TTEntry::EXACT;

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
// ============================================================================
// Lazy SMP (native multi-threaded search)
// ============================================================================
// N threads each run iterative deepening on their OWN copy of the board, sharing the lockless
// transposition table. Thread 0 is authoritative (runs to completion, emits @PROGRESS); helper
// threads start from a rotated root-move order so they seed different subtrees into the shared
// TT, then bail the moment thread 0 finishes. The exact value is unchanged -- only wall time
// drops. Node counts vary run-to-run (thread timing); that's expected for parallel search.
static SearchResult lazyWorker(HexukiBitboard board, const SearchConfig& config,
                               TranspositionTable& tt, std::atomic<bool>& stop,
                               int threadId, bool isMain,
                               std::chrono::steady_clock::time_point startTime) {
    SearchResult result;
    std::vector<Move> moves = board.getValidMoves();
    if (moves.empty()) { result.score = evaluate(board); return result; }

    KillerMoves killers;
    HistoryTable history;
    Move bestMove = moves[0];
    int bestScore = -INF;

    if (threadId > 0 && moves.size() > 1) {
        std::rotate(moves.begin(), moves.begin() + (threadId % (int)moves.size()), moves.end());
    }

    for (int depth = 1; depth <= config.maxDepth; depth++) {
        if (!isMain && stop.load(std::memory_order_relaxed)) break;

        long long nodes = 0;
        int alpha = -INF, beta = INF;
        Move curBest = moves[0];
        int curScore = -INF;
        if (depth > 1) orderMoves(moves, nullptr, killers, history, 0);

        for (const auto& move : moves) {
            if (!isMain && stop.load(std::memory_order_relaxed)) break;
            board.makeMove(move);
            int score = -alphaBeta(board, depth - 1, -beta, -alpha, tt, nodes, startTime,
                                   config.timeLimitMs, killers, history, 1, &stop);
            board.unmakeMove(move);
            if (score > curScore) { curScore = score; curBest = move; if (score > alpha) alpha = score; }
        }

        if (!isMain && stop.load(std::memory_order_relaxed)) break; // stopped mid-depth -> discard it

        bestMove = curBest;
        bestScore = curScore;
        result.depth = depth;
        result.nodesSearched += nodes;

        if (isMain && config.streamProgress) {
            long long elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - startTime).count();
            std::cout << "@PROGRESS " << depth << " " << bestScore << " "
                      << bestMove.hexId << " " << bestMove.tileValue << " "
                      << result.nodesSearched << " " << elapsed << std::endl;
        }
        if (std::abs(bestScore) > MATE_SCORE - 100) break;
    }

    result.bestMove = bestMove;
    result.score = bestScore;
    return result;
}

static SearchResult findBestMoveLazySMP(HexukiBitboard& board, const SearchConfig& config) {
    auto startTime = std::chrono::steady_clock::now();
    // Build the global legal-move table NOW, single-threaded, before any worker touches it --
    // otherwise N threads race to build the same global on first getValidMoves(). After this it
    // is read-only, so concurrent reads are safe.
    HexukiBitboard::ensureLegalTable();

    TranspositionTable tt(config.ttSizeMB);     // shared across all threads
    std::atomic<bool> stop{false};
    const int N = std::max(1, config.threads);

    std::vector<std::thread> helpers;
    helpers.reserve(N - 1);
    for (int t = 1; t < N; t++) {
        helpers.emplace_back([&board, &config, &tt, &stop, t, startTime]() {
            lazyWorker(board, config, tt, stop, t, /*isMain=*/false, startTime);
        });
    }

    SearchResult result = lazyWorker(board, config, tt, stop, 0, /*isMain=*/true, startTime);

    stop.store(true, std::memory_order_relaxed);  // tell helpers to stop
    for (auto& h : helpers) h.join();

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
    if (config.threads > 1) return findBestMoveLazySMP(board, config);
#endif
    SearchResult result;

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
            int alpha = -INF;
            int beta = INF;

            Move currentBestMove;
            int currentBestScore = -INF;

            // Order moves based on previous iteration's best
            if (depth > 1) {
                orderMoves(moves, nullptr, killers, history, 0);
            }

            // Search all moves at current depth
            bool depthTimedOut = false;
            long long elapsed = 0;
            for (const auto& move : moves) {
                board.makeMove(move);
                int score = -alphaBeta(board, depth - 1, -beta, -alpha, tt, nodesSearched, startTime, config.timeLimitMs, killers, history, 1);
                board.unmakeMove(move);

                // Check if we timed out during this search
                auto now = std::chrono::steady_clock::now();
                elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - startTime).count();
                if (elapsed >= config.timeLimitMs) {
                    depthTimedOut = true;
                    break;
                }

                if (score > currentBestScore) {
                    currentBestScore = score;
                    currentBestMove = move;

                    if (score > alpha) {
                        alpha = score;
                    }
                }
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
