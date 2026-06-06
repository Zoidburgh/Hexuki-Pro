#ifndef HEXUKI_MINIMAX_H
#define HEXUKI_MINIMAX_H

#include "core/bitboard.h"
#include "core/move.h"
#include <vector>
#include <cstdint>
#include <chrono>
#include <atomic>
#include <memory>

namespace hexuki {
namespace minimax {

/**
 * Transposition Table Entry
 * Stores previously evaluated positions to avoid recalculation
 */
struct TTEntry {
    enum Flag { EXACT, LOWER_BOUND, UPPER_BOUND };

    int score;          // Evaluation score
    int depth;          // Depth at which this was evaluated
    Flag flag;          // Type of bound
    Move bestMove;      // Best move found at this position

    TTEntry() : score(0), depth(0), flag(EXACT), bestMove() {}
    TTEntry(int s, int d, Flag f, const Move& m)
        : score(s), depth(d), flag(f), bestMove(m) {}
};

// One slot of the fixed-size transposition table, LOCKLESS (Hyatt XOR) so the table can be
// shared across Lazy-SMP threads safely. The entry is packed into a single 64-bit word; the
// key word holds hash ^ data. A probe reconstructs the hash as keyWord ^ dataWord -- if a
// concurrent write tore the (key, data) pair, that check fails and we treat it as a miss
// (recompute -> same value -> correct). Aligned 64-bit atomic loads/stores never tear on
// their own, so only the PAIR can be inconsistent, which the XOR catches. dataWord == 0 means
// empty (a real entry always has depth >= 1, so it's never all-zero).
// The TT slot differs by build, because a thread-safe (lockless) slot costs ~2x per node and
// ONLY the native multi-threaded build needs it. The single-threaded WASM/default build keeps
// the simple fast slot (no regression).
#ifdef HEXUKI_THREADS
// Native multi-threaded: lockless packed slot. The entry is packed into one 64-bit word and the
// key word holds hash ^ data. A probe reconstructs hash as keyWord ^ dataWord; a concurrent
// write that tears the (key,data) PAIR fails that check -> miss -> recompute -> correct. Aligned
// 64-bit loads/stores are atomic in hardware (x86-64/ARM64), so neither word tears on its own.
struct TTSlot {
    uint64_t keyWord;   // hash ^ dataWord
    uint64_t dataWord;  // packed TTEntry (0 = empty slot)
    TTSlot() : keyWord(0), dataWord(0) {}
};
#else
// Single-threaded (WASM / default): simple fast slot, no packing overhead. `key` is the full
// position hash; a collision (different position, same index) just probes as a miss.
struct TTSlot {
    uint64_t key;
    TTEntry entry;
    TTSlot() : key(0), entry() {}
};
#endif

/**
 * Transposition Table: fixed-size array, eviction-on-collision -> BOUNDED memory.
 * (The old unordered_map grew without limit and OOM'd on billion-node searches.)
 */
class TranspositionTable {
public:
    TranspositionTable(size_t sizeMB = 256);  // Default: 256MB table

    void store(uint64_t hash, const TTEntry& entry);
    bool probe(uint64_t hash, TTEntry& entry) const;
    void clear();

    size_t getSize() const { return tableSize; }
    size_t getHits() const { return 0; }    // stats disabled: shared counters would contend across threads
    size_t getMisses() const { return 0; }

private:
    std::unique_ptr<TTSlot[]> table;  // fixed power-of-two size; index = hash & mask
    size_t tableSize = 0;
    size_t mask = 0;
};

/**
 * Search statistics and result
 */
struct SearchResult {
    Move bestMove;          // Best move found
    int score;              // Evaluation score (positive = good for current player)
    long long nodesSearched;  // Total nodes evaluated (64-bit: billions on deep searches)
    double timeMs;          // Time taken in milliseconds
    int depth;              // Final depth reached
    bool timeout;           // Did search hit time limit?

    // Transposition table stats
    size_t ttHits;
    size_t ttMisses;

    SearchResult() : bestMove(), score(0), nodesSearched(0), timeMs(0.0),
                     depth(0), timeout(false), ttHits(0), ttMisses(0) {}
};

/**
 * Minimax search configuration
 */
struct SearchConfig {
    int maxDepth = 20;              // Maximum depth to search
    int timeLimitMs = 30000;        // Time limit (30 seconds default)
    bool useIterativeDeepening = true;  // Start shallow, go deeper
    bool useMoveOrdering = true;    // Order moves to improve pruning
    bool useTranspositionTable = true;  // Cache positions
    size_t ttSizeMB = 256;          // Transposition table size (fixed; eviction on collision)
    bool verbose = false;           // Print search info
    bool streamProgress = false;    // Emit a machine-readable "@PROGRESS" line per completed
                                    // ID depth (for the server's anytime search: progress +
                                    // cancel with NO re-search overhead). Off by default.
    int threads = 1;                // Lazy SMP worker count (native build only). 1 = the normal
                                    // single-threaded search. >1 shares the lockless TT across
                                    // threads. Ignored by the WASM build (no -DHEXUKI_THREADS).

    SearchConfig() = default;
};

/**
 * Main minimax search function with alpha-beta pruning
 *
 * @param board Current game state
 * @param config Search configuration
 * @return Search result with best move and statistics
 */
SearchResult findBestMove(HexukiBitboard& board, const SearchConfig& config = SearchConfig());

/**
 * Simple interface: just search to a specific depth
 */
SearchResult findBestMove(HexukiBitboard& board, int depth, int timeLimitMs = 30000);

/**
 * Killer Moves Heuristic
 * Tracks moves that recently caused beta cutoffs at each depth
 */
struct KillerMoves {
    static constexpr int MAX_DEPTH = 50;
    Move killer1[MAX_DEPTH];  // Primary killer move at each depth
    Move killer2[MAX_DEPTH];  // Secondary killer move at each depth

    KillerMoves() {
        for (int i = 0; i < MAX_DEPTH; i++) {
            killer1[i] = Move();
            killer2[i] = Move();
        }
    }

    void update(int ply, const Move& move) {
        if (ply < 0 || ply >= MAX_DEPTH) return;
        // If move is not already killer1, shift killers down
        if (!(move == killer1[ply])) {
            killer2[ply] = killer1[ply];
            killer1[ply] = move;
        }
    }

    bool isKiller(int ply, const Move& move) const {
        if (ply < 0 || ply >= MAX_DEPTH) return false;
        return (move == killer1[ply]) || (move == killer2[ply]);
    }
};

/**
 * History Heuristic
 * Tracks historically successful (hexId, tileValue) pairs
 */
struct HistoryTable {
    static constexpr int NUM_HEXES = 19;
    int scores[NUM_HEXES][10];  // scores[hexId][tileValue] - max tile value is 9

    HistoryTable() {
        for (int i = 0; i < NUM_HEXES; i++) {
            for (int j = 0; j < 10; j++) {
                scores[i][j] = 0;
            }
        }
    }

    void update(const Move& move, int depth) {
        if (move.hexId >= 0 && move.hexId < NUM_HEXES &&
            move.tileValue >= 0 && move.tileValue < 10) {
            scores[move.hexId][move.tileValue] += depth * depth;  // Deeper moves weighted more
        }
    }

    int getScore(const Move& move) const {
        if (move.hexId >= 0 && move.hexId < NUM_HEXES &&
            move.tileValue >= 0 && move.tileValue < 10) {
            return scores[move.hexId][move.tileValue];
        }
        return 0;
    }
};

/**
 * Alpha-beta search (internal, recursive)
 *
 * @param board Current position
 * @param depth Remaining depth to search
 * @param alpha Alpha value (best for maximizing player)
 * @param beta Beta value (best for minimizing player)
 * @param tt Transposition table
 * @param nodesSearched Counter for nodes visited
 * @param startTime Search start time
 * @param timeLimitMs Time limit
 * @param killers Killer move heuristic table
 * @param history History heuristic table
 * @param ply Current ply depth (for killer moves)
 * @return Evaluation score
 */
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
    std::atomic<bool>* stop = nullptr  // Lazy SMP: when set by another thread, bail out early
);

/**
 * Quiescence search (search until position is "quiet")
 * Helps avoid horizon effect in tactical positions
 */
int quiescence(
    HexukiBitboard& board,
    int alpha,
    int beta,
    TranspositionTable& tt,
    int& nodesSearched
);

/**
 * Move ordering: sort moves to search best ones first
 * Better move ordering = more alpha-beta cutoffs = faster search
 * Uses killer move and history heuristics for fast ordering
 */
void orderMoves(std::vector<Move>& moves, const TTEntry* ttEntry, const KillerMoves& killers, const HistoryTable& history, int ply);

/**
 * Simple evaluation function
 * Returns score from current player's perspective
 */
int evaluate(const HexukiBitboard& board);

} // namespace minimax
} // namespace hexuki

#endif // HEXUKI_MINIMAX_H
