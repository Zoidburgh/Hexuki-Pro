#include "core/bitboard.h"
#include "core/zobrist.h"
#include "utils/timer.h"
#include <iostream>
#include <sstream>
#include <algorithm>
#include <cstring>
#include <set>

#ifdef _MSC_VER
#include <intrin.h>
#endif

namespace hexuki {

// ============================================================================
// Helper Functions
// ============================================================================

// Check if two tile vectors are identical (same values in any order)
static bool tilesMatch(std::vector<int> tiles1, std::vector<int> tiles2) {
    if (tiles1.size() != tiles2.size()) return false;
    std::sort(tiles1.begin(), tiles1.end());
    std::sort(tiles2.begin(), tiles2.end());
    return tiles1 == tiles2;
}

// Precomputed legal-hex table: occupancy(19 bits) -> 19-bit mask of legal hex
// locations. 2^19 entries x 4 bytes = 2 MB, zero-init (does not bloat the binary).
static uint32_t g_legalHexMask[1u << NUM_HEXES];
static bool g_legalTableBuilt = false;

// ============================================================================
// Constructor & Reset
// ============================================================================

HexukiBitboard::HexukiBitboard()
    : hexOccupied(0)
    , hexValues{}
    , p1AvailableTiles(ALL_TILES_MASK)  // All tiles 1-NUM_TILE_VALUES available
    , p2AvailableTiles(ALL_TILES_MASK)
    , currentPlayer(PLAYER_1)
    , symmetryStillPossible(true)
    , tilesAreIdentical(true)
    , zobristHash(0)
{
    reset();
}

void HexukiBitboard::reset() {
    // Clear board
    hexOccupied = 0;
    std::memset(hexValues, 0, sizeof(hexValues));

    // Reset available tiles (all tiles 1-9 available)
    // Array-based: supports standard [1,2,3,4,5,6,7,8,9] and asymmetric sets
    p1AvailableTiles = {1, 2, 3, 4, 5, 6, 7, 8, 9};
    p2AvailableTiles = {1, 2, 3, 4, 5, 6, 7, 8, 9};

    // Initial state: center hex (9) has tile value 1
    hexOccupied = (1u << CENTER_HEX);
    hexValues[CENTER_HEX] = STARTING_TILE;

    currentPlayer = PLAYER_1;
    symmetryStillPossible = true;
    tilesAreIdentical = tilesMatch(p1AvailableTiles, p2AvailableTiles);

    zobristHash = Zobrist::hash(*this);
}

// ============================================================================
// State Queries
// ============================================================================

// isHexOccupied() and getTileValue() are now inlined in bitboard.h for performance

bool HexukiBitboard::isGameOver() const {
    // Game ends when all 19 hexes are filled
    // Can't use moveCount >= 18 because puzzles might have empty center hex (allowing 19 moves)
    int occupiedCount = 0;
    for (int i = 0; i < NUM_HEXES; i++) {
        if (isHexOccupied(i)) occupiedCount++;
    }
    return occupiedCount >= NUM_HEXES;
}

bool HexukiBitboard::isTileAvailable(int player, int tileValue) const {
    if (tileValue < 1 || tileValue > MAX_TILE_VALUE) return false;
    const std::vector<int>& tiles = (player == PLAYER_1) ? p1AvailableTiles : p2AvailableTiles;
    // Use std::find to check if tile value exists in array (supports duplicates)
    return std::find(tiles.begin(), tiles.end(), tileValue) != tiles.end();
}

std::vector<int> HexukiBitboard::getAvailableTiles(int player) const {
    // Simply return the tile array (already supports duplicates)
    return (player == PLAYER_1) ? p1AvailableTiles : p2AvailableTiles;
}

// ============================================================================
// Adjacency (REAL hex grid adjacency)
// ============================================================================

int HexukiBitboard::findHexAt(int row, int col) const {
    // PERFORMANCE OPTIMIZATION: O(1) lookup instead of O(19) linear search
    // This function is called 100-500 MILLION times during depth-10 minimax!
    // Before: 19 comparisons per call = billions of operations
    // After: 1 array lookup = millions of operations (5-10x speedup)

    // Bounds check (safety)
    if (row < 0 || row >= 9 || col < 0 || col >= 5) {
        return -1;
    }

    // Direct O(1) lookup from pre-computed table
    return ROW_COL_TO_HEX[row][col];  // Returns -1 if no hex at this position
}

std::vector<int> HexukiBitboard::getAdjacentHexes(int hexId) const {
    std::vector<int> adjacent;
    if (hexId < 0 || hexId >= NUM_HEXES) return adjacent;

    const HexPosition& hex = HEX_POSITIONS[hexId];

    // Check all 6 hex directions
    for (int i = 0; i < 6; i++) {
        int newRow = hex.row + HEX_DIRECTIONS[i].dr;
        int newCol = hex.col + HEX_DIRECTIONS[i].dc;

        int adjId = findHexAt(newRow, newCol);
        if (adjId >= 0) {
            adjacent.push_back(adjId);
        }
    }

    return adjacent;
}

bool HexukiBitboard::hasAdjacentOccupied(int hexId) const {
    // PERFORMANCE: Use pre-computed lookup table (no heap allocation!)
    if (hexId < 0 || hexId >= NUM_HEXES) return false;

    const AdjacentList& adj = ADJACENT_HEXES[hexId];
    for (int i = 0; i < adj.count; i++) {
        if (isHexOccupied(adj.hexes[i])) {
            return true;
        }
    }
    return false;
}

// ============================================================================
// Chain Length Constraint (REAL algorithm from JavaScript)
// ============================================================================

std::vector<int> HexukiBitboard::getChainLengthsFromStart(int startHex, const Direction& dir) const {
    std::vector<int> lengths;
    int currentLength = 0;
    int currentHex = startHex;

    while (currentHex >= 0) {
        if (isHexOccupied(currentHex)) {
            currentLength++;
        } else if (currentLength > 0) {
            // Hit empty cell, record current chain and reset
            lengths.push_back(currentLength);
            currentLength = 0;
        }

        // Move to next cell in direction
        const HexPosition& pos = HEX_POSITIONS[currentHex];
        int newRow = pos.row + dir.dr;
        int newCol = pos.col + dir.dc;
        currentHex = findHexAt(newRow, newCol);
    }

    // Record final chain if we ended on occupied cells
    if (currentLength > 0) {
        lengths.push_back(currentLength);
    }

    return lengths;
}

std::vector<int> HexukiBitboard::getAllChainLengths() const {
    std::vector<int> chainLengths;

    // Check all chain starters
    for (int i = 0; i < 15; i++) {
        const ChainStarter& starter = CHAIN_STARTERS[i];
        auto lengths = getChainLengthsFromStart(starter.startHex, starter.dir);
        chainLengths.insert(chainLengths.end(), lengths.begin(), lengths.end());
    }

    return chainLengths;
}

std::vector<HexukiBitboard::ChainInfo> HexukiBitboard::getAllChainsWithMembers() const {
    std::vector<ChainInfo> chains;

    // Check all chain starters
    for (int i = 0; i < 15; i++) {
        const ChainStarter& starter = CHAIN_STARTERS[i];
        std::vector<int> currentChain;
        int currentHex = starter.startHex;

        while (currentHex >= 0) {
            if (isHexOccupied(currentHex)) {
                currentChain.push_back(currentHex);
            } else if (!currentChain.empty()) {
                // Hit empty cell, record current chain and reset
                ChainInfo info;
                info.length = currentChain.size();
                info.hexIds = currentChain;
                chains.push_back(info);
                currentChain.clear();
            }

            // Move to next cell in direction
            const HexPosition& pos = HEX_POSITIONS[currentHex];
            int newRow = pos.row + starter.dir.dr;
            int newCol = pos.col + starter.dir.dc;
            currentHex = findHexAt(newRow, newCol);
        }

        // Record final chain if we ended on occupied cells
        if (!currentChain.empty()) {
            ChainInfo info;
            info.length = currentChain.size();
            info.hexIds = currentChain;
            chains.push_back(info);
        }
    }

    // Find isolated tiles (occupied hexes not part of any detected chain)
    std::set<int> hexesInChains;
    for (const auto& chain : chains) {
        for (int hexId : chain.hexIds) {
            hexesInChains.insert(hexId);
        }
    }

    // Add isolated tiles as 1-chains
    for (int hexId = 0; hexId < NUM_HEXES; hexId++) {
        if (isHexOccupied(hexId) && hexesInChains.find(hexId) == hexesInChains.end()) {
            ChainInfo info;
            info.length = 1;
            info.hexIds = {hexId};
            chains.push_back(info);
        }
    }

    return chains;
}

void HexukiBitboard::getFirstAndSecondChainLengths(int& first, int& second) const {
    auto allLengths = getAllChainLengths();
    first = 0;
    second = 0;

    for (int length : allLengths) {
        if (length > first) {
            second = first;
            first = length;
        } else if (length > second) {
            second = length;
        }
    }
}

bool HexukiBitboard::checkChainLengthConstraint(int hexId) const {
    // OPTIMIZATION: Walk chains directly instead of calling getAllChainsWithMembers()
    // This eliminates 324 million vector allocations during depth-10 search

    // Save original state
    uint8_t savedValue = hexValues[hexId];
    uint32_t savedOccupied = hexOccupied;

    // Temporarily place tile
    const_cast<HexukiBitboard*>(this)->hexOccupied |= (1u << hexId);
    const_cast<HexukiBitboard*>(this)->hexValues[hexId] = 1;

    // Walk all 15 chain directions, tracking lengths inline
    int maxLength = 0;
    int secondMaxLength = 0;
    int longestAffected = 0;  // Longest chain containing hexId

    for (int i = 0; i < 15; i++) {
        const ChainStarter& starter = CHAIN_STARTERS[i];
        int currentLength = 0;
        int currentHex = starter.startHex;
        bool chainContainsHexId = false;

        // Walk this chain direction
        while (currentHex >= 0) {
            if (isHexOccupied(currentHex)) {
                currentLength++;
                if (currentHex == hexId) {
                    chainContainsHexId = true;
                }
            } else if (currentLength > 0) {
                // Chain ended - update max/secondMax
                if (currentLength > maxLength) {
                    secondMaxLength = maxLength;
                    maxLength = currentLength;
                } else if (currentLength > secondMaxLength) {
                    secondMaxLength = currentLength;
                }

                // Track longest affected
                if (chainContainsHexId && currentLength > longestAffected) {
                    longestAffected = currentLength;
                }

                // Reset for next chain segment
                currentLength = 0;
                chainContainsHexId = false;
            }

            // Move to next hex in this direction
            const HexPosition& pos = HEX_POSITIONS[currentHex];
            int newRow = pos.row + starter.dir.dr;
            int newCol = pos.col + starter.dir.dc;
            currentHex = findHexAt(newRow, newCol);
        }

        // Handle chain that extends to edge of board
        if (currentLength > 0) {
            if (currentLength > maxLength) {
                secondMaxLength = maxLength;
                maxLength = currentLength;
            } else if (currentLength > secondMaxLength) {
                secondMaxLength = currentLength;
            }

            if (chainContainsHexId && currentLength > longestAffected) {
                longestAffected = currentLength;
            }
        }
    }

    // Restore original state
    const_cast<HexukiBitboard*>(this)->hexValues[hexId] = savedValue;
    const_cast<HexukiBitboard*>(this)->hexOccupied = savedOccupied;

    // Apply same constraint rule as before
    // Rule: longest affected chain can be at most 1 longer than second longest
    if (longestAffected > secondMaxLength + 1) {
        return false;
    }

    return true;
}

// ============================================================================
// Anti-Symmetry Rule (REAL algorithm from JavaScript)
// ============================================================================

bool HexukiBitboard::isBoardMirrored() const {
    // If symmetry already broken, no need to check
    if (!symmetryStillPossible) {
        return false;
    }

    // Check if board is currently symmetric
    for (int hexId = 0; hexId < NUM_HEXES; hexId++) {
        // Skip center column hexes (they mirror to themselves)
        bool isCenterHex = false;
        for (int i = 0; i < 5; i++) {
            if (hexId == CENTER_COLUMN_HEXES[i]) {
                isCenterHex = true;
                break;
            }
        }
        if (isCenterHex) continue;

        int mirrorHexId = VERTICAL_MIRROR_PAIRS[hexId];
        int val1 = hexValues[hexId];
        int val2 = hexValues[mirrorHexId];

        // If one is empty and the other isn't, not currently symmetric
        if ((val1 == 0) != (val2 == 0)) {
            return false;
        }

        // If both occupied but different values, not symmetric AND never will be
        if (val1 != 0 && val2 != 0 && val1 != val2) {
            // NOTE: We can't modify symmetryStillPossible here (const function)
            // This will be handled in the non-const version
            return false;
        }
    }

    return true;  // Board is currently symmetric
}

// ============================================================================
// Stateless Anti-Symmetry (no make/unmake state -> cannot corrupt the search)
// ============================================================================

// Is the board perfectly vertically mirrored, treating subHexId as if it held
// subValue? Pass subHexId = -1 to test the board exactly as it is. A pair counts
// as "matched" only when both hexes are empty or both hold the same value.
bool HexukiBitboard::wouldBeMirrored(int subHexId, int subValue) const {
    for (int hexId = 0; hexId < NUM_HEXES; hexId++) {
        int mirrorHexId = VERTICAL_MIRROR_PAIRS[hexId];
        if (mirrorHexId <= hexId) continue;  // skip center (self-mirror); visit each pair once
        int v1 = (hexId == subHexId) ? subValue : hexValues[hexId];
        int v2 = (mirrorHexId == subHexId) ? subValue : hexValues[mirrorHexId];
        if ((v1 == 0) != (v2 == 0)) return false;          // one empty, one filled
        if (v1 != 0 && v2 != 0 && v1 != v2) return false;  // both filled, different
    }
    return true;
}

// The single tile value whose placement by `mover` would leave the two hands EQUAL afterward
// (mover's hand minus that value == opponent's hand) -- i.e. the mover holds exactly one extra of
// it. Returns -1 if there is no such value (hands already equal, or differ by more than one tile).
int HexukiBitboard::equalizingValue(int mover) const {
    const std::vector<int>& mh = (mover == PLAYER_1) ? p1AvailableTiles : p2AvailableTiles;
    const std::vector<int>& oh = (mover == PLAYER_1) ? p2AvailableTiles : p1AvailableTiles;
    int mc[MAX_TILE_VALUE + 1] = {}, oc[MAX_TILE_VALUE + 1] = {};
    for (int t : mh) if (t >= 1 && t <= MAX_TILE_VALUE) mc[t]++;
    for (int t : oh) if (t >= 1 && t <= MAX_TILE_VALUE) oc[t]++;
    int v0 = -1;
    for (int w = 1; w <= MAX_TILE_VALUE; w++) {
        const int d = mc[w] - oc[w];
        if (d == 0) continue;
        if (d == 1 && v0 == -1) v0 = w;   // mover has exactly one extra of value w
        else return -1;                    // any other imbalance -> no single equalizing tile
    }
    return v0;
}

// A move is forbidden iff it makes the board a perfect VERTICAL mirror AND leaves both players with
// equal tiles afterward. Both are properties of the RESULTING state (no game history needed), so the
// solver computes it identically to live play on any loaded position.
bool HexukiBitboard::createsForbiddenSymmetry(int hexId, int tileValue) const {
    if (tileValue != equalizingValue(currentPlayer)) return false;  // hands wouldn't be equal after
    return wouldBeMirrored(hexId, tileValue);
}

// ============================================================================
// Move Validation (REAL rules from JavaScript)
// ============================================================================

bool HexukiBitboard::isMoveLegal(int hexId) const {
    // Check if hex is empty
    if (isHexOccupied(hexId)) {
        return false;
    }

    // Check if adjacent to an occupied hex
    if (!hasAdjacentOccupied(hexId)) {
        return false;
    }

    // Check chain length constraint
    if (!checkChainLengthConstraint(hexId)) {
        return false;
    }

    return true;
}

bool HexukiBitboard::isValidMove(const Move& move) const {
    if (!move.isValid()) return false;

    // Check if position is legal
    if (!isMoveLegal(move.hexId)) {
        return false;
    }

    // Check if tile is available
    if (!isTileAvailable(currentPlayer, move.tileValue)) {
        return false;
    }

    // Anti-symmetry rule (stateless): reject a move that would mirror the board
    if (createsForbiddenSymmetry(move.hexId, move.tileValue)) {
        return false;
    }

    return true;
}

// Build the legal-hex table once by running the REAL isMoveLegal() over every
// occupancy. Legality (adjacency + chain length) reads only occupancy, so this is
// an exact memoization of the existing rules -- not a reimplementation.
void HexukiBitboard::buildLegalHexTable() {
    HexukiBitboard scratch;  // hexValues are irrelevant to legality; only occupancy matters
    for (uint32_t occ = 0; occ < (1u << NUM_HEXES); occ++) {
        scratch.hexOccupied = occ;
        uint32_t legal = 0;
        for (int h = 0; h < NUM_HEXES; h++) {
            // legal location iff empty AND passes the real adjacency + chain rules
            if (!(occ & (1u << h)) && scratch.isMoveLegal(h)) {
                legal |= (1u << h);
            }
        }
        g_legalHexMask[occ] = legal;
    }
}

void HexukiBitboard::ensureLegalTable() {
    if (g_legalTableBuilt) return;
    buildLegalHexTable();
    g_legalTableBuilt = true;
}

// Hot-path move generation: fill the caller's buffer instead of returning a fresh
// vector. The search reuses one buffer per ply, so after warmup this allocates NOTHING
// (clear() keeps capacity). Behaviour is identical to the old getValidMoves() -- same
// move order, same set -- so node counts and values are unchanged; only the ~per-node
// heap churn (the returned vector + the dedup temp) is gone.
void HexukiBitboard::getValidMovesInto(std::vector<Move>& moves) const {
    ensureLegalTable();  // no-op after the first build
    moves.clear();       // keeps capacity -> no realloc on repeat calls

    const std::vector<int>& availableTiles = (currentPlayer == PLAYER_1) ? p1AvailableTiles : p2AvailableTiles;

    // Unique tile values (e.g. [1,1,1] -> place "1" once) on a STACK array -- no heap.
    // At most 9 distinct values (tiles are 1..9), so 16 is a safe fixed bound.
    int uniqueTileValues[16];
    int uniqueCount = 0;
    for (int tile : availableTiles) {
        bool seen = false;
        for (int i = 0; i < uniqueCount; i++) { if (uniqueTileValues[i] == tile) { seen = true; break; } }
        if (!seen && uniqueCount < 16) uniqueTileValues[uniqueCount++] = tile;
    }

    // Anti-symmetry (VERTICAL axis only -- it swaps P1's \ and P2's / scoring chains, so a vertical
    // mirror is the degenerate equal-score state the rule prevents). A move is illegal iff it makes
    // the board a perfect vertical mirror AND leaves both hands equal AFTERWARD. "Equal afterward"
    // can hold for at most ONE tile value (the one the mover holds exactly one extra of), found once
    // per node -- so only that value ever needs the mirror test. Pure state, no history -> the solver
    // matches live play on any loaded position.
    const int symValue = equalizingValue(currentPlayer);   // -1 if no move can equalize the hands

    // Legal hex LOCATIONS come from the precomputed table -- one lookup replaces
    // the per-hex adjacency + chain walk. The bit is set only for empty, legal hexes.
    const uint32_t legal = g_legalHexMask[hexOccupied];

    for (int hexId = 0; hexId < NUM_HEXES; hexId++) {
        if (!(legal & (1u << hexId))) continue;   // table: not a legal location

        // Try each unique tile value (avoids generating duplicate moves)
        for (int u = 0; u < uniqueCount; u++) {
            const int tileValue = uniqueTileValues[u];
            // Forbidden symmetry: the equalizing tile that would make the board a perfect vertical mirror.
            if (tileValue == symValue && wouldBeMirrored(hexId, tileValue)) continue;
            moves.push_back(Move(hexId, tileValue));
        }
    }
}

// Convenience wrapper for non-hot callers (MCTS, UI, wasm interface): allocate + return.
std::vector<Move> HexukiBitboard::getValidMoves() const {
    std::vector<Move> moves;
    getValidMovesInto(moves);
    return moves;
}

// ============================================================================
// Move Execution
// ============================================================================

void HexukiBitboard::makeMove(const Move& move) {
    // Place tile on board
    hexOccupied |= (1u << move.hexId);
    hexValues[move.hexId] = move.tileValue;

    // Remove tile from current player's available tiles. Capture the count of this value
    // BEFORE removal so the hash can swap the per-player hand-count term (oldCount -> newCount).
    const int mover = currentPlayer;  // the player making this move (hash still holds their state)
    std::vector<int>& tiles = (mover == PLAYER_1) ? p1AvailableTiles : p2AvailableTiles;
    int oldCount = 0;
    for (int t : tiles) if (t == move.tileValue) oldCount++;
    auto it = std::find(tiles.begin(), tiles.end(), move.tileValue);
    if (it != tiles.end()) {
        tiles.erase(it);  // Remove first occurrence
    }

    // BUGFIX: Symmetry tracking removed - was causing non-deterministic minimax results
    // The symmetryStillPossible flag was being modified here but NOT restored in unmakeMove,
    // causing board state corruption when move ordering called makeMove/unmakeMove repeatedly.
    // This led to different minimax scores for the same position (e.g., +265, +261, +275).

    // Incrementally maintain the FULL-hash invariant (zobristHash == Zobrist::hash(*this)):
    applyHashDelta(move, mover, oldCount);

    // Switch to next player
    currentPlayer = (mover == PLAYER_1) ? PLAYER_2 : PLAYER_1;
}

void HexukiBitboard::unmakeMove(const Move& move) {
    // Switch player back (undo the player switch from makeMove)
    currentPlayer = (currentPlayer == PLAYER_1) ? PLAYER_2 : PLAYER_1;
    const int mover = currentPlayer;

    // The hand currently holds the POST-move count (newCount); the move added one back, so the
    // pre-move count was newCount+1. Apply the SAME delta as makeMove (XOR is self-inverse) to
    // restore zobristHash exactly. Pass oldCount = newCount + 1.
    std::vector<int>& tiles = (mover == PLAYER_1) ? p1AvailableTiles : p2AvailableTiles;
    int newCount = 0;
    for (int t : tiles) if (t == move.tileValue) newCount++;
    applyHashDelta(move, mover, newCount + 1);

    // Add tile back to player's available tiles
    tiles.push_back(move.tileValue);

    // Clear tile from board
    hexOccupied &= ~(1u << move.hexId);
    hexValues[move.hexId] = 0;

    // Note: symmetryStillPossible is not restored since symmetry checks are disabled
    // If symmetry is re-enabled later, this would need to track the previous state
}

// ============================================================================
// Scoring (REAL chain-based multiplication)
// ============================================================================

int HexukiBitboard::calculateChainScore(const int* chain, int chainLength) const {
    int product = 1;

    for (int i = 0; i < chainLength; i++) {
        int hexId = chain[i];
        if (hexId < 0) break;  // -1 padding in chain array

        if (isHexOccupied(hexId)) {
            product *= hexValues[hexId];
        }
    }

    return product;
}

int HexukiBitboard::calculatePlayerScore(int player) const {
    int totalScore = 0;

    if (player == PLAYER_1) {
        // P1 chains: down-right diagonals
        for (int i = 0; i < P1_CHAIN_COUNT; i++) {
            int chainScore = calculateChainScore(P1_CHAINS[i], P1_CHAIN_LENGTHS[i]);
            totalScore += chainScore;
        }
    } else {
        // P2 chains: down-left diagonals
        for (int i = 0; i < P2_CHAIN_COUNT; i++) {
            int chainScore = calculateChainScore(P2_CHAINS[i], P2_CHAIN_LENGTHS[i]);
            totalScore += chainScore;
        }
    }

    return totalScore;
}

int HexukiBitboard::getScore(int player) const {
    return calculatePlayerScore(player);
}

// ============================================================================
// Zobrist Hashing
// ============================================================================

// Incrementally apply the hash change for `mover` (1 or 2) playing `move`, where the mover held
// `oldCount` tiles of move.tileValue BEFORE the move. Keeps zobristHash == Zobrist::hash(*this).
// XOR is self-inverse, so calling this again with the same (move, mover, oldCount) undoes it --
// makeMove passes the pre-move count, unmakeMove reconstructs the identical count (newCount+1).
void HexukiBitboard::applyHashDelta(const Move& move, int mover, int oldCount) {
    // (1) tile placed on / removed from the board
    zobristHash ^= Zobrist::getTileHash(move.hexId, move.tileValue);

    // (2) side-to-move flips between the two players: the delta is the CONSTANT XOR of both
    //     player hashes (the old "XOR one mover hash" left the hash with no player term).
    zobristHash ^= Zobrist::getPlayerHash(PLAYER_1) ^ Zobrist::getPlayerHash(PLAYER_2);

    // (3) the mover's hand-count term for this value: oldCount -> oldCount-1, bound to the mover
    //     (this is what the broken update omitted, so P1{1}P2{6} and P1{6}P2{1} hashed alike).
    const int pIdx = mover - 1;
    const int newCount = oldCount - 1;
    if (oldCount > 0) zobristHash ^= Zobrist::getTileCountHash(pIdx, move.tileValue, oldCount);
    if (newCount > 0) zobristHash ^= Zobrist::getTileCountHash(pIdx, move.tileValue, newCount);
}

// ============================================================================
// Debug & Utility
// ============================================================================

void HexukiBitboard::print() const {
    // Count occupied hexes for move count
    int occupiedCount = 0;
    for (int i = 0; i < NUM_HEXES; i++) {
        if (isHexOccupied(i)) occupiedCount++;
    }

    std::cout << "=== Hexuki Board State ===" << std::endl;
    std::cout << "Occupied: " << occupiedCount << "/" << NUM_HEXES << ", Player: P" << currentPlayer << std::endl;
    std::cout << "Scores: P1=" << getScore(PLAYER_1) << ", P2=" << getScore(PLAYER_2) << std::endl;
    std::cout << std::endl;

    std::cout << "Occupied hexes:" << std::endl;
    for (int hexId = 0; hexId < NUM_HEXES; hexId++) {
        if (!isHexOccupied(hexId)) continue;

        std::cout << "  Hex " << hexId << " (row=" << HEX_POSITIONS[hexId].row
                  << ", col=" << HEX_POSITIONS[hexId].col << "): "
                  << "value=" << static_cast<int>(hexValues[hexId]) << std::endl;
    }
    std::cout << std::endl;

    std::cout << "Available tiles:" << std::endl;
    auto p1Tiles = getAvailableTiles(PLAYER_1);
    auto p2Tiles = getAvailableTiles(PLAYER_2);

    std::cout << "  P1: [";
    for (size_t i = 0; i < p1Tiles.size(); i++) {
        std::cout << p1Tiles[i];
        if (i < p1Tiles.size() - 1) std::cout << ", ";
    }
    std::cout << "]" << std::endl;

    std::cout << "  P2: [";
    for (size_t i = 0; i < p2Tiles.size(); i++) {
        std::cout << p2Tiles[i];
        if (i < p2Tiles.size() - 1) std::cout << ", ";
    }
    std::cout << "]" << std::endl;

    std::cout << "=========================" << std::endl;
}

std::string HexukiBitboard::toNotation() const {
    // Note: Move history is no longer tracked for performance reasons
    // This function returns empty string. Use savePosition() for current state.
    return "";
}

// ============================================================================
// Puzzle Setup
// ============================================================================

void HexukiBitboard::setHexValue(int hexId, int tileValue) {
    if (hexId < 0 || hexId >= NUM_HEXES) return;

    // Place the tile
    hexOccupied |= (1u << hexId);
    hexValues[hexId] = tileValue;

    // Recalculate hash
    zobristHash = Zobrist::hash(*this);
}

void HexukiBitboard::removeHexValue(int hexId) {
    if (hexId < 0 || hexId >= NUM_HEXES) return;

    // Remove the tile
    hexOccupied &= ~(1u << hexId);
    hexValues[hexId] = 0;

    // Recalculate hash
    zobristHash = Zobrist::hash(*this);
}

void HexukiBitboard::setAvailableTiles(int player, const std::vector<int>& tiles) {
    // Directly assign tile vector (supports duplicates like [1,1,1,1,1,1,1,1,1])
    if (player == PLAYER_1) {
        p1AvailableTiles = tiles;
    } else if (player == PLAYER_2) {
        p2AvailableTiles = tiles;
    }
}

void HexukiBitboard::clearBoard() {
    // Clear all tiles but keep player and move count
    hexOccupied = 0;
    std::memset(hexValues, 0, sizeof(hexValues));
    zobristHash = Zobrist::hash(*this);
}

void HexukiBitboard::loadPosition(const std::string& position) {
    // Clear everything first
    clearBoard();
    p1AvailableTiles = {1, 2, 3, 4, 5, 6, 7, 8, 9};  // Default: all tiles 1-9 available
    p2AvailableTiles = {1, 2, 3, 4, 5, 6, 7, 8, 9};
    currentPlayer = PLAYER_1;

    // Parse format: "h0:1,h4:5,h9:1|p1:2,3,4|p2:6,7,8|turn:1"
    std::istringstream iss(position);
    std::string section;

    bool p1Specified = false;
    bool p2Specified = false;

    while (std::getline(iss, section, '|')) {
        if (section.empty()) continue;

        // Parse hex placements: h0:1,h4:5
        if (section[0] == 'h') {
            std::istringstream hexStream(section);
            std::string hexPair;
            while (std::getline(hexStream, hexPair, ',')) {
                if (hexPair.size() < 4) continue;

                // Parse "h6:5" → hex 6, tile 5
                size_t colonPos = hexPair.find(':');
                if (colonPos == std::string::npos) continue;

                int hexId = std::stoi(hexPair.substr(1, colonPos - 1));
                int tileVal = std::stoi(hexPair.substr(colonPos + 1));

                setHexValue(hexId, tileVal);
            }
        }
        // Parse player 1 tiles: p1:2,3,4
        else if (section.substr(0, 3) == "p1:") {
            p1Specified = true;
            std::istringstream tileStream(section.substr(3));
            std::vector<int> tiles;
            std::string tileStr;
            while (std::getline(tileStream, tileStr, ',')) {
                tiles.push_back(std::stoi(tileStr));
            }
            setAvailableTiles(PLAYER_1, tiles);
        }
        // Parse player 2 tiles: p2:6,7,8
        else if (section.substr(0, 3) == "p2:") {
            p2Specified = true;
            std::istringstream tileStream(section.substr(3));
            std::vector<int> tiles;
            std::string tileStr;
            while (std::getline(tileStream, tileStr, ',')) {
                tiles.push_back(std::stoi(tileStr));
            }
            setAvailableTiles(PLAYER_2, tiles);
        }
        // Parse turn: turn:1
        else if (section.substr(0, 5) == "turn:") {
            currentPlayer = std::stoi(section.substr(5));
        }
    }

    // Recalculate symmetryStillPossible based on current board state
    // Symmetry is impossible if any mirror pair has different values
    symmetryStillPossible = true;
    for (int hexId = 0; hexId < NUM_HEXES; hexId++) {
        // Skip center column hexes (they mirror to themselves)
        bool isCenterHex = false;
        for (int i = 0; i < 5; i++) {
            if (hexId == CENTER_COLUMN_HEXES[i]) {
                isCenterHex = true;
                break;
            }
        }
        if (isCenterHex) continue;

        int mirrorHexId = VERTICAL_MIRROR_PAIRS[hexId];
        int val1 = hexValues[hexId];
        int val2 = hexValues[mirrorHexId];

        // If both occupied but different values, symmetry is impossible
        if (val1 != 0 && val2 != 0 && val1 != val2) {
            symmetryStillPossible = false;
            break;
        }
    }

    // Check if both players have identical starting tiles
    tilesAreIdentical = tilesMatch(p1AvailableTiles, p2AvailableTiles);

    // Recalculate hash
    zobristHash = Zobrist::hash(*this);
}

std::string HexukiBitboard::savePosition() const {
    std::ostringstream oss;

    // Save hex placements
    bool firstHex = true;
    for (int hexId = 0; hexId < NUM_HEXES; hexId++) {
        if (isHexOccupied(hexId)) {
            if (!firstHex) oss << ",";
            oss << "h" << hexId << ":" << static_cast<int>(hexValues[hexId]);
            firstHex = false;
        }
    }

    // Save player 1 available tiles
    oss << "|p1:";
    auto p1Tiles = getAvailableTiles(PLAYER_1);
    for (size_t i = 0; i < p1Tiles.size(); i++) {
        if (i > 0) oss << ",";
        oss << p1Tiles[i];
    }

    // Save player 2 available tiles
    oss << "|p2:";
    auto p2Tiles = getAvailableTiles(PLAYER_2);
    for (size_t i = 0; i < p2Tiles.size(); i++) {
        if (i > 0) oss << ",";
        oss << p2Tiles[i];
    }

    // Save current player
    oss << "|turn:" << currentPlayer;

    return oss.str();
}

} // namespace hexuki
