/**
 * WebAssembly Interface for Hexuki C++ Engine
 *
 * This file provides C-style functions that can be called from JavaScript
 * Emscripten will compile these to WebAssembly and generate JS bindings
 */

#include "core/bitboard.h"
#include "core/zobrist.h"
#include "core/move.h"
#include "ai/mcts.h"
#include "ai/minimax.h"
#include <emscripten/emscripten.h>
#include <emscripten/bind.h>
#include <string>
#include <vector>

using namespace hexuki;
using namespace emscripten;

// ============================================================================
// Global State (one game instance for simplicity)
// ============================================================================

static HexukiBitboard* g_board = nullptr;
static mcts::MCTS* g_mcts = nullptr;
static bool g_initialized = false;
static Move g_lastMove(-1, 0);  // Track last move for unmake

// ============================================================================
// Initialization
// ============================================================================

EMSCRIPTEN_KEEPALIVE
extern "C" void wasmInitialize() {
    if (!g_initialized) {
        Zobrist::initialize();
        HexukiBitboard::ensureLegalTable();  // build the 2 MB legal-hex table once, up front
        g_board = new HexukiBitboard();
        g_mcts = new mcts::MCTS();
        g_initialized = true;
    }
}

EMSCRIPTEN_KEEPALIVE
extern "C" void wasmReset() {
    if (g_board) {
        g_board->reset();
    }
}

// ============================================================================
// Game State Management
// ============================================================================

EMSCRIPTEN_KEEPALIVE
extern "C" void wasmLoadPosition(const char* position) {
    if (g_board) {
        g_board->loadPosition(std::string(position));
    }
}

EMSCRIPTEN_KEEPALIVE
extern "C" const char* wasmSavePosition() {
    static std::string result;
    if (g_board) {
        result = g_board->savePosition();
        return result.c_str();
    }
    return "";
}

EMSCRIPTEN_KEEPALIVE
extern "C" int wasmGetCurrentPlayer() {
    return g_board ? g_board->getCurrentPlayer() : 1;
}

EMSCRIPTEN_KEEPALIVE
extern "C" int wasmGetScoreP1() {
    return g_board ? g_board->getScore(PLAYER_1) : 0;
}

EMSCRIPTEN_KEEPALIVE
extern "C" int wasmGetScoreP2() {
    return g_board ? g_board->getScore(PLAYER_2) : 0;
}

EMSCRIPTEN_KEEPALIVE
extern "C" bool wasmIsGameOver() {
    return g_board ? g_board->isGameOver() : false;
}

// Board-size mode: 7 = beginner inner hexagon, anything else = full 19-hex board. Global engine
// state -- set before generating moves / solving. The full board is byte-identical to before.
EMSCRIPTEN_KEEPALIVE
extern "C" void wasmSetBoardMode(int hexes) {
    setActiveHexMask(hexes == 7 ? INNER7_MASK : FULL_HEX_MASK);
}

EMSCRIPTEN_KEEPALIVE
extern "C" int wasmGetActiveHexMask() {
    return (int)getActiveHexMask();
}

// Arbitrary blackout: set the raw 19-bit active mask directly (bit h set = hex h is in play). This is
// the general form -- the editor can black out ANY subset of hexes. 0 resets to the full board.
EMSCRIPTEN_KEEPALIVE
extern "C" void wasmSetActiveHexes(int mask) {
    setActiveHexMask((uint32_t)mask);
}

EMSCRIPTEN_KEEPALIVE
extern "C" int wasmGetTileValue(int hexId) {
    return g_board ? g_board->getTileValue(hexId) : 0;
}

// ============================================================================
// Move Operations
// ============================================================================

EMSCRIPTEN_KEEPALIVE
extern "C" bool wasmMakeMove(int hexId, int tileValue) {
    if (!g_board) return false;

    Move move(hexId, tileValue);
    if (g_board->isValidMove(move)) {
        g_lastMove = move;  // Track for unmake
        g_board->makeMove(move);
        return true;
    }
    return false;
}

EMSCRIPTEN_KEEPALIVE
extern "C" void wasmUnmakeMove() {
    if (g_board && g_lastMove.hexId != -1) {
        g_board->unmakeMove(g_lastMove);
        g_lastMove = Move(-1, 0);  // Reset
    }
}

EMSCRIPTEN_KEEPALIVE
extern "C" int wasmGetValidMovesCount() {
    if (!g_board) return 0;
    return g_board->getValidMoves().size();
}

// Returns valid moves as a JSON string: "[{h:6,t:5},{h:7,t:4},...]"
EMSCRIPTEN_KEEPALIVE
extern "C" const char* wasmGetValidMoves() {
    static std::string result;
    if (!g_board) {
        result = "[]";
        return result.c_str();
    }

    auto moves = g_board->getValidMoves();
    result = "[";
    for (size_t i = 0; i < moves.size(); i++) {
        result += "{\"h\":" + std::to_string(moves[i].hexId) +
                  ",\"t\":" + std::to_string(moves[i].tileValue) + "}";
        if (i < moves.size() - 1) result += ",";
    }
    result += "]";
    return result.c_str();
}

// ============================================================================
// MCTS AI
// ============================================================================

// Returns best move as JSON: {hexId:6, tileValue:5, visits:1234, winRate:0.6, simulations:10000, timeMs:500}
EMSCRIPTEN_KEEPALIVE
extern "C" const char* wasmMCTSFindBestMove(int simulations, int timeLimitMs, bool useTimeLimit, bool useMinimaxRollouts, int minimaxThreshold) {
    static std::string result;

    if (!g_board || !g_mcts) {
        result = "{\"error\":\"Not initialized\"}";
        return result.c_str();
    }

    mcts::MCTSConfig config;
    config.numSimulations = simulations;
    config.timeLimitMs = timeLimitMs;
    config.useTimeLimit = useTimeLimit;
    config.verbose = false;
    config.useMinimaxRollouts = useMinimaxRollouts;
    config.minimaxThreshold = minimaxThreshold;

    auto searchResult = g_mcts->findBestMove(*g_board, config);

    // Build JSON response with topMoves
    result = "{";
    result += "\"hexId\":" + std::to_string(searchResult.bestMove.hexId) + ",";
    result += "\"tileValue\":" + std::to_string(searchResult.bestMove.tileValue) + ",";
    result += "\"visits\":" + std::to_string(searchResult.visits) + ",";
    result += "\"winRate\":" + std::to_string(searchResult.winRate) + ",";
    result += "\"simulations\":" + std::to_string(searchResult.simulations) + ",";
    result += "\"timeMs\":" + std::to_string(searchResult.timeMs) + ",";

    // Add topMoves array
    result += "\"topMoves\":[";
    for (size_t i = 0; i < searchResult.topMoves.size(); i++) {
        result += "{";
        result += "\"hexId\":" + std::to_string(searchResult.topMoves[i].move.hexId) + ",";
        result += "\"tileValue\":" + std::to_string(searchResult.topMoves[i].move.tileValue) + ",";
        result += "\"visits\":" + std::to_string(searchResult.topMoves[i].visits) + ",";
        result += "\"winRate\":" + std::to_string(searchResult.topMoves[i].winRate);
        result += "}";
        if (i < searchResult.topMoves.size() - 1) result += ",";
    }
    result += "]}";

    return result.c_str();
}

// ============================================================================
// Minimax AI
// ============================================================================

// Returns best move as JSON: {hexId:6, tileValue:5, score:100, depth:8, nodes:50000, timeMs:200}
EMSCRIPTEN_KEEPALIVE
extern "C" const char* wasmMinimaxFindBestMove(int depth, int timeLimitMs) {
    static std::string result;

    if (!g_board) {
        result = "{\"error\":\"Not initialized\"}";
        return result.c_str();
    }

    // Value-TT ON: WASM is single-threaded, so the value-returning TT is the proven-correct,
    // ~2-10x-fewer-nodes path (verified == pure alpha-beta in bench/difftest-valuett.cjs).
    minimax::SearchConfig config;
    config.maxDepth = depth;
    config.timeLimitMs = timeLimitMs;
    config.useValueTT = true;
    config.useAspiration = true;   // proven == pure alpha-beta (difftest-aspiration), ~26% fewer nodes
    auto searchResult = minimax::findBestMove(*g_board, config);

    // Build JSON response
    result = "{";
    result += "\"hexId\":" + std::to_string(searchResult.bestMove.hexId) + ",";
    result += "\"tileValue\":" + std::to_string(searchResult.bestMove.tileValue) + ",";
    result += "\"score\":" + std::to_string(searchResult.score) + ",";
    result += "\"depth\":" + std::to_string(searchResult.depth) + ",";
    result += "\"nodes\":" + std::to_string(searchResult.nodesSearched) + ",";
    result += "\"timeMs\":" + std::to_string(searchResult.timeMs) + ",";
    // Did the search hit its time limit? If true, the result is the last COMPLETED
    // (shallower) iteration -- NOT a solve to game end. Callers must not present a
    // timed-out result as perfect play.
    result += "\"timeout\":" + std::string(searchResult.timeout ? "true" : "false");
    result += "}";

    return result.c_str();
}

// Streaming variant: same result, but emits a "@PROGRESS ..." line per completed ID depth
// (one internal iterative-deepening search -> the server gets live progress + cancel with NO
// re-search overhead). The progress lines go to stdout; the loader captures them via Module.print.
extern "C" const char* wasmMinimaxFindBestMoveStream(int depth, int timeLimitMs) {
    static std::string result;
    if (!g_board) {
        result = "{\"error\":\"Not initialized\"}";
        return result.c_str();
    }

    minimax::SearchConfig config;
    config.maxDepth = depth;
    config.timeLimitMs = timeLimitMs;
    config.streamProgress = true;
    config.useValueTT = true;     // single-threaded WASM -> proven-correct value-TT (fewer nodes)
    config.useAspiration = true;  // + aspiration windows (proven == oracle, ~26% fewer nodes)

    auto searchResult = minimax::findBestMove(*g_board, config);

    result = "{";
    result += "\"hexId\":" + std::to_string(searchResult.bestMove.hexId) + ",";
    result += "\"tileValue\":" + std::to_string(searchResult.bestMove.tileValue) + ",";
    result += "\"score\":" + std::to_string(searchResult.score) + ",";
    result += "\"depth\":" + std::to_string(searchResult.depth) + ",";
    result += "\"nodes\":" + std::to_string(searchResult.nodesSearched) + ",";
    result += "\"timeMs\":" + std::to_string(searchResult.timeMs) + ",";
    result += "\"timeout\":" + std::string(searchResult.timeout ? "true" : "false");
    result += "}";
    return result.c_str();
}

// Differential-test entry: configurable search. useValueTT: 1=value-TT, 3=value-TT+hash-verify.
// useID is a BITMASK: bit0 = iterative deepening, bit1 = aspiration windows. So useID=1 -> ID only,
// useID=3 -> ID + aspiration, useID=0 -> single full-depth pass.
extern "C" const char* wasmMinimaxFindBestMoveCfg(int depth, int timeLimitMs, int useValueTT, int useID) {
    static std::string result;
    if (!g_board) { result = "{\"error\":\"Not initialized\"}"; return result.c_str(); }
    minimax::SearchConfig config;
    config.maxDepth = depth;
    config.timeLimitMs = timeLimitMs;
    config.useValueTT = (useValueTT != 0);
    config.verifyExact = (useValueTT == 3);    // 3 => also assert incremental hash == full recompute
    config.verifyReturns = (useValueTT == 4);  // 4 => brute-force-check every value-TT return (@BADRET)
    config.useIterativeDeepening = (useID & 1) != 0;
    config.useAspiration = (useID & 2) != 0;
    config.orderStats = true;                // collect move-ordering quality stats (single-thread)
    auto searchResult = minimax::findBestMove(*g_board, config);
    result = "{";
    result += "\"hexId\":" + std::to_string(searchResult.bestMove.hexId) + ",";
    result += "\"tileValue\":" + std::to_string(searchResult.bestMove.tileValue) + ",";
    result += "\"score\":" + std::to_string(searchResult.score) + ",";
    result += "\"depth\":" + std::to_string(searchResult.depth) + ",";
    result += "\"nodes\":" + std::to_string(searchResult.nodesSearched) + ",";
    result += "\"cutFirst\":" + std::to_string(minimax::getOrderCutFirst()) + ",";
    result += "\"cutTotal\":" + std::to_string(minimax::getOrderCutTotal());
    result += "}";
    return result.c_str();
}

// Ground-truth oracle: solve with the transposition table DISABLED (pure alpha-beta).
// Used only by differential testing to find positions where the TT-enabled search is wrong.
extern "C" const char* wasmMinimaxFindBestMoveNoTT(int depth, int timeLimitMs) {
    static std::string result;
    if (!g_board) { result = "{\"error\":\"Not initialized\"}"; return result.c_str(); }
    minimax::SearchConfig config;
    config.maxDepth = depth;
    config.timeLimitMs = timeLimitMs;
    config.useTranspositionTable = false;   // pure alpha-beta -> cannot have a TT bug
    auto searchResult = minimax::findBestMove(*g_board, config);
    result = "{";
    result += "\"hexId\":" + std::to_string(searchResult.bestMove.hexId) + ",";
    result += "\"tileValue\":" + std::to_string(searchResult.bestMove.tileValue) + ",";
    result += "\"score\":" + std::to_string(searchResult.score) + ",";
    result += "\"depth\":" + std::to_string(searchResult.depth) + ",";
    result += "\"nodes\":" + std::to_string(searchResult.nodesSearched);
    result += "}";
    return result.c_str();
}

// ============================================================================
// Cleanup
// ============================================================================

EMSCRIPTEN_KEEPALIVE
extern "C" void wasmCleanup() {
    delete g_board;
    delete g_mcts;
    g_board = nullptr;
    g_mcts = nullptr;
    g_initialized = false;
}

// ============================================================================
// Wrapper functions using std::string (no raw pointers needed)
// ============================================================================

void wasmLoadPositionStr(std::string position) {
    wasmLoadPosition(position.c_str());
}

std::string wasmSavePositionStr() {
    return std::string(wasmSavePosition());
}

std::string wasmGetValidMovesStr() {
    return std::string(wasmGetValidMoves());
}

std::string wasmMCTSFindBestMoveStr(int simulations, int timeLimitMs, bool useTimeLimit, bool useMinimaxRollouts, int minimaxThreshold) {
    return std::string(wasmMCTSFindBestMove(simulations, timeLimitMs, useTimeLimit, useMinimaxRollouts, minimaxThreshold));
}

std::string wasmMinimaxFindBestMoveStr(int depth, int timeLimitMs) {
    return std::string(wasmMinimaxFindBestMove(depth, timeLimitMs));
}

std::string wasmMinimaxFindBestMoveStreamStr(int depth, int timeLimitMs) {
    return std::string(wasmMinimaxFindBestMoveStream(depth, timeLimitMs));
}

std::string wasmMinimaxFindBestMoveNoTTStr(int depth, int timeLimitMs) {
    return std::string(wasmMinimaxFindBestMoveNoTT(depth, timeLimitMs));
}

std::string wasmMinimaxFindBestMoveCfgStr(int depth, int timeLimitMs, int useValueTT, int useID) {
    return std::string(wasmMinimaxFindBestMoveCfg(depth, timeLimitMs, useValueTT, useID));
}

// ============================================================================
// Emscripten Bindings (using std::string - no raw pointers)
// ============================================================================

EMSCRIPTEN_BINDINGS(hexuki_module) {
    function("initialize", &wasmInitialize);
    function("reset", &wasmReset);
    function("loadPosition", &wasmLoadPositionStr);
    function("savePosition", &wasmSavePositionStr);
    function("getCurrentPlayer", &wasmGetCurrentPlayer);
    function("getScoreP1", &wasmGetScoreP1);
    function("getScoreP2", &wasmGetScoreP2);
    function("isGameOver", &wasmIsGameOver);
    function("setBoardMode", &wasmSetBoardMode);
    function("getActiveHexMask", &wasmGetActiveHexMask);
    function("setActiveHexes", &wasmSetActiveHexes);
    function("getTileValue", &wasmGetTileValue);
    function("makeMove", &wasmMakeMove);
    function("unmakeMove", &wasmUnmakeMove);
    function("getValidMovesCount", &wasmGetValidMovesCount);
    function("getValidMoves", &wasmGetValidMovesStr);
    function("mctsFindBestMove", &wasmMCTSFindBestMoveStr);
    function("minimaxFindBestMove", &wasmMinimaxFindBestMoveStr);
    function("minimaxFindBestMoveStream", &wasmMinimaxFindBestMoveStreamStr);
    function("minimaxFindBestMoveNoTT", &wasmMinimaxFindBestMoveNoTTStr);
    function("minimaxFindBestMoveCfg", &wasmMinimaxFindBestMoveCfgStr);
    function("cleanup", &wasmCleanup);
}
