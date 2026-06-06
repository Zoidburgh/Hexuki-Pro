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

using namespace hexuki;

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: hexuki-solve \"<position>\" [depth] [timeoutMs] [--stream]\n";
        return 1;
    }
    const std::string position = argv[1];
    bool stream = false;
    int depthArg = -1;
    long long timeoutMs = 2147483647LL; // ~no cap
    for (int i = 2; i < argc; i++) {
        if (std::strcmp(argv[i], "--stream") == 0) stream = true;
        else if (depthArg < 0) depthArg = std::atoi(argv[i]);
        else timeoutMs = std::atoll(argv[i]);
    }

    HexukiBitboard board;
    board.loadPosition(position);

    int empties = 0;
    for (int h = 0; h < NUM_HEXES; h++) if (!board.isHexOccupied(h)) empties++;
    const int depth = (depthArg > 0) ? depthArg : empties;

    minimax::SearchConfig config;
    config.maxDepth = depth;
    config.timeLimitMs = (int)std::min<long long>(timeoutMs, 2147483647LL);
    config.streamProgress = stream;

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
