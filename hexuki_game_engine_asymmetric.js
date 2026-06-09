/**
 * Hexuki Headless Game Engine - Asymmetric Tiles Variant
 *
 * RULE CHANGE: Each player gets 9 RANDOM tile values (1-9, can have duplicates)
 * - Example: P1 = [3, 7, 1, 9, 3, 5, 2, 8, 1], P2 = [4, 4, 6, 9, 2, 7, 5, 8, 3]
 * - Tests whether game balance is affected by tile distribution vs position
 */

// Anti-symmetry: forbid horizontal (top<->bottom) mirrors in addition to vertical. Both reflections
// force an equal-score draw. Set to false to revert to vertical-only (and FORBID_HORIZONTAL_SYMMETRY
// in the C++ constants.h, then rebuild). Kept in sync with the C++ engine for the cross-check.
const HEXUKI_FORBID_HORIZONTAL = true;

class HexukiGameEngineAsymmetric {
    constructor() {
        this.reset();
    }

    /**
     * Generate 9 random tile values (1-9, duplicates allowed)
     */
    generateRandomTiles() {
        const tiles = [];
        for (let i = 0; i < 9; i++) {
            tiles.push(Math.floor(Math.random() * 9) + 1); // Random 1-9
        }
        return tiles;
    }

    /**
     * Check if two tile arrays are identical (same values in any order)
     */
    tilesMatch(tiles1, tiles2) {
        if (tiles1.length !== tiles2.length) return false;
        const sorted1 = [...tiles1].sort((a, b) => a - b);
        const sorted2 = [...tiles2].sort((a, b) => a - b);
        return sorted1.every((val, i) => val === sorted2[i]);
    }

    reset() {
        // EXACT copy from real game (lines 2314-2350)
        const positions = [
            {id: 0, row: 0, col: 2},
            {id: 1, row: 1, col: 1},
            {id: 2, row: 1, col: 3},
            {id: 3, row: 2, col: 0},
            {id: 4, row: 2, col: 2},
            {id: 5, row: 2, col: 4},
            {id: 6, row: 3, col: 1},
            {id: 7, row: 3, col: 3},
            {id: 8, row: 4, col: 0},
            {id: 9, row: 4, col: 2},
            {id: 10, row: 4, col: 4},
            {id: 11, row: 5, col: 1},
            {id: 12, row: 5, col: 3},
            {id: 13, row: 6, col: 0},
            {id: 14, row: 6, col: 2},
            {id: 15, row: 6, col: 4},
            {id: 16, row: 7, col: 1},
            {id: 17, row: 7, col: 3},
            {id: 18, row: 8, col: 2}
        ];

        this.board = [];
        positions.forEach(pos => {
            this.board.push({
                id: pos.id,
                row: pos.row,
                col: pos.col,
                value: null,
                owner: null
            });
        });

        // Set center tile (id: 9) with value 1
        this.board[9].value = 1;
        this.board[9].owner = 'neutral';

        // ASYMMETRIC TILES: Each player gets 9 random values (1-9, duplicates allowed)
        this.player1Tiles = this.generateRandomTiles();
        this.player2Tiles = this.generateRandomTiles();

        // Track which tile positions have been used
        this.player1UsedPositions = new Set();
        this.player2UsedPositions = new Set();

        this.currentPlayer = 1;
        this.gameEnded = false;
        this.moveCount = 0;

        // Active-hex mask (board-size variant). Default = all 19. Beginner mode restricts play to the
        // inner-7 hexagon; gating move legality keeps the outer ring empty (mirrors the C++ engine).
        this.activeMask = (1 << 19) - 1;

        // Anti-symmetry tracking: once symmetry is broken, no need to check again
        this.symmetryStillPossible = true;

        // Only enforce anti-symmetry if both players have identical starting tiles
        this.tilesAreIdentical = this.tilesMatch(this.player1Tiles, this.player2Tiles);

        // Vertical mirror pairs (for anti-symmetry rule)
        // Maps each hex ID to its vertical mirror across the center column (col 2)
        this.verticalMirrorPairs = {
            0: 0,   // Center column (col 2) - mirrors to itself
            1: 2,   // Col 1 ↔ Col 3
            2: 1,
            3: 5,   // Col 0 ↔ Col 4
            4: 4,   // Center column
            5: 3,
            6: 7,   // Col 1 ↔ Col 3
            7: 6,
            8: 10,  // Col 0 ↔ Col 4
            9: 9,   // Center column
            10: 8,
            11: 12, // Col 1 ↔ Col 3
            12: 11,
            13: 15, // Col 0 ↔ Col 4
            14: 14, // Center column
            15: 13,
            16: 17, // Col 1 ↔ Col 3
            17: 16,
            18: 18  // Center column
        };

        // Horizontal mirror pairs (top<->bottom reflection across the center row). Like the vertical
        // mirror, this swaps every P1 diagonal onto a P2 diagonal -> a horizontally-mirrored board is
        // also a forced draw. Center row {8,9,10} maps to itself. (Mirrors the C++ HORIZONTAL_MIRROR_PAIRS.)
        this.horizontalMirrorPairs = {
            0: 18, 1: 16, 2: 17, 3: 13, 4: 14, 5: 15, 6: 11, 7: 12,
            8: 8, 9: 9, 10: 10,
            11: 6, 12: 7, 13: 3, 14: 4, 15: 5, 16: 1, 17: 2, 18: 0
        };

        // Scoring chain definitions - SYMMETRIC straight diagonals
        // Player 1 chains: down-right diagonals (\)
        this.player1Chains = [
            [0, 2, 5],           // 3-hex chain
            [1, 4, 7, 10],       // 4-hex chain
            [3, 6, 9, 12, 15],   // 5-hex chain (center diagonal, includes starting hex 9)
            [8, 11, 14, 17],     // 4-hex chain
            [13, 16, 18]         // 3-hex chain
        ];

        // Player 2 chains: down-left diagonals (/)
        this.player2Chains = [
            [0, 1, 3],           // 3-hex chain
            [2, 4, 6, 8],        // 4-hex chain
            [5, 7, 9, 11, 13],   // 5-hex chain (center diagonal, includes starting hex 9)
            [10, 12, 14, 16],    // 4-hex chain (FIXED: was [12, 14, 16, 10])
            [15, 17, 18]         // 3-hex chain
        ];
    }

    /**
     * EXACT copy from real game (lines 3755-3779)
     */
    getAdjacentHexes(hexId) {
        const hex = this.board[hexId];
        const adjacent = [];

        const directions = [
            {dr: -2, dc: 0},   // UP
            {dr: -1, dc: 1},   // UPRIGHT
            {dr: 1, dc: 1},    // DOWNRIGHT
            {dr: 2, dc: 0},    // DOWN
            {dr: 1, dc: -1},   // DOWNLEFT
            {dr: -1, dc: -1}   // UPLEFT
        ];

        directions.forEach(({dr, dc}) => {
            const adjHex = this.board.find(h =>
                h.row === hex.row + dr && h.col === hex.col + dc
            );
            if (adjHex) {
                adjacent.push(adjHex.id);
            }
        });

        return adjacent;
    }

    /**
     * EXACT copy from real game (lines 3852-3882)
     */
    getChainLengthsFromStart(boardState, startId, direction) {
        const lengths = [];
        let currentLength = 0;
        let current = startId;

        while (current !== null) {
            const hex = boardState.find(h => h.id === current);
            if (!hex) break;

            if (hex.value !== null) {
                currentLength++;
            } else if (currentLength > 0) {
                // Hit empty cell, record current chain and reset
                lengths.push(currentLength);
                currentLength = 0;
            }

            // Move to next cell in direction
            const nextHex = boardState.find(h =>
                h.row === hex.row + direction.dr && h.col === hex.col + direction.dc
            );
            current = nextHex ? nextHex.id : null;
        }

        // Record final chain if we ended on occupied cells
        if (currentLength > 0) {
            lengths.push(currentLength);
        }

        return lengths;
    }

    /**
     * Get all chains with their member hex IDs
     * Returns array of {length, hexIds: []}
     */
    getAllChainsWithMembers(boardState) {
        const chains = [];

        // All possible chain starters and directions
        const chainStarters = [
            {start: 0, dir: {dr: 1, dc: -1}},
            {start: 0, dir: {dr: 2, dc: 0}},
            {start: 0, dir: {dr: 1, dc: 1}},
            {start: 1, dir: {dr: 2, dc: 0}},
            {start: 1, dir: {dr: 1, dc: 1}},
            {start: 2, dir: {dr: 1, dc: -1}},
            {start: 2, dir: {dr: 2, dc: 0}},
            {start: 3, dir: {dr: 2, dc: 0}},
            {start: 3, dir: {dr: 1, dc: 1}},
            {start: 5, dir: {dr: 1, dc: -1}},
            {start: 5, dir: {dr: 2, dc: 0}},
            {start: 8, dir: {dr: 1, dc: 1}},
            {start: 10, dir: {dr: 1, dc: -1}},
            {start: 13, dir: {dr: 1, dc: 1}},
            {start: 15, dir: {dr: 1, dc: -1}}
        ];

        chainStarters.forEach(({start, dir}) => {
            let currentChain = [];
            let current = start;

            while (current !== null) {
                const hex = boardState.find(h => h.id === current);
                if (!hex) break;

                if (hex.value !== null) {
                    currentChain.push(hex.id);
                } else if (currentChain.length > 0) {
                    // Hit empty cell, record current chain and reset
                    chains.push({ length: currentChain.length, hexIds: currentChain });
                    currentChain = [];
                }

                // Move to next cell in direction
                const nextHex = boardState.find(h =>
                    h.row === hex.row + dir.dr && h.col === hex.col + dir.dc
                );
                current = nextHex ? nextHex.id : null;
            }

            // Record final chain if we ended on occupied cells
            if (currentChain.length > 0) {
                chains.push({ length: currentChain.length, hexIds: currentChain });
            }
        });

        // Find isolated tiles (occupied hexes not part of any detected chain)
        const hexesInChains = new Set();
        chains.forEach(chain => {
            chain.hexIds.forEach(hexId => hexesInChains.add(hexId));
        });

        // Add isolated tiles as 1-chains
        boardState.forEach(hex => {
            if (hex.value !== null && !hexesInChains.has(hex.id)) {
                chains.push({ length: 1, hexIds: [hex.id] });
            }
        });

        return chains;
    }

    /**
     * EXACT copy from real game (lines 3822-3850)
     */
    getAllChainLengthsForBoard(boardState) {
        const chainLengths = [];

        // All possible chain starters and directions from RulesV1.java
        const chainStarters = [
            {start: 0, dir: {dr: 1, dc: -1}}, // DOWNLEFT
            {start: 0, dir: {dr: 2, dc: 0}},  // DOWN
            {start: 0, dir: {dr: 1, dc: 1}},  // DOWNRIGHT
            {start: 1, dir: {dr: 2, dc: 0}},  // DOWN
            {start: 1, dir: {dr: 1, dc: 1}},  // DOWNRIGHT
            {start: 2, dir: {dr: 1, dc: -1}}, // DOWNLEFT
            {start: 2, dir: {dr: 2, dc: 0}},  // DOWN
            {start: 3, dir: {dr: 2, dc: 0}},  // DOWN
            {start: 3, dir: {dr: 1, dc: 1}},  // DOWNRIGHT
            {start: 5, dir: {dr: 1, dc: -1}}, // DOWNLEFT
            {start: 5, dir: {dr: 2, dc: 0}},  // DOWN
            {start: 8, dir: {dr: 1, dc: 1}},  // DOWNRIGHT
            {start: 10, dir: {dr: 1, dc: -1}}, // DOWNLEFT
            {start: 13, dir: {dr: 1, dc: 1}}, // DOWNRIGHT
            {start: 15, dir: {dr: 1, dc: -1}} // DOWNLEFT
        ];

        chainStarters.forEach(({start, dir}) => {
            const lengths = this.getChainLengthsFromStart(boardState, start, dir);
            chainLengths.push(...lengths);
        });

        return chainLengths;
    }

    /**
     * EXACT copy from real game (lines 3806-3820)
     */
    getFirstAndSecondChainLengthsForBoard(boardState) {
        const allChainLengths = this.getAllChainLengthsForBoard(boardState);
        let first = 0, second = 0;

        allChainLengths.forEach(length => {
            if (length > first) {
                second = first;
                first = length;
            } else if (length > second) {
                second = length;
            }
        });

        return { first, second };
    }

    /**
     * Check chain length constraint (modified for puzzle support)
     * Rule: longest chain CONTAINING the new tile can be at most 1 longer than second longest chain on board
     */
    checkChainLengthConstraint(hexId) {
        // Order 1 games have no length constraint
        if (this.board.length === 7) return true;

        // Make a test board with the proposed move
        const testBoard = JSON.parse(JSON.stringify(this.board));
        testBoard[hexId].value = 1; // Use dummy value for testing
        testBoard[hexId].owner = `player${this.currentPlayer}`;

        // Get all chains with their member hexes
        const allChains = this.getAllChainsWithMembers(testBoard);

        // Find chains that contain the newly placed hexId (affected chains)
        const affectedChains = allChains.filter(chain => chain.hexIds.includes(hexId));

        // Get longest affected chain
        let longestAffected = 0;
        affectedChains.forEach(chain => {
            if (chain.length > longestAffected) {
                longestAffected = chain.length;
            }
        });

        // Get all chain lengths sorted descending
        const allLengths = allChains.map(c => c.length).sort((a, b) => b - a);

        // Get second longest chain on entire board
        const secondLongest = allLengths.length >= 2 ? allLengths[1] : 0;

        // Rule: longest affected chain can be at most 1 longer than second longest
        if (longestAffected > secondLongest + 1) {
            return false;
        }

        return true;
    }

    /**
     * Check if a hex has an adjacent occupied hex
     */
    hasAdjacentOccupied(hexId) {
        const adjacentHexes = this.getAdjacentHexes(hexId);
        return adjacentHexes.some(adjId => this.board[adjId].value !== null);
    }

    /**
     * Based on real game logic (lines 3725-3753)
     */
    isMoveLegal(hexId) {
        const hex = this.board[hexId];

        // Check if hex exists
        if (!hex) {
            console.error(`Invalid hexId: ${hexId} (board has ${this.board.length} hexes)`);
            return false;
        }

        // Active-hex gate (beginner mode): hexes outside the in-play mask are never legal.
        if (((this.activeMask >> hexId) & 1) === 0) {
            return false;
        }

        // Check if hex is empty
        if (hex.value !== null) {
            return false;
        }

        // Check if adjacent to an occupied hex
        const adjacentHexes = this.getAdjacentHexes(hexId);
        const hasAdjacentOccupied = adjacentHexes.some(id =>
            this.board[id] && this.board[id].value !== null
        );

        if (!hasAdjacentOccupied) return false;

        // Check chain length constraint
        const chainOk = this.checkChainLengthConstraint(hexId);

        return chainOk;
    }

    /**
     * Make a move (place a tile)
     * Returns true if successful, false if illegal
     */
    makeMove(hexId, tileValue) {
        this.lastError = null;

        // Validate move
        if (!this.isMoveLegal(hexId)) {
            this.lastError = 'Invalid move (hex filled, not adjacent, or breaks the chain rule).';
            return false;
        }

        // Validate tile is available
        const availableTiles = this.currentPlayer === 1 ? this.player1Tiles : this.player2Tiles;
        if (!availableTiles.includes(tileValue)) {
            this.lastError = 'That tile is not available.';
            return false;
        }

        // Anti-symmetry rule (stateless): reject a move that would mirror the board
        if (this.createsForbiddenSymmetry(hexId, tileValue)) {
            this.lastError = 'No symmetry moves allowed.';
            return false;
        }

        // Place the tile
        this.board[hexId].value = tileValue;
        this.board[hexId].owner = `player${this.currentPlayer}`;

        // Move is valid - finalize it
        // Remove tile from available tiles
        let removedTileIndex;
        if (this.currentPlayer === 1) {
            const idx = this.player1Tiles.indexOf(tileValue);
            this.player1Tiles.splice(idx, 1);
            removedTileIndex = idx;
        } else {
            const idx = this.player2Tiles.indexOf(tileValue);
            this.player2Tiles.splice(idx, 1);
            removedTileIndex = idx;
        }

        // Store the removed tile index for potential undo operations
        this.lastRemovedTileIndex = removedTileIndex;

        this.moveCount++;

        // Game ends when every IN-PLAY hex is filled (active-mask aware -> correct under blackouts,
        // and also handles empty-center puzzles where 19 moves are possible). Default mask = all 19.
        let activeOpen = 0;
        for (let h = 0; h < 19; h++) if (((this.activeMask >> h) & 1) && this.board[h].value === null) activeOpen++;
        if (activeOpen === 0) {
            this.gameEnded = true;
        }

        // Switch player
        this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;

        return true;
    }

    /**
     * Calculate scores for both players
     * Based on real game logic (lines 4336-4390)
     */
    calculateScores() {
        const p1Score = this.calculatePlayerScore(1);
        const p2Score = this.calculatePlayerScore(2);

        return {
            player1: p1Score,
            player2: p2Score
        };
    }

    /**
     * Calculate score for a specific player
     */
    calculatePlayerScore(playerNum) {
        const chains = playerNum === 1 ? this.player1Chains : this.player2Chains;
        let totalScore = 0;

        for (let chain of chains) {
            let chainProduct = 1;
            let any = false;

            for (let hexId of chain) {
                const hex = this.board[hexId];
                if (hex.value !== null) {
                    chainProduct *= hex.value;
                    any = true;
                }
            }

            // A chain with no tiles scores 0, not 1 (mirrors the C++ fix; matters under blackout).
            totalScore += any ? chainProduct : 0;
        }

        return totalScore;
    }

    /**
     * Check if board VALUES are perfectly mirrored vertically
     * Returns true if the board is symmetric (which makes the position ILLEGAL)
     *
     * OPTIMIZATION: Sets symmetryStillPossible = false if any mismatch found,
     * permanently disabling future checks for this game.
     */
    isBoardMirrored() {
        // If symmetry already broken, no need to check
        if (!this.symmetryStillPossible) {
            return false;
        }

        // Center column hexes are ON the symmetry line - skip them
        const centerHexes = [0, 4, 9, 14, 18];

        // Check if board is currently symmetric
        // A board is symmetric if ALL non-center pairs are either:
        // - both empty, OR
        // - both have the same value
        let isCurrentlySymmetric = true;

        for (let hexId = 0; hexId < 19; hexId++) {
            if (centerHexes.includes(hexId)) continue;

            const mirrorHexId = this.verticalMirrorPairs[hexId];
            const val1 = this.board[hexId].value;
            const val2 = this.board[mirrorHexId].value;

            // If one is empty and the other isn't, not currently symmetric
            if ((val1 === null) !== (val2 === null)) {
                isCurrentlySymmetric = false;
                break;
            }

            // If both occupied but different values, not symmetric AND never will be
            if (val1 !== null && val2 !== null && val1 !== val2) {
                // ONLY disable permanently when both are occupied with different values
                // This means symmetry is IMPOSSIBLE going forward
                this.symmetryStillPossible = false;
                return false;
            }
        }

        return isCurrentlySymmetric;
    }

    // ── Stateless anti-symmetry (mirrors the C++ bitboard; no flag to corrupt) ──
    // Is the board a perfect mirror across `pairs`, treating subHex as holding subVal?
    mirrorOnAxis(pairs, subHex, subVal) {
        for (let h = 0; h < 19; h++) {
            const mh = pairs[h];
            if (mh <= h) continue;  // skip self-mirror axis; visit each pair once
            const v1 = (h === subHex) ? subVal : this.board[h].value;
            const v2 = (mh === subHex) ? subVal : this.board[mh].value;
            if ((v1 === null) !== (v2 === null)) return false;          // one empty, one filled
            if (v1 !== null && v2 !== null && v1 !== v2) return false;  // both filled, different
        }
        return true;
    }

    // Mirroring on EITHER score-degenerate axis -- vertical, or (when enabled) horizontal. Both
    // reflections force an equal-score draw. subHex = -1 tests the board as-is; subVal is a real tile.
    // REVERT: set HEXUKI_FORBID_HORIZONTAL = false (top of file) to restore vertical-only.
    wouldBeMirrored(subHex, subVal) {
        if (this.mirrorOnAxis(this.verticalMirrorPairs, subHex, subVal)) return true;
        if (HEXUKI_FORBID_HORIZONTAL && this.mirrorOnAxis(this.horizontalMirrorPairs, subHex, subVal)) return true;
        return false;
    }

    // The single tile value whose placement by `mover` (1 or 2) would leave both hands EQUAL
    // afterward (mover's hand minus that value == opponent's hand) -- i.e. mover holds exactly one
    // extra of it. Returns -1 if none (hands already equal, or differ by more than one tile).
    equalizingValue(mover) {
        const mh = mover === 1 ? this.player1Tiles : this.player2Tiles;
        const oh = mover === 1 ? this.player2Tiles : this.player1Tiles;
        const mc = new Array(10).fill(0), oc = new Array(10).fill(0);
        for (const t of mh) if (t >= 1 && t <= 9) mc[t]++;
        for (const t of oh) if (t >= 1 && t <= 9) oc[t]++;
        let v0 = -1;
        for (let w = 1; w <= 9; w++) {
            const d = mc[w] - oc[w];
            if (d === 0) continue;
            if (d === 1 && v0 === -1) v0 = w;   // mover has exactly one extra of value w
            else return -1;                      // any other imbalance -> no single equalizing tile
        }
        return v0;
    }

    // A move is forbidden iff it makes the board a perfect VERTICAL mirror AND leaves both players
    // with equal tiles afterward. Both are properties of the RESULTING state (no game history), so
    // this matches the solver on any loaded position.
    createsForbiddenSymmetry(hexId, tileValue) {
        if (tileValue !== this.equalizingValue(this.currentPlayer)) return false;
        return this.wouldBeMirrored(hexId, tileValue);
    }

    /**
     * Get all valid moves for current player
     */
    getAllValidMoves() {
        const moves = [];
        const availableTiles = this.currentPlayer === 1 ? this.player1Tiles : this.player2Tiles;

        // Anti-symmetry (vertical only): forbidden iff a move makes the board a perfect vertical
        // mirror AND equalizes the hands afterward. That can hold for at most ONE tile value -- the
        // equalizing one -- so only it needs the mirror test. Pure state -> matches the solver.
        const symValue = this.equalizingValue(this.currentPlayer);   // -1 if no move can equalize

        for (let hexId = 0; hexId < 19; hexId++) {
            if (this.board[hexId].value !== null) continue;

            if (this.isMoveLegal(hexId)) {
                // Try each available tile
                for (let tileValue of availableTiles) {
                    // Reject the equalizing tile if it would make the board a perfect vertical mirror.
                    if (tileValue === symValue && this.wouldBeMirrored(hexId, tileValue)) continue;
                    moves.push({ hexId, tileValue });
                }
            }
        }

        return moves;
    }

    /**
     * Board-size mode: 7 = beginner inner hexagon, else full 19-hex board. Mirrors C++ setActiveHexMask.
     */
    setBoardMode(hexes) {
        const INNER7 = (1 << 4) | (1 << 6) | (1 << 7) | (1 << 9) | (1 << 11) | (1 << 12) | (1 << 14);
        this.activeMask = hexes === 7 ? INNER7 : ((1 << 19) - 1);
    }

    /**
     * Get game state for hashing
     */
    getState() {
        return {
            board: this.board,
            currentPlayer: this.currentPlayer,
            player1Tiles: [...this.player1Tiles],
            player2Tiles: [...this.player2Tiles],
            player1UsedPositions: this.player1UsedPositions,
            player2UsedPositions: this.player2UsedPositions
        };
    }
}

// Export for use in AI trainer
if (typeof window !== 'undefined') {
    window.HexukiGameEngineAsymmetric = HexukiGameEngineAsymmetric;
}
