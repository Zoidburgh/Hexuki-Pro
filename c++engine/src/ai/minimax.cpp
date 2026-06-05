#include "ai/minimax.h"
#include "core/zobrist.h"
#include <algorithm>
#include <iostream>
#include <limits>

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
    TTSlot& slot = table[hash & mask];
    // Depth-preferred replacement: keep a deeper result that's already there from a
    // DIFFERENT position; otherwise (empty slot, shallower occupant, or same position)
    // overwrite. Any eviction is correct -- a missing entry is just recomputed.
    if (slot.entry.depth <= entry.depth || slot.key == hash) {
        slot.key = hash;
        slot.entry = entry;
    }
}

bool TranspositionTable::probe(uint64_t hash, TTEntry& entry) const {
    const TTSlot& slot = table[hash & mask];
    // Hit only if this slot actually holds THIS position (key match), not a collision.
    if (slot.key == hash && slot.entry.depth > 0) {
        entry = slot.entry;
        hits++;
        return true;
    }
    misses++;
    return false;
}

void TranspositionTable::clear() {
    std::fill(table.begin(), table.end(), TTSlot());
    hits = 0;
    misses = 0;
}

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
                              killers, history, ply + 1);
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

// ============================================================================
// Main Search Function
// ============================================================================

SearchResult findBestMove(HexukiBitboard& board, const SearchConfig& config) {
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
