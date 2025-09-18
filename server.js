// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// --- Global Game Constants ---
let BOARD_COLS = 40, BOARD_ROWS = 30;
const GAME_TICK_MS = 125,MOVE_TICKS = 2, KEYFRAME_INTERVAL = 60;
const MAX_PLAYERS = 64;
const TIME_ACTION_COST = { ANCHOR: 200, SPLIT_BASE: 250 };
const TILE_TYPE = { EMPTY: 0, MOUNTAIN: 1, CITY: 2, GENERAL: 3, FOREST: 4, ERASED: 5 };
const GREEK_ALPHABET = [
    'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa',
    'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon',
    'phi', 'chi', 'psi', 'omega'
];

/**
 * Generates an array of aesthetically pleasing, distinct colors for players.
 * @param {number} count - The number of colors to generate.
 * @returns {string[]} An array of HSL color strings.
 */
function generatePlayerColors(count) {
    const colors = [];
    const saturation = 90;
    const lightness = 60;
    const goldenRatioConjugate = 0.61803398875;
    let hue = Math.random() * 360; 

    for (let i = 0; i < count; i++) {
        hue = (hue + 360 * goldenRatioConjugate) % 360;
        colors.push(`hsl(${Math.round(hue)}, ${saturation}%, ${lightness}%)`);
    }
    return colors;
}
const PLAYER_COLORS = generatePlayerColors(MAX_PLAYERS);
let game = createNewGame();

// --- Dynamic Cost Formulas (Server-side) ---
function calculateFreezeCost(duration) { return Math.floor(15 * Math.pow(1.07, duration / 5)); }
function calculateOverclockCost(duration) { return Math.floor(20 * Math.pow(1.08, duration / 5)); }
function calculatePortalCost(duration) { return Math.floor(40 * Math.pow(1.06, duration / 5)); }
const COST_CALCULATORS = {
    FREEZE: calculateFreezeCost,
    OVERCLOCK: calculateOverclockCost,
    HOP: calculatePortalCost,
};

/**
 * Creates and returns a new, empty game state object.
 * @returns {object} The initial game state object.
 */
function createNewGame() {
    return {
        multiverse: {},
        portals: [],
        paradoxEvents: [],
        players: {},
        playerCount: 0,
        gameInterval: null,
        boardDimensions: { cols: BOARD_COLS, rows: BOARD_ROWS }, 
        gameState: 'LOBBY',
        hostId: null,
        timelineNameCounter: 1,
        visibility: {},
        playerStats: {},
        settings: {
            fogOfWar: true,
            mountainPercent: 10,
            forestPercent: 15,
            cityCount: 8,
            staggeredStart: false,
            fairGenerals: true
        }
    };
}

/**
 * Calculates the optimal board dimensions based on the number of players.
 * @param {number} playerCount - The number of players in the game.
 * @returns {{cols: number, rows: number}} An object containing the new column and row counts.
 */
function calculateMapDimensions(playerCount) {
    const baseArea = 40 * 30;
    const requiredArea = baseArea * (1 + (playerCount - 2) * 0.5);
    const ratio = 16 / 9;
    const newCols = Math.round(Math.sqrt(requiredArea * ratio));
    const newRows = Math.round(newCols / ratio);
    return { cols: newCols, rows: newRows };
}

/**
 * Generates semi-random spawn points for each player, ensuring a minimum distance.
 * @param {{cols: number, rows: number}} boardDimensions - The dimensions of the game board.
 * @param {number} playerCount - The number of players needing spawn points.
 * @returns {object[]} An array of spawn point objects.
 */
function generateSpawnPoints(boardDimensions, playerCount) {
    const { cols, rows } = boardDimensions;
    const spawnPoints = [];
    const minDistance = Math.sqrt(cols * rows) / (playerCount > 1 ? Math.sqrt(playerCount) : 1) * 0.8;
    const padding = 5;
    for (let i = 1; i <= playerCount; i++) {
        let validSpawn = false, spawnRow, spawnCol, attempts = 0;
        while (!validSpawn && attempts < 100) {
            spawnRow = Math.floor(Math.random() * (rows - 2 * padding)) + padding;
            spawnCol = Math.floor(Math.random() * (cols - 2 * padding)) + padding;
            let tooClose = false;
            for (const point of spawnPoints) {
                const dist = Math.sqrt(Math.pow(point.row - spawnRow, 2) + Math.pow(point.col - spawnCol, 2));
                if (dist < minDistance) {
                    tooClose = true;
                    break;
                }
            }
            if (!tooClose) {
                validSpawn = true;
            }
            attempts++;
        }
        spawnPoints.push({ row: spawnRow, col: spawnCol, playerId: i });
    }
    return spawnPoints;
}

/**
 * Sets up the initial state of the game board and timelines when a match starts.
 * @param {object} game - The global game object to be initialized.
 */
function initializeGame(game) {
    game.boardDimensions = calculateMapDimensions(game.playerCount);
    const { cols, rows } = game.boardDimensions;
    BOARD_COLS = cols;
    BOARD_ROWS = rows;
    const initialGameState = { board: [], gameStep: 0, moves: [] };
    const newBoard = [];
    for (let row = 0; row < rows; row++) {
        const currentRow = [];
        for (let col = 0; col < cols; col++) {
            const tile = { type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 };
            if (Math.random() < game.settings.mountainPercent / 100) {
                tile.type = TILE_TYPE.MOUNTAIN;
            } else if (Math.random() < game.settings.forestPercent / 100) {
                tile.type = TILE_TYPE.FOREST;
            }
            currentRow.push(tile);
        }
        newBoard.push(currentRow);
    }
    initialGameState.board = newBoard;
    const baseArea = 40 * 30;
    const currentArea = cols * rows;
    const numberOfCities = Math.floor(game.settings.cityCount * (currentArea / baseArea));
    let maxNeutralArmy = 1;

    for (let i = 0; i < numberOfCities; i++) {
        let cityRow, cityCol;
        do {
            cityRow = Math.floor(Math.random() * rows);
            cityCol = Math.floor(Math.random() * cols);
        } while (initialGameState.board[cityRow][cityCol].type !== TILE_TYPE.EMPTY);
        const cityTile = initialGameState.board[cityRow][cityCol];
        cityTile.type = TILE_TYPE.CITY;
        cityTile.army = 40 + Math.floor(Math.random() * 20);
        if (cityTile.army > maxNeutralArmy) maxNeutralArmy = cityTile.army;
    }

    const spawnPoints = generateSpawnPoints(game.boardDimensions, game.playerCount);
    const startingArmy = game.settings.fairGenerals ? maxNeutralArmy : 1;
    spawnPoints.forEach(spawn => {
        if (initialGameState.board[spawn.row][spawn.col].type === TILE_TYPE.MOUNTAIN) {
            initialGameState.board[spawn.row][spawn.col].type = TILE_TYPE.EMPTY;
        }
        initialGameState.board[spawn.row][spawn.col] = { type: TILE_TYPE.GENERAL, ownerId: spawn.playerId, army: startingArmy };
    });
    
    const firstTimelineId = 'timeline-alpha';
    game.multiverse[firstTimelineId] = {
        id: firstTimelineId,
        currentState: initialGameState,
        keyframes: [{ step: 0, gameState: JSON.parse(JSON.stringify(initialGameState)) }],
        actions: [],
        isFrozen: false,
        freezeUntilStep: 0,
        overclockUntilStep: 0,
        speedMultiplier: 1.0,
        anchorStep: 0,
        parentId: null,
        splitStep: 0,
        isUnravelling: false,
        unravelCenter: null,
        unravelRadius: 0
    };
    game.gameState = 'RUNNING';
    io.emit('game-start', { settings: game.settings });
}

/**
 * Applies the effect of a player's action to the game state.
 * @param {object} gameState - The game state to modify.
 * @param {object} action - The action object containing type, player, cost, etc.
 */
function applyAction(gameState, action) {
    const { type, playerId, cost } = action;
    const generalInfo = findGeneral(playerId, gameState);
    switch (type) {
        case 'MOVE':
            const startTile = gameState.board[action.path[0].row][action.path[0].col];
            if (startTile.army <= 1) break;
            const armyToLeave = action.isSplit ? Math.ceil(startTile.army / 2) : 1;
            const movingArmy = startTile.army - armyToLeave;
            if (movingArmy < 1) break;
            startTile.army = armyToLeave;
            const newMove = { ownerId: playerId, army: movingArmy, path: action.path, pathIndex: 0, progress: 0 };
            if (startTile.causalityTag) {
                newMove.causalityTag = startTile.causalityTag;
            }
            gameState.moves.push(newMove);
            break;
        case 'SPLIT':
        case 'FREEZE':
        case 'OVERCLOCK':
        case 'HOP':
             if (generalInfo) generalInfo.tile.army -= cost;
            break;
        case 'ANCHOR':
            if (generalInfo) generalInfo.tile.army -= TIME_ACTION_COST.ANCHOR;
            break;
    }
}

/**
 * Validates and processes a player's move action. If the player already has an
 * army in motion, this function will cancel the existing move, return its army,
 * and then create the new move. This allows players to fluidly redirect their active army.
 * @param {number} playerId - The ID of the player making the move.
 * @param {object} action - The move action object from the client.
 * @param {string} activeTimelineId - The ID of the timeline where the move occurs.
 * @param {object} game - The global game object.
 */
function processMove(playerId, action, activeTimelineId, game) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline) return;

    const { path } = action;
    if (!path || path.length < 2) return;

    const gameState = timeline.currentState;
    const board = gameState.board;

    const startTile = board[path[0].row]?.[path[0].col];
    if (!startTile || startTile.ownerId !== playerId || startTile.army <= 1) return;

    // --- NEW CANCELLATION LOGIC ---
    // Find the index of any existing move from the same player.
    const existingMoveIndex = gameState.moves.findIndex(move => move.ownerId === playerId);

    // If an existing move is found (index is not -1)...
    if (existingMoveIndex !== -1) {
        // Get the old move object.
        const oldMove = gameState.moves[existingMoveIndex];
        
        // Determine its last position.
        const lastPosition = oldMove.path[oldMove.pathIndex];
        const returnTile = board[lastPosition.row]?.[lastPosition.col];

        // If the tile still exists, return the army to it.
        if (returnTile) {
            returnTile.army += oldMove.army;
        }

        // Remove the old move from the array.
        gameState.moves.splice(existingMoveIndex, 1);
    }

    // Validate the entire path for the new move to ensure it's legal.
    for (let i = 0; i < path.length; i++) {
        const { row, col } = path[i];
        const tile = board[row]?.[col];
        // Path cannot go through mountains or off the board.
        if (!tile || tile.type === TILE_TYPE.MOUNTAIN) return;
        if (i > 0) {
            const prev = path[i - 1];
            // Path must be contiguous (no diagonal or skipping tiles).
            if (Math.abs(col - prev.col) + Math.abs(row - prev.row) !== 1) return;
        }
    }
    
    // If all checks pass, record and apply the new action.
    const actionForHistory = { type: 'MOVE', playerId, path, isSplit: action.isSplit };
    timeline.actions.push({ step: gameState.gameStep, action: actionForHistory });
    applyAction(gameState, actionForHistory);
}

/**
 * Processes a single discrete time step for a given timeline.
 * @param {object} currentGameState - The state of the timeline to be updated.
 * @param {string} timelineId - The ID of the timeline being processed.
 * @param {object} game - The global game object.
 */
function runSingleTickLogic(currentGameState, timelineId, game) {
    for (let i = currentGameState.moves.length - 1; i >= 0; i--) {
        const move = currentGameState.moves[i];
        move.progress++;

        if (move.progress >= MOVE_TICKS) {
            move.progress = 0;
            const nextPos = move.path[move.pathIndex + 1];

            if (!nextPos) {
                currentGameState.moves.splice(i, 1);
                continue;
            }

            const portal = game.portals.find(p => p.fromTimelineId === timelineId && p.coords.row === nextPos.row && p.coords.col === nextPos.col);
            if (portal) {
                const toTimeline = game.multiverse[portal.toTimelineId];
                if (toTimeline) {
                    const exitTilePos = findValidAdjacentTile(portal.coords, toTimeline.currentState);
                    if (exitTilePos) {
                        const causalityTag = { originTimelineId: timelineId, originStep: currentGameState.gameStep };
                        toTimeline.currentState.moves.push({
                            ownerId: move.ownerId,
                            army: move.army,
                            path: [portal.coords, exitTilePos],
                            pathIndex: 0,
                            progress: 0,
                            causalityTag
                        });
                        currentGameState.moves.splice(i, 1);
                        continue; 
                    }
                }
            }
            
            const isFinalMove = move.pathIndex >= move.path.length - 2;
            const nextTile = currentGameState.board[nextPos.row][nextPos.col];

            if (nextTile.ownerId !== move.ownerId) { // Attack
                if (move.army > nextTile.army) {
                    if(nextTile.type === TILE_TYPE.GENERAL) handlePlayerDefeat(move.ownerId, nextTile.ownerId, currentGameState);
                    
                    nextTile.ownerId = move.ownerId;
                    const armyAfterCapture = move.army - nextTile.army;

                    if (isFinalMove) {
                        nextTile.army = armyAfterCapture;
                    } else {
                        nextTile.army = 1;
                        move.army = armyAfterCapture - 1;
                    }
                    nextTile.causalityTag = move.causalityTag;

                    if (!isFinalMove && move.army <= 0) {
                        currentGameState.moves.splice(i, 1);
                    }
                } else {
                    nextTile.army -= move.army;
                    currentGameState.moves.splice(i, 1);
                }
            } else { // Reinforce or Snowball
                if (isFinalMove) {
                    nextTile.army += move.army;
                } else {
                    move.army += nextTile.army - 1;
                    nextTile.army = 1;
                }
            }

            if (currentGameState.moves.includes(move)) {
                if (isFinalMove) {
                    currentGameState.moves.splice(i, 1);
                } else {
                    move.pathIndex++;
                }
            }
        }
    }
    
    currentGameState.gameStep++;
    for (let row = 0; row < BOARD_ROWS; row++) {
        for (let col = 0; col < BOARD_COLS; col++) {
            const tile = currentGameState.board[row][col];
            if (tile.ownerId !== 0) {
                if ((tile.type === TILE_TYPE.GENERAL || tile.type === TILE_TYPE.CITY) && currentGameState.gameStep % 4 === 0) {
                    tile.army++;
                } else if ((tile.type === TILE_TYPE.EMPTY || tile.type === TILE_TYPE.FOREST) && currentGameState.gameStep % 20 === 0) {
                    tile.army++;
                }
            }
        }
    }
}

/**
 * Creates a new timeline by duplicating the state of an existing one.
 * @param {number} playerId - The ID of the player performing the action.
 * @param {string} activeTimelineId - The ID of the timeline to split.
 * @param {object} game - The global game object.
 */
function splitTimeline(playerId, activeTimelineId, game) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline) return;

    const numTimelines = Object.keys(game.multiverse).length;
    const splitCost = Math.floor(TIME_ACTION_COST.SPLIT_BASE * Math.pow(1.25, numTimelines - 1));
    const generalInfo = findGeneral(playerId, timeline.currentState);

    if (!generalInfo || generalInfo.tile.army < splitCost) return;

    const action = { type: 'SPLIT', playerId, cost: splitCost };
    timeline.actions.push({ step: timeline.currentState.gameStep, action });
    applyAction(timeline.currentState, action);

    const newGameState = JSON.parse(JSON.stringify(timeline.currentState));
    
    const nameIndex = game.timelineNameCounter % GREEK_ALPHABET.length;
    const newName = GREEK_ALPHABET[nameIndex];
    const newTimelineId = `timeline-${newName}-${game.timelineNameCounter}`;
    game.timelineNameCounter++;
    
    game.multiverse[newTimelineId] = {
        id: newTimelineId,
        currentState: newGameState,
        keyframes: [{ step: newGameState.gameStep, gameState: JSON.parse(JSON.stringify(newGameState)) }],
        actions: timeline.actions.filter(a => a.step <= newGameState.gameStep),
        isFrozen: false,
        freezeUntilStep: 0,
        overclockUntilStep: 0,
        speedMultiplier: 1.0,
        anchorStep: newGameState.gameStep,
        parentId: activeTimelineId,
        splitStep: timeline.currentState.gameStep,
        isUnravelling: false,
        unravelCenter: null,
        unravelRadius: 0
    };
}

/**
 * Finds a valid, non-mountain tile adjacent to the given coordinates.
 * @param {{row: number, col: number}} coords - The central coordinates.
 * @param {object} currentGameState - The game state to check for valid tiles.
 * @returns {{row: number, col: number}|null} The coordinates of a valid tile, or null.
 */
function findValidAdjacentTile(coords, currentGameState) {
    const { row, col } = coords;
    const directions = [{r: -1, c: 0}, {r: 1, c: 0}, {r: 0, c: -1}, {r: 0, c: 1}];
    for (const dir of directions) {
        const r = row + dir.r;
        const c = col + dir.c;
        if (r >= 0 && r < BOARD_ROWS && c >= 0 && c < BOARD_COLS) {
            if (currentGameState.board[r][c].type !== TILE_TYPE.MOUNTAIN) {
                return { row: r, col: c };
            }
        }
    }
    return null;
}

/**
 * Calculates and aggregates statistics for each player.
 * @param {object} game - The global game object.
 */
function calculatePlayerStats(game) {
    const stats = { global: {} };
    for (const playerSocketId in game.players) {
        const player = game.players[playerSocketId];
        stats.global[player.id] = { army: 0 };
    }

    for (const timelineId in game.multiverse) {
        stats[timelineId] = {};
        for (const playerSocketId in game.players) {
            const player = game.players[playerSocketId];
            stats[timelineId][player.id] = { army: 0 };
        }

        const gameState = game.multiverse[timelineId].currentState;
        for (let row = 0; row < BOARD_ROWS; row++) {
            for (let col = 0; col < BOARD_COLS; col++) {
                const tile = gameState.board[row][col];
                if (tile.ownerId !== 0 && stats[timelineId][tile.ownerId]) {
                    stats[timelineId][tile.ownerId].army += tile.army;
                    stats.global[tile.ownerId].army += tile.army;
                }
            }
        }

        for (const move of gameState.moves) {
            if (move.ownerId !== 0 && stats[timelineId][move.ownerId]) {
                stats[timelineId][move.ownerId].army += move.army;
                stats.global[move.ownerId].army += move.army;
            }
        }
    }
    game.playerStats = stats;
}

/**
 * The main game loop function.
 * @param {object} game - The global game object.
 */
function gameLoop(game) {
    const activePlayers = new Set();
    const firstTimelineState = game.multiverse['timeline-alpha']?.currentState;
    if (firstTimelineState) {
        for (let r = 0; r < BOARD_ROWS; r++) {
            for (let c = 0; c < BOARD_COLS; c++) {
                const tile = firstTimelineState.board[r][c];
                if (tile.type === TILE_TYPE.GENERAL && tile.ownerId !== 0) {
                    activePlayers.add(tile.ownerId);
                }
            }
        }
    }


    if (activePlayers.size <= 1 && game.playerCount > 1 && game.gameState === 'RUNNING') {
        const winnerId = activePlayers.values().next().value || "No one";
        io.emit('game-over', { winnerId });
        clearTimeout(game.gameInterval);
        game.gameState = 'FINISHED';

        setTimeout(() => {
            const connectedSockets = new Map(io.sockets.sockets);
            game = createNewGame();
            let i = 1;
            connectedSockets.forEach((socket, socketId) => {
                const color = PLAYER_COLORS[(i-1) % PLAYER_COLORS.length];
                game.players[socketId] = { id: i, name: `Player ${i}`, color: color, isReady: false };
                if (game.hostId === null) { game.hostId = socket.id; }
                socket.emit('player-assignment', {playerId: i, color: color});
                i++;
            });
            game.playerCount = Object.keys(game.players).length;
            const hostPlayerId = game.players[game.hostId]?.id;
            io.emit('lobby-update', { players: Object.values(game.players), settings: game.settings, hostPlayerId });
        }, 10000);
        return;
    }

    const masterClock = game.multiverse['timeline-alpha'] ? game.multiverse['timeline-alpha'].currentState.gameStep : 0;
    game.portals = game.portals.filter(p => p.expiresOnStep > masterClock);
    paradoxHandler(game);
    game.paradoxEvents = game.paradoxEvents.filter(event => {
        event.duration--;
        return event.duration > 0;
    });

    const timelineIds = Object.keys(game.multiverse);
    for (const timelineId of timelineIds) {
        const timeline = game.multiverse[timelineId];
        if (!timeline) continue;
        if (timeline.isFrozen && timeline.currentState.gameStep >= timeline.freezeUntilStep) {
            timeline.isFrozen = false;
            timeline.freezeUntilStep = 0;
        }
        if (timeline.speedMultiplier > 1.0 && timeline.currentState.gameStep >= timeline.overclockUntilStep) {
            timeline.speedMultiplier = 1.0;
            timeline.overclockUntilStep = 0;
        }
        for (let i = 0; i < timeline.speedMultiplier; i++) {
            updateTimeline(timeline, timelineId, game);
        }
    }
}

/**
 * Advances a single timeline by one tick.
 * @param {object} timeline - The timeline object to update.
 * @param {string} timelineId - The ID of the timeline.
 * @param {object} game - The global game object.
 */
function updateTimeline(timeline, timelineId, game) {
    if (timeline.isFrozen || timeline.isUnravelling) {
        if (!timeline.isUnravelling) timeline.currentState.gameStep++;
        return;
    }
    
    runSingleTickLogic(timeline.currentState, timelineId, game);
    
    if (timeline.currentState.gameStep % KEYFRAME_INTERVAL === 0) {
        timeline.keyframes.push({
            step: timeline.currentState.gameStep,
            gameState: JSON.parse(JSON.stringify(timeline.currentState))
        });
        if (timeline.keyframes.length > 30) {
            timeline.keyframes.shift();
        }
    }
}

/**
 * Manages paradoxes by checking for causality violations.
 * @param {object} game - The global game object.
 */
/**
 * Manages paradoxes by checking for causality violations. If a paradox is found
 * (e.g., a unit exists from a timeline that has been rolled back or unraveled),
 * this function will neutralize the paradoxical units and territory and trigger a visual event.
 * It also handles the unravelling of timelines that no longer have a valid parent.
 * @param {object} game - The global game object.
 */
function paradoxHandler(game) {
    for (const timelineId in game.multiverse) {
        const timeline = game.multiverse[timelineId];
        if (timeline.isUnravelling) {
            timeline.unravelRadius += 1;
            const { unravelCenter, unravelRadius } = timeline;
            let tilesRemaining = false;
            for (let row = 0; row < BOARD_ROWS; row++) {
                for (let col = 0; col < BOARD_COLS; col++) {
                    const tile = timeline.currentState.board[row][col];
                    if (tile.type !== TILE_TYPE.ERASED) {
                        const dist = Math.sqrt(Math.pow(row - unravelCenter.row, 2) + Math.pow(col - unravelCenter.col, 2));
                        if (dist <= unravelRadius) {
                            tile.type = TILE_TYPE.ERASED; tile.army = 0; tile.ownerId = 0;
                        } else {
                            tilesRemaining = true;
                        }
                    }
                }
            }
            if (!tilesRemaining) {
                delete game.multiverse[timelineId];
            }
        } else if (timeline.parentId) { // Check for timeline existence paradox
            const parent = game.multiverse[timeline.parentId];
            if (!parent || parent.currentState.gameStep < timeline.splitStep) {
                timeline.isUnravelling = true;
                const generalInfo = findGeneral(Object.values(game.players)[0]?.id, timeline.currentState) || { row: Math.floor(BOARD_ROWS/2), col: Math.floor(BOARD_COLS/2)};
                timeline.unravelCenter = { row: generalInfo.row, col: generalInfo.col };
                timeline.unravelRadius = 0;
            }
        }
    }

    for (const timelineId in game.multiverse) {
        const timeline = game.multiverse[timelineId];
        const currentGameState = timeline.currentState;
        for (let row = 0; row < BOARD_ROWS; row++) {
            for (let col = 0; col < BOARD_COLS; col++) {
                const tile = currentGameState.board[row][col];
                if (tile.causalityTag) {
                    const origin = game.multiverse[tile.causalityTag.originTimelineId];
                    if (!origin || origin.currentState.gameStep < tile.causalityTag.originStep || origin.isUnravelling) {
                        console.log(`Paradox at ${timelineId} (${row},${col}) from ${tile.causalityTag.originTimelineId}`);
                        // --- BUG FIX ---
                        // Resetting not only the army but also the ownership of the tile.
                        // This prevents players from retaining territory gained from paradoxical actions.
                        tile.army = 0;
                        tile.ownerId = 0; // This line prevents the unit duplication bug.
                        delete tile.causalityTag;
                        game.paradoxEvents.push({ timelineId, coords: { row, col }, duration: 30 });
                    }
                }
            }
        }

        for (let i = currentGameState.moves.length - 1; i >= 0; i--) {
            const move = currentGameState.moves[i];
            if (move.causalityTag) {
                const origin = game.multiverse[move.causalityTag.originTimelineId];
                if (!origin || origin.currentState.gameStep < move.causalityTag.originStep || origin.isUnravelling) {
                    console.log(`Paradox move in ${timelineId} from ${move.causalityTag.originTimelineId}`);
                    const coords = move.path[move.pathIndex];
                    game.paradoxEvents.push({ timelineId, coords, duration: 30 });
                    currentGameState.moves.splice(i, 1);
                }
            }
        }
    }
}

/**
 * Applies the 'Freeze' time power to a timeline.
 * @param {number} playerId - The ID of the player performing the action.
 * @param {string} activeTimelineId - The ID of the timeline to freeze.
 * @param {object} game - The global game object.
 * @param {number} duration - The number of game steps to freeze for.
 * @param {number} cost - The army cost for the action.
 */
function freezeTimeline(playerId, activeTimelineId, game, duration, cost) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline) return;

    const generalInfo = findGeneral(playerId, timeline.currentState);
    if (!generalInfo || generalInfo.tile.army < cost) return;

    const action = { type: 'FREEZE', playerId, cost, duration };
    timeline.actions.push({ step: timeline.currentState.gameStep, action });
    applyAction(timeline.currentState, action);

    timeline.freezeUntilStep = timeline.currentState.gameStep + duration;
    timeline.isFrozen = true;
}

/**
 * Applies the 'Overclock' time power to a timeline.
 * @param {number} playerId - The ID of the player performing the action.
 * @param {string} activeTimelineId - The ID of the timeline to overclock.
 * @param {object} game - The global game object.
 * @param {number} duration - The number of game steps to overclock for.
 * @param {number} cost - The army cost for the action.
 */
function overclockTimeline(playerId, activeTimelineId, game, duration, cost) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline) return;

    const generalInfo = findGeneral(playerId, timeline.currentState);
    if (!generalInfo || generalInfo.tile.army < cost) return;

    const action = { type: 'OVERCLOCK', playerId, cost, duration };
    timeline.actions.push({ step: timeline.currentState.gameStep, action });
    applyAction(timeline.currentState, action);
    
    timeline.overclockUntilStep = timeline.currentState.gameStep + duration;
    timeline.speedMultiplier = 2.0;
}

/**
 * Reverts a timeline to a previous state in its history.
 * @param {number} playerId - The ID of the player performing the rollback.
 * @param {string} activeTimelineId - The ID of the timeline to roll back.
 * @param {number} targetStep - The game step to revert to.
 * @param {object} game - The global game object.
 */
function rollbackTimeline(playerId, activeTimelineId, targetStep, game) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline || targetStep < timeline.anchorStep || targetStep >= timeline.currentState.gameStep) return;

    const stepsToRollback = timeline.currentState.gameStep - targetStep;
    const cost = Math.floor(10 * Math.pow(1.05, stepsToRollback / 10));
    
    const lastKeyframe = [...timeline.keyframes].reverse().find(kf => kf.step <= targetStep);
    if (!lastKeyframe) return;

    let tempState = JSON.parse(JSON.stringify(lastKeyframe.gameState));
    const actionsToReplay = timeline.actions.filter(a => a.step > lastKeyframe.step && a.step <= targetStep);
    
    for (let s = lastKeyframe.step; s < targetStep; s++) {
        for (const actionRecord of actionsToReplay) {
            if (actionRecord.step === s) applyAction(tempState, actionRecord.action);
        }
        runSingleTickLogic(tempState, activeTimelineId, game);
    }
    
    const generalInPast = findGeneral(playerId, tempState);
    if (!generalInPast || generalInPast.tile.army < cost) return;
    
    generalInPast.tile.army -= cost;
    timeline.currentState = tempState;
    timeline.actions = timeline.actions.filter(a => a.step < targetStep);
}


/**
 * Sets a "save point" in a timeline.
 * @param {number} playerId - The ID of the player performing the action.
 * @param {string} activeTimelineId - The ID of the timeline to anchor.
 * @param {object} game - The global game object.
 */
function anchorTimeline(playerId, activeTimelineId, game) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline) return;

    const generalInfo = findGeneral(playerId, timeline.currentState);
    if (!generalInfo || generalInfo.tile.army < TIME_ACTION_COST.ANCHOR) return;

    const action = { type: 'ANCHOR', playerId, cost: TIME_ACTION_COST.ANCHOR };
    timeline.actions.push({ step: timeline.currentState.gameStep, action });
    applyAction(timeline.currentState, action);

    timeline.anchorStep = timeline.currentState.gameStep;
}

/**
 * Creates a pair of linked portals between two timelines.
 * @param {number} playerId - The ID of the player opening the portal.
 * @param {string} activeTimelineId - The timeline where the portal is initiated.
 * @param {{row: number, col: number}} selectedTile - The coordinates for the portal.
 * @param {object} game - The global game object.
 * @param {number} duration - The duration the portal will last.
 * @param {number} cost - The army cost of the portal.
 */
function openPortal(playerId, activeTimelineId, selectedTile, game, duration, cost) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline) return;

    const generalInfo = findGeneral(playerId, timeline.currentState);
    if (!generalInfo || generalInfo.tile.army < cost) return;

    const otherTimelineIds = Object.keys(game.multiverse).filter(id => id !== activeTimelineId);
    if (otherTimelineIds.length === 0) return;
    const toTimelineId = otherTimelineIds[Math.floor(Math.random() * otherTimelineIds.length)];

    const action = { type: 'HOP', playerId, cost, duration };
    timeline.actions.push({ step: timeline.currentState.gameStep, action });
    applyAction(timeline.currentState, action);

    const masterClock = game.multiverse['timeline-alpha'] ? game.multiverse['timeline-alpha'].currentState.gameStep : 0;
    const expiresOnStep = masterClock + duration;

    game.portals.push({
        fromTimelineId: activeTimelineId,
        toTimelineId: toTimelineId,
        coords: selectedTile,
        expiresOnStep: expiresOnStep
    });
     game.portals.push({
        fromTimelineId: toTimelineId,
        toTimelineId: activeTimelineId,
        coords: selectedTile,
        expiresOnStep: expiresOnStep
    });
}

/**
 * Finds the location and state of a player's General tile.
 * @param {number} playerId - The ID of the player whose General to find.
 * @param {object} currentGameState - The game state to search within.
 * @returns {{row: number, col: number, tile: object}|null} An object with the General's info, or null.
 */
function findGeneral(playerId, currentGameState) {
    for (let r = 0; r < BOARD_ROWS; r++) {
        for (let c = 0; c < BOARD_COLS; c++) {
            const tile = currentGameState.board[r][c];
            if (tile.type === TILE_TYPE.GENERAL && tile.ownerId === playerId) {
                return { row: r, col: c, tile: tile };
            }
        }
    }
    return null;
}

/**
 * Handles the consequences of a player being defeated.
 * @param {number} victorId - The ID of the player who won the engagement.
 * @param {number} defeatedId - The ID of the player whose General was captured.
 * @param {object} currentGameState - The game state where the defeat occurred.
 */
function handlePlayerDefeat(victorId, defeatedId, currentGameState) {
    for (let r = 0; r < BOARD_ROWS; r++) {
        for (let c = 0; c < BOARD_COLS; c++) {
            if (currentGameState.board[r][c].ownerId === defeatedId) {
                currentGameState.board[r][c].ownerId = victorId;
            }
        }
    }
}

/**
 * Calculates a separate visibility grid for each timeline for a specific player.
 * @param {number} playerId - The ID of the player to calculate visibility for.
 * @param {object} game - The global game object.
 */
function updatePlayerVisibility(playerId, game) {
    const { rows, cols } = game.boardDimensions;
    if (!game.visibility[playerId]) game.visibility[playerId] = {};

    if (!game.settings.fogOfWar) {
        const fullyVisibleGrid = Array(rows).fill(null).map(() => Array(cols).fill(true));
        for (const timelineId in game.multiverse) {
            game.visibility[playerId][timelineId] = fullyVisibleGrid;
        }
        return;
    }

    const SIGHT_RADIUS = 2;
    for (const timelineId in game.multiverse) {
        const grid = Array(rows).fill(null).map(() => Array(cols).fill(false));
        const gameState = game.multiverse[timelineId].currentState;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const tile = gameState.board[r][c];
                if (tile && tile.ownerId === playerId) {
                    for (let scanR = r - SIGHT_RADIUS; scanR <= r + SIGHT_RADIUS; scanR++) {
                        for (let scanC = c - SIGHT_RADIUS; scanC <= c + SIGHT_RADIUS; scanC++) {
                            if (scanR >= 0 && scanR < rows && scanC >= 0 && scanC < cols) {
                                grid[scanR][scanC] = true;
                            }
                        }
                    }
                }
            }
        }
        game.visibility[playerId][timelineId] = grid;
    }
}

/**
 * Creates a tailored, pruned version of the game state for a specific player.
 * @param {number} playerId - The ID of the player for whom to generate the state.
 * @returns {object} A pruned game state object ready to be sent to the client.
 */
function getPrunedClientState(playerId) {
    const prunedMultiverse = JSON.parse(JSON.stringify(game.multiverse));
    const visibilityForPlayer = game.visibility[playerId];

    if (game.settings.fogOfWar && visibilityForPlayer) {
        for (const timelineId in prunedMultiverse) {
            const visibilityGrid = visibilityForPlayer[timelineId];
            const timelineState = prunedMultiverse[timelineId].currentState;

            if (!visibilityGrid) continue;

            for (let r = 0; r < BOARD_ROWS; r++) {
                for (let c = 0; c < BOARD_COLS; c++) {
                    if (!visibilityGrid[r][c]) {
                        const originalTile = timelineState.board[r][c];
                        timelineState.board[r][c] = {
                            ownerId: 0,
                            army: 0,
                            type: originalTile.type,
                            causalityTag: null
                        };
                    }
                }
            }

            timelineState.moves = timelineState.moves.filter(move => {
                const pos = move.path[move.pathIndex];
                return pos && visibilityGrid[pos.row] && visibilityGrid[pos.row][pos.col];
            });
        }
    }

    return {
        multiverse: prunedMultiverse,
        portals: game.portals,
        paradoxEvents: game.paradoxEvents,
        visibility: game.visibility[playerId],
        boardDimensions: game.boardDimensions,
        playerStats: game.playerStats,
        settings: game.settings
    };
}


// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    if (game.playerCount >= MAX_PLAYERS || game.gameState === 'RUNNING') {
        socket.emit('game-in-progress');
        socket.disconnect();
        return;
    }
    game.playerCount++;
    const playerId = game.playerCount;
    const color = PLAYER_COLORS[(playerId - 1) % PLAYER_COLORS.length];
    game.players[socket.id] = { id: playerId, name: `Player ${playerId}`, color: color, isReady: false };

    if (game.hostId === null) {
        game.hostId = socket.id;
    }

    socket.emit('player-assignment', { playerId, color });
    const hostPlayerId = game.players[game.hostId]?.id;
    io.emit('lobby-update', { players: Object.values(game.players), settings: game.settings, hostPlayerId });

    socket.on('update-game-settings', (newSettings) => {
        if (socket.id === game.hostId && game.gameState === 'LOBBY') {
            game.settings.fogOfWar = !!newSettings.fogOfWar;
            game.settings.staggeredStart = !!newSettings.staggeredStart;
            game.settings.fairGenerals = !!newSettings.fairGenerals;
            game.settings.mountainPercent = Math.max(0, Math.min(50, parseInt(newSettings.mountainPercent) || 0));
            game.settings.forestPercent = Math.max(0, Math.min(50, parseInt(newSettings.forestPercent) || 0));
            game.settings.cityCount = Math.max(0, Math.min(20, parseInt(newSettings.cityCount) || 0));
            io.emit('lobby-update', { players: Object.values(game.players), settings: game.settings, hostPlayerId: game.players[game.hostId]?.id });
        }
    });

    socket.on('player-ready', (isReady) => {
        if (game.gameState !== 'LOBBY') return;
        const player = game.players[socket.id];
        if (player) {
            player.isReady = isReady;
            io.emit('lobby-update', { players: Object.values(game.players), settings: game.settings, hostPlayerId: game.players[game.hostId]?.id });

            const allPlayers = Object.values(game.players);
            const allReady = allPlayers.length > 0 && allPlayers.every(p => p.isReady);

            if (allReady && allPlayers.length >= 1) {
                initializeGame(game);
                const dynamicGameLoop = () => {
                    if (game.gameState !== 'RUNNING') return;
                    const activeTimelinesCount = Object.values(game.multiverse).filter(t => !t.isFrozen).length || 1;
                    const tickDuration = GAME_TICK_MS * activeTimelinesCount;
                    gameLoop(game);

                    calculatePlayerStats(game);
                    for (const socketId in game.players) {
                        const player = game.players[socketId];
                        updatePlayerVisibility(player.id, game);
                    }

                    for (const socketId in game.players) {
                        if (io.sockets.sockets.get(socketId)) {
                            const player = game.players[socketId];
                            const personalizedState = getPrunedClientState(player.id);
                            io.to(socketId).emit('game-state-update', personalizedState);
                        }
                    }
                    if (game.gameState === 'RUNNING') {
                        game.gameInterval = setTimeout(dynamicGameLoop, tickDuration);
                    }
                };
                dynamicGameLoop();
            }
        }
    });
    
    socket.on('get-rollback-info', ({ activeTimelineId }) => {
        const player = game.players[socket.id];
        if (!player) return;
        const timeline = game.multiverse[activeTimelineId];
        if (!timeline) return;
        let oldestAffordableStep = timeline.currentState.gameStep;
        for (let step = timeline.currentState.gameStep - 1; step >= timeline.anchorStep; step--) {
            const lastKeyframe = [...timeline.keyframes].reverse().find(kf => kf.step <= step);
            if (!lastKeyframe) break;
            let tempState = JSON.parse(JSON.stringify(lastKeyframe.gameState));
            const actionsToReplay = timeline.actions.filter(a => a.step > lastKeyframe.step && a.step <= step);
            for (let s = lastKeyframe.step; s < step; s++) {
                for (const actionRecord of actionsToReplay) {
                    if (actionRecord.step === s) applyAction(tempState, actionRecord.action);
                }
                runSingleTickLogic(tempState, activeTimelineId, game);
            }
            const generalInPast = findGeneral(player.id, tempState);
            const stepsToRollback = timeline.currentState.gameStep - step;
            const cost = Math.floor(10 * Math.pow(1.05, stepsToRollback / 10));
            if (generalInPast && generalInPast.tile.army >= cost) {
                oldestAffordableStep = step;
            } else {
                break;
            }
        }
        socket.emit('rollback-info-response', { oldestAffordableStep });
    });
    
    socket.on('get-affordability-info', ({ actionType, activeTimelineId }) => {
        const player = game.players[socket.id];
        if (!player) return;
        const timeline = game.multiverse[activeTimelineId];
        if (!timeline) return;
        const generalInfo = findGeneral(player.id, timeline.currentState);
        if (!generalInfo) return;
        
        const generalArmy = generalInfo.tile.army;
        const costCalculator = COST_CALCULATORS[actionType];
        if (!costCalculator) return;
        
        let maxDuration = 0;
        for (let d = 1; d < 500; d++) {
            if (costCalculator(d) <= generalArmy) {
                maxDuration = d;
            } else {
                break;
            }
        }
        socket.emit('affordability-info-response', { actionType, maxDuration });
    });
    
    socket.on('player-action', (action) => {
        if (game.gameState !== 'RUNNING') return;
        const player = game.players[socket.id];
        if (!player) return;
        switch (action.type) {
            case 'MOVE': processMove(player.id, action, action.activeTimelineId, game); break;
            case 'SPLIT': splitTimeline(player.id, action.activeTimelineId, game); break;
            case 'FREEZE': freezeTimeline(player.id, action.activeTimelineId, game, action.duration, action.cost); break;
            case 'OVERCLOCK': overclockTimeline(player.id, action.activeTimelineId, game, action.duration, action.cost); break;
            case 'ROLLBACK': rollbackTimeline(player.id, action.activeTimelineId, action.targetStep, game); break;
            case 'ANCHOR': anchorTimeline(player.id, action.activeTimelineId, game); break;
            case 'HOP': openPortal(player.id, action.activeTimelineId, action.selectedTile, game, action.duration, action.cost); break;
        }
    });

    socket.on('disconnect', () => {
        const disconnectedPlayer = game.players[socket.id];
        if (disconnectedPlayer) {
            if (game.gameState === 'RUNNING') {
                const disconnectedPlayerId = disconnectedPlayer.id;
                for (const timelineId in game.multiverse) {
                    const timeline = game.multiverse[timelineId];
                    handlePlayerDefeat(0, disconnectedPlayerId, timeline.currentState);
                }
            }
            delete game.players[socket.id];
            game.playerCount--;

            if (socket.id === game.hostId) { 
                const newHostSocket = Object.keys(game.players)[0];
                game.hostId = newHostSocket || null;
            }

            if (game.gameState === 'LOBBY') {
                 io.emit('lobby-update', { players: Object.values(game.players), settings: game.settings, hostPlayerId: game.players[game.hostId]?.id });
            } else {
                 io.emit('player-list-update', Object.values(game.players));
            }
        }
        
        if (game.gameState === 'RUNNING' && game.playerCount < 2) {
            clearTimeout(game.gameInterval);
            io.emit('game-over', { winnerId: 'none', reason: 'Not enough players.' });
            game = createNewGame();
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});