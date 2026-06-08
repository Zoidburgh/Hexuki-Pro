// Native CLI entry for the Hexuki engine (server-side / batch solving).
// Same core engine as the WASM build — just a native main() instead of the embind interface.
//
//   hexuki-solve "<position>" [depth] [timeoutMs] [--stream]
//
// Prints one JSON result line (same shape as the WASM minimaxFindBestMove). With --stream it
// also emits "@PROGRESS <depth> <score> <hexId> <tileValue> <totalNodes> <elapsedMs>" per
// completed iterative-deepening depth (for the server's anytime search). depth defaults to the
// number of empty hexes (solve to game end); timeoutMs defaults to "no practical cap".

#include "core/bitboard.h"
#include "ai/minimax.h"
#include <iostream>
#include <string>
#include <cstring>
#include <cstdlib>
#include <algorithm>
#include <thread>

using namespace hexuki;

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: hexuki-solve \"<position>\" [depth] [timeoutMs] [--stream]\n";
        return 1;
    }
    const std::string position = argv[1];
    bool stream = false;
    int depthArg = -1;
    int threadsArg = -1;
    int hexesArg = 19;       // board size preset: 19 (full) or 7 (beginner inner hexagon)
    long long maskArg = -1;  // --active-mask <int>: arbitrary 19-bit blackout (overrides --hexes)
    long long timeoutMs = 2147483647LL; // ~no cap
    for (int i = 2; i < argc; i++) {
        if (std::strcmp(argv[i], "--stream") == 0) stream = true;
        else if (std::strcmp(argv[i], "--threads") == 0 && i + 1 < argc) threadsArg = std::atoi(argv[++i]);
        else if (std::strcmp(argv[i], "--hexes") == 0 && i + 1 < argc) hexesArg = std::atoi(argv[++i]);
        else if (std::strcmp(argv[i], "--active-mask") == 0 && i + 1 < argc) maskArg = std::atoll(argv[++i]);
        else if (depthArg < 0) depthArg = std::atoi(argv[i]);
        else timeoutMs = std::atoll(argv[i]);
    }

    // Blackout: restrict play to a subset of hexes (the rest stay empty -> drop out of scoring on their
    // own). --active-mask is the general form (any subset); --hexes 7 is the inner-hexagon preset. Must
    // be set before counting empties / solving. Full board otherwise.
    if (maskArg >= 0) setActiveHexMask((uint32_t)maskArg);
    else setActiveHexMask(hexesArg == 7 ? INNER7_MASK : FULL_HEX_MASK);
    const uint32_t active = getActiveHexMask();

    HexukiBitboard board;
    board.loadPosition(position);

    // Count empties among IN-PLAY hexes only -> the default depth solves to the (inner) game end.
    int empties = 0;
    for (int h = 0; h < NUM_HEXES; h++) if (((active >> h) & 1u) && !board.isHexOccupied(h)) empties++;
    const int depth = (depthArg > 0) ? depthArg : empties;

    minimax::SearchConfig config;
    config.maxDepth = depth;
    config.timeLimitMs = (int)std::min<long long>(timeoutMs, 2147483647LL);
    config.streamProgress = stream;
    // Root-split parallel workers: --threads N, else all hardware threads. (Note: streaming
    // progress is only emitted by the single-threaded iterative-deepening path; the root-split
    // path returns the final result without per-depth @PROGRESS.)
    // Auto (--threads 0) -> the P-core count on a hybrid CPU (workers get pinned to those cores in
    // the root-split, avoiding E-core stragglers at the per-depth barrier); explicit N is honored.
    config.threads = (threadsArg > 0) ? threadsArg : minimax::recommendedThreads();
    // Value-TT ON at every thread count: the shared TT now uses lockless XOR-checksum slots, so a
    // concurrent write can never make a probe return a corrupted value (a torn read fails the
    // checksum and is a miss). ~2-10x fewer nodes; verified == pure alpha-beta by difftest-threads.
    config.useValueTT = true;
    config.useAspiration = true;  // proven == oracle (difftest-aspiration); used by the single-thread
                                  // path now, and by the root-split once it honors it (below).
    // Transposition table size scales with depth: deep solves visit far more distinct positions, so
    // a 256MB table thrashes (evicting entries the value-TT needs -> lost pruning). Bigger keeps more
    // of the useful entries. HEXUKI_TT_MB overrides (for A/B + memory-constrained boxes).
    int ttMB = (empties >= 13) ? 4096 : (empties >= 12) ? 2048 : (empties >= 11) ? 1024 : 256;
    if (const char* envv = std::getenv("HEXUKI_TT_MB")) { int v = std::atoi(envv); if (v >= 16) ttMB = v; }
    config.ttSizeMB = (size_t)ttMB;

    auto r = minimax::findBestMove(board, config);

    std::cout << "{"
              << "\"hexId\":" << r.bestMove.hexId << ","
              << "\"tileValue\":" << r.bestMove.tileValue << ","
              << "\"score\":" << r.score << ","
              << "\"depth\":" << r.depth << ","
              << "\"empties\":" << empties << ","
              << "\"nodes\":" << r.nodesSearched << ","
              << "\"timeMs\":" << r.timeMs << ","
              << "\"timeout\":" << (r.timeout ? "true" : "false")
              << "}" << std::endl;
    return 0;
}
