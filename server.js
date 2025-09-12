// server.js

// --- 1. SETUP & INITIALIZATION ---
// Import necessary Node.js modules.
const express = require('express');         // For serving static files (like index.html).
const http = require('http');               // To create an HTTP server.
const { Server } = require("socket.io");    // For real-time, bidirectional communication.
const path = require('path');               // For handling file paths.

// Initialize the server application.
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory.
app.use(express.static(path.join(__dirname, 'public')));

// --- 2. GAME CONSTANTS & CONFIGURATION ---
let BOARD_COLS = 40, BOARD_ROWS = 30; // Default dimensions, will be resized based on player count.
const GAME_TICK_MS = 500;             // The base duration of a single game tick in milliseconds.
const MOVE_TICKS = 2;                 // How many game ticks it takes for an army to move one tile.
const KEYFRAME_INTERVAL = 60;         // How often to save a "keyframe" of the game state for rollbacks.
const MAX_PLAYERS = 64;               // Maximum number of players allowed in a single game.

// Base costs for time manipulation actions.
const TIME_ACTION_COST = { ANCHOR: 200, SPLIT_BASE: 250 };
// Enum for different tile types.
const TILE_TYPE = { EMPTY: 0, MOUNTAIN: 1, CITY: 2, GENERAL: 3, FOREST: 4, ERASED: 5 };

/**
 * Generates a set of visually distinct colors for players.
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
// The main game object that holds all state.
let game = createNewGame();

// --- 3. DYNAMIC COST FORMULAS (Server-side) ---
// These functions calculate the cost of actions based on their duration.
// The exponential growth makes longer-lasting effects much more expensive.
function calculateFreezeCost(duration) { return Math.floor(15 * Math.pow(1.07, duration / 5)); }
function calculateOverclockCost(duration) { return Math.floor(20 * Math.pow(1.08, duration / 5)); }
function calculatePortalCost(duration) { return Math.floor(40 * Math.pow(1.06, duration / 5)); }
const COST_CALCULATORS = {
    FREEZE: calculateFreezeCost,
    OVERCLOCK: calculateOverclockCost,
    HOP: calculatePortalCost,
};


// --- 4. CORE GAME MANAGEMENT FUNCTIONS ---

/**
 * Creates a new, empty game object, effectively resetting the server to a lobby state.
 * @returns {object} The initial game state object.
 */
function createNewGame() {
    return {
        multiverse: {},         // Stores all timelines.
        portals: [],            // Stores active portals between timelines.
        paradoxEvents: [],      // Stores visual paradox events for the client.
        players: {},            // Stores player data, keyed by socket.id.
        playerCount: 0,
        gameInterval: null,     // Holds the reference to the main game loop timer.
        boardDimensions: { cols: BOARD_COLS, rows: BOARD_ROWS }, 
        gameState: 'LOBBY',     // Can be 'LOBBY', 'RUNNING', 'FINISHED'.
        hostId: null,           // The socket.id of the host player.
        settings: {             // Default game settings, can be changed by the host.
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
 * Calculates the appropriate map dimensions based on the number of players.
 * The map area scales to ensure fair spacing.
 * @param {number} playerCount - The number of players in the game.
 * @returns {{cols: number, rows: number}} The calculated dimensions.
 */
function calculateMapDimensions(playerCount) {
    const baseArea = 40 * 30;
    const requiredArea = baseArea * (1 + (playerCount - 2) * 0.5); // Increase area by 50% for each player beyond 2.
    const ratio = 16 / 9; // Maintain a widescreen aspect ratio.
    const newCols = Math.round(Math.sqrt(requiredArea * ratio));
    const newRows = Math.round(newCols / ratio);
    return { cols: newCols, rows: newRows };
}

/**
 * Generates starting locations for players, ensuring they are a minimum distance apart.
 * @param {object} boardDimensions - The dimensions of the board.
 * @param {number} playerCount - The number of players needing a spawn point.
 * @returns {Array<object>} An array of spawn point coordinates.
 */
function generateSpawnPoints(boardDimensions, playerCount) {
    const { cols, rows } = boardDimensions;
    const spawnPoints = [];
    const minDistance = Math.sqrt(cols * rows) / (playerCount > 1 ? Math.sqrt(playerCount) : 1) * 0.8;
    const padding = 5; // Don't spawn players too close to the edge.
    for (let i = 1; i <= playerCount; i++) {
        let validSpawn = false, spawnRow, spawnCol, attempts = 0;
        while (!validSpawn && attempts < 100) { // Try 100 times to find a valid spot.
            spawnRow = Math.floor(Math.random() * (rows - 2 * padding)) + padding;
            spawnCol = Math.floor(Math.random() * (cols - 2 * padding)) + padding;
            let tooClose = false;
            for (const point of spawnPoints) {
                const dist = Math.sqrt(Math.pow(point.row - spawnRow, 2) + Math.pow(point.col - spawnCol, 2));
                if (dist < minDistance) { tooClose = true; break; }
            }
            if (!tooClose) { validSpawn = true; }
            attempts++;
        }
        spawnPoints.push({ row: spawnRow, col: spawnCol, playerId: i });
    }
    return spawnPoints;
}

/**
 * Initializes the game state when the lobby is ready.
 * This includes generating the map, placing cities, and spawning players.
 * @param {object} game - The main game object.
 */
function initializeGame(game) {
    game.boardDimensions = calculateMapDimensions(game.playerCount);
    const { cols, rows } = game.boardDimensions;
    BOARD_COLS = cols; BOARD_ROWS = rows;
    const initialGameState = { board: [], gameStep: 0, moves: [] };

    // Generate terrain (mountains, forests).
    const newBoard = [];
    for (let row = 0; row < rows; row++) {
        const currentRow = [];
        for (let col = 0; col < cols; col++) {
            const tile = { type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 };
            if (Math.random() < game.settings.mountainPercent / 100) { tile.type = TILE_TYPE.MOUNTAIN; }
            else if (Math.random() < game.settings.forestPercent / 100) { tile.type = TILE_TYPE.FOREST; }
            currentRow.push(tile);
        }
        newBoard.push(currentRow);
    }
    initialGameState.board = newBoard;

    // Place neutral cities with garrisons.
    const baseArea = 40*30;
    const currentArea = cols * rows;
    const numberOfCities = Math.floor(game.settings.cityCount * (currentArea/baseArea));
    let maxNeutralArmy = 1;
    for (let i = 0; i < numberOfCities; i++) {
        let cityRow, cityCol;
        do { cityRow = Math.floor(Math.random() * rows); cityCol = Math.floor(Math.random() * cols); }
        while (initialGameState.board[cityRow][cityCol].type !== TILE_TYPE.EMPTY);
        const cityTile = initialGameState.board[cityRow][cityCol];
        cityTile.type = TILE_TYPE.CITY;
        cityTile.army = 40 + Math.floor(Math.random() * 20);
        if (cityTile.army > maxNeutralArmy) maxNeutralArmy = cityTile.army;
    }

    // Place player Generals.
    const spawnPoints = generateSpawnPoints(game.boardDimensions, game.playerCount);
    // 'Fair Generals' setting gives generals an army count equal to the strongest neutral city.
    const startingArmy = game.settings.fairGenerals ? maxNeutralArmy : 1;
    spawnPoints.forEach(spawn => {
        if (initialGameState.board[spawn.row][spawn.col].type === TILE_TYPE.MOUNTAIN) {
            initialGameState.board[spawn.row][spawn.col].type = TILE_TYPE.EMPTY;
        }
        initialGameState.board[spawn.row][spawn.col] = { type: TILE_TYPE.GENERAL, ownerId: spawn.playerId, army: startingArmy };
    });
    
    // Create the first timeline, the "alpha" timeline.
    const firstTimelineId = 'timeline-alpha';
    game.multiverse[firstTimelineId] = {
        id: firstTimelineId,
        currentState: initialGameState,
        keyframes: [{ step: 0, gameState: JSON.parse(JSON.stringify(initialGameState)) }],
        actions: [],
        isFrozen: false, freezeUntilStep: 0, overclockUntilStep: 0,
        speedMultiplier: 1.0, anchorStep: 0, parentId: null, splitStep: 0,
        isUnravelling: false, unravelCenter: null, unravelRadius: 0
    };
    game.gameState = 'RUNNING';
    io.emit('game-start', { settings: game.settings });
}

/**
 * Applies the consequences of a player action to the game state.
 * For moves, it creates the moving army. For time actions, it deducts the cost.
 * @param {object} gameState - The current state of a timeline.
 * @param {object} action - The action to apply.
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

            const newMove = { 
                ownerId: playerId, 
                army: movingArmy, 
                path: action.path, 
                pathIndex: 0, 
                progress: 0 
            };
            // Propagate causality tags from the source tile to the new army.
            if (startTile.causalityTag) { 
                newMove.causalityTag = startTile.causalityTag; 
            }
            gameState.moves.push(newMove);
            break;
        // All these actions simply deduct cost from the General. The actual effect is handled elsewhere.
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
 * Validates and processes a player's move action.
 * @param {number} playerId - The ID of the player making the move.
 * @param {object} action - The move action object from the client.
 * @param {string} activeTimelineId - The timeline where the move originates.
 * @param {object} game - The main game object.
 */
function processMove(playerId, action, activeTimelineId, game) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline) return;

    const { path, isSplit } = action;
    if (!path || path.length < 2) return;

    const gameState = timeline.currentState;
    const board = gameState.board;

    // Validate the move path: owned by player, not through mountains, etc.
    const startTile = board[path[0].row]?.[path[0].col];
    if (!startTile || startTile.ownerId !== playerId || startTile.army <= 1) return;

    for (let i = 0; i < path.length; i++) {
        const { row, col } = path[i];
        const tile = board[row]?.[col];
        if (!tile || tile.type === TILE_TYPE.MOUNTAIN) return;
        if (i > 0) {
            const prev = path[i - 1];
            if (Math.abs(col - prev.col) + Math.abs(row - prev.row) !== 1) return; // Must be adjacent tiles.
        }
    }

    // This logic currently allows only one move at a time per player.
    // It cancels the old move and returns the army to its last position.
    // This could be changed to support multiple concurrent armies.
    const existingMoveIndex = gameState.moves.findIndex(move => move.ownerId === playerId);
    if (existingMoveIndex !== -1) {
        const oldMove = gameState.moves[existingMoveIndex];
        const currentPos = oldMove.path[oldMove.pathIndex];
        board[currentPos.row][currentPos.col].army += oldMove.army;
        gameState.moves.splice(existingMoveIndex, 1);
    }
    
    // Record the action for history (used in rollbacks) and apply it.
    const actionForHistory = { type: 'MOVE', playerId, path, isSplit };
    timeline.actions.push({ step: gameState.gameStep, action: actionForHistory });
    applyAction(gameState, actionForHistory);
}


// --- 5. GAME SIMULATION LOGIC (THE "TICK") ---

/**
 * Executes a single tick of game logic for a given timeline.
 * This includes processing moves, combat, and resource generation.
 * @param {object} currentGameState - The state of the timeline to update.
 * @param {string} timelineId - The ID of the timeline.
 * @param {object} game - The main game object.
 */
function runSingleTickLogic(currentGameState, timelineId, game) {
    // --- A. Process Army Movements & Combat ---
    // Iterate backwards because we might be removing items from the array.
    for (let i = currentGameState.moves.length - 1; i >= 0; i--) {
        const move = currentGameState.moves[i];
        move.progress++;

        // When progress reaches MOVE_TICKS, the army arrives at the next tile in its path.
        if (move.progress >= MOVE_TICKS) {
            move.progress = 0;

            const leavingPos = move.path[move.pathIndex];
            const isFinalSegment = move.pathIndex >= move.path.length - 2;
            const arrivingPos = move.path[move.pathIndex + 1];

            if (!arrivingPos) { // Should not happen with valid paths, but a safeguard.
                currentGameState.moves.splice(i, 1);
                continue;
            }

            const leavingTile = currentGameState.board[leavingPos.row][leavingPos.col];
            const arrivingTile = currentGameState.board[arrivingPos.row][arrivingPos.col];

            // "Snowballing": Pick up troops from friendly tiles along the path.
            // This is a FIX: It only snowballs from INTERMEDIATE tiles, not the origin tile.
            if (leavingTile.ownerId === move.ownerId && move.pathIndex > 0) {
                move.army += leavingTile.army - 1;
                leavingTile.army = 1; // Leave 1 troop behind to maintain ownership.
            }

            const propagateTag = () => { if (move.causalityTag) { arrivingTile.causalityTag = move.causalityTag; } };

            // Combat logic:
            if (arrivingTile.ownerId !== move.ownerId) { // Attacking an enemy or neutral tile.
                if (move.army > arrivingTile.army) { // Attack succeeds.
                    move.army -= arrivingTile.army;
                    if (arrivingTile.type === TILE_TYPE.GENERAL) { handlePlayerDefeat(move.ownerId, arrivingTile.ownerId, currentGameState); }
                    arrivingTile.ownerId = move.ownerId;
                    
                    if (isFinalSegment) { // If it's the last step, drop off the whole army.
                        arrivingTile.army = move.army; 
                    } else { // If path continues, leave 1 behind and keep moving.
                        if (move.army > 1) { arrivingTile.army = 1; move.army -= 1; }
                        else { arrivingTile.army = move.army; currentGameState.moves.splice(i, 1); }
                    }
                    propagateTag(); // The captured tile inherits any causality tag.
                } else { // Attack fails.
                    arrivingTile.army -= move.army;
                    currentGameState.moves.splice(i, 1); // Moving army is destroyed.
                }
            } else { // Reinforcing a friendly tile.
                if (isFinalSegment) { // Last step, merge with existing army.
                    arrivingTile.army += move.army; 
                    propagateTag(); 
                } else { // Path continues, pick up troops and move on.
                    move.army += arrivingTile.army - 1; 
                    arrivingTile.army = 1; 
                    propagateTag(); 
                }
            }

            // --- B. Portal Logic ---
            if (isFinalSegment) {
                let moveConsumedByPortal = false;
                // Check if the destination tile has an active portal.
                const portal = game.portals.find(p => p.fromTimelineId === timelineId && p.coords.row === arrivingPos.row && p.coords.col === arrivingPos.col);
                if (portal) {
                    const toTimeline = game.multiverse[portal.toTimelineId];
                    if (toTimeline) {
                        // Find a valid spot to emerge in the destination timeline.
                        const exitTilePos = findValidAdjacentTile(portal.coords, toTimeline.currentState);
                        if (exitTilePos) {
                            const newPath = [portal.coords, exitTilePos];
                            // Create a causality tag to track this army's origin.
                            const causalityTag = { originTimelineId: timelineId, originStep: currentGameState.gameStep };
                            // Create a new move in the destination timeline.
                            const newMove = { ownerId: move.ownerId, army: move.army, path: newPath, pathIndex: 0, progress: 0, causalityTag };
                            toTimeline.currentState.moves.push(newMove);
                            moveConsumedByPortal = true;
                        } else {
                            arrivingTile.army += move.army; // Portal exit is blocked, reinforce instead.
                        }
                    }
                }
                
                if (moveConsumedByPortal) {
                    arrivingTile.army -= move.army; // Army went through portal, so remove it from this tile.
                }
                
                currentGameState.moves.splice(i, 1); // Move is complete.
            } else {
                if (currentGameState.moves.includes(move)) {
                    move.pathIndex++; // Advance to the next segment of the path.
                }
            }
        }
    }
    
    // --- C. Resource Generation ---
    currentGameState.gameStep++;
    for (let row = 0; row < BOARD_ROWS; row++) {
        for (let col = 0; col < BOARD_COLS; col++) {
            const tile = currentGameState.board[row][col];
            if (tile.ownerId !== 0) { // If the tile is owned.
                if (tile.type === TILE_TYPE.GENERAL || tile.type === TILE_TYPE.CITY) {
                    if (currentGameState.gameStep % 2 === 0) tile.army++; // Generals and Cities generate 1 army per 2 ticks.
                } else if (tile.type === TILE_TYPE.EMPTY || tile.type === TILE_TYPE.FOREST) {
                    if (currentGameState.gameStep % 20 === 0) tile.army++; // Land generates 1 army every 20 ticks.
                }
            }
        }
    }
}


// --- 6. TIME MANIPULATION & OTHER SYSTEMS ---
// These functions are called by the main game loop or socket handlers.
// ... (splitTimeline, findValidAdjacentTile, etc. are complex but well-defined actions) ...
function splitTimeline(playerId, activeTimelineId, game) { const timeline = game.multiverse[activeTimelineId]; if (!timeline) return; const numTimelines = Object.keys(game.multiverse).length; const splitCost = Math.floor(TIME_ACTION_COST.SPLIT_BASE * Math.pow(1.25, numTimelines - 1)); const generalInfo = findGeneral(playerId, timeline.currentState); if (!generalInfo || generalInfo.tile.army < splitCost) return; const action = { type: 'SPLIT', playerId, cost: splitCost }; timeline.actions.push({ step: timeline.currentState.gameStep, action }); applyAction(timeline.currentState, action); const newGameState = JSON.parse(JSON.stringify(timeline.currentState)); const newTimelineId = `timeline-${Date.now()}`; game.multiverse[newTimelineId] = { id: newTimelineId, currentState: newGameState, keyframes: [{ step: newGameState.gameStep, gameState: JSON.parse(JSON.stringify(newGameState)) }], actions: timeline.actions.filter(a => a.step <= newGameState.gameStep), isFrozen: false, freezeUntilStep: 0, overclockUntilStep: 0, speedMultiplier: 1.0, anchorStep: newGameState.gameStep, parentId: activeTimelineId, splitStep: timeline.currentState.gameStep, isUnravelling: false, unravelCenter: null, unravelRadius: 0 }; }
function findValidAdjacentTile(coords, currentGameState) { const { row, col } = coords; const directions = [ {r: -1, c: 0}, {r: 1, c: 0}, {r: 0, c: -1}, {r: 0, c: 1} ]; for (const dir of directions) { const r = row + dir.r; const c = col + dir.c; if (r >= 0 && r < BOARD_ROWS && c >= 0 && c < BOARD_COLS) { const neighborTile = currentGameState.board[r][c]; if (neighborTile.type !== TILE_TYPE.MOUNTAIN) { return { row: r, col: c }; } } } return null; }
function calculatePlayerStats(game) { const stats = { global: {} }; for (const playerSocketId in game.players) { const player = game.players[playerSocketId]; stats.global[player.id] = { army: 0 }; } for (const timelineId in game.multiverse) { stats[timelineId] = {}; for (const playerSocketId in game.players) { const player = game.players[playerSocketId]; stats[timelineId][player.id] = { army: 0 }; } const gameState = game.multiverse[timelineId].currentState; for (let row = 0; row < BOARD_ROWS; row++) { for (let col = 0; col < BOARD_COLS; col++) { const tile = gameState.board[row][col]; if (tile.ownerId !== 0 && stats[timelineId][tile.ownerId]) { stats[timelineId][tile.ownerId].army += tile.army; stats.global[tile.ownerId].army += tile.army; } } } for (const move of gameState.moves) { if (move.ownerId !== 0 && stats[timelineId][move.ownerId]) { stats[timelineId][move.ownerId].army += move.army; stats.global[move.ownerId].army += move.army; } } } return stats; }
function gameLoop(game) { const activePlayers = new Set(); for (const timelineId in game.multiverse) { const timeline = game.multiverse[timelineId]; if (timeline.isUnravelling) continue; const currentGameState = timeline.currentState; for (let row = 0; row < BOARD_ROWS; row++) { for (let col = 0; col < BOARD_COLS; col++) { const tile = currentGameState.board[row][col]; if (tile.type === TILE_TYPE.GENERAL && tile.ownerId !== 0) { activePlayers.add(tile.ownerId); } } } } if (activePlayers.size <= 1 && game.playerCount > 1 && game.gameState === 'RUNNING') { const winnerId = activePlayers.values().next().value || "No one"; io.emit('game-over', { winnerId }); clearTimeout(game.gameInterval); game.gameState = 'FINISHED'; setTimeout(() => { const connectedSockets = new Map(io.sockets.sockets); game = createNewGame(); let i = 1; connectedSockets.forEach((socket, socketId) => { const color = PLAYER_COLORS[(i-1) % PLAYER_COLORS.length]; game.players[socketId] = { id: i, name: `Player ${i}`, color: color, isReady: false }; if (game.hostId === null) { game.hostId = socket.id; } socket.emit('player-assignment', {playerId: i, color: color}); i++; }); game.playerCount = Object.keys(game.players).length; const hostPlayerId = game.players[game.hostId]?.id; io.emit('lobby-update', { players: Object.values(game.players), settings: game.settings, hostPlayerId }); }, 10000); return; } const masterClock = game.multiverse['timeline-alpha'] ? game.multiverse['timeline-alpha'].currentState.gameStep : 0; game.portals = game.portals.filter(p => p.expiresOnStep > masterClock); paradoxHandler(game); game.paradoxEvents = game.paradoxEvents.filter(event => { event.duration--; return event.duration > 0; }); const timelineIds = Object.keys(game.multiverse); for (const timelineId of timelineIds) { const timeline = game.multiverse[timelineId]; if (!timeline) continue; if (timeline.isFrozen && timeline.currentState.gameStep >= timeline.freezeUntilStep) { timeline.isFrozen = false; timeline.freezeUntilStep = 0; } if (timeline.speedMultiplier > 1.0 && timeline.currentState.gameStep >= timeline.overclockUntilStep) { timeline.speedMultiplier = 1.0; timeline.overclockUntilStep = 0; } for (let i = 0; i < timeline.speedMultiplier; i++) { updateTimeline(timeline, timelineId, game); } } }
function updateTimeline(timeline, timelineId, game) { if (timeline.isFrozen || timeline.isUnravelling) { if (!timeline.isUnravelling) timeline.currentState.gameStep++; return; } runSingleTickLogic(timeline.currentState, timelineId, game); if (timeline.currentState.gameStep % KEYFRAME_INTERVAL === 0) { timeline.keyframes.push({ step: timeline.currentState.gameStep, gameState: JSON.parse(JSON.stringify(timeline.currentState)) }); if (timeline.keyframes.length > 30) { timeline.keyframes.shift(); } } }
function paradoxHandler(game) { for (const timelineId in game.multiverse) { const timeline = game.multiverse[timelineId]; if (timeline.isUnravelling) { timeline.unravelRadius += 1; const { unravelCenter, unravelRadius } = timeline; let tilesRemaining = false; for (let row = 0; row < BOARD_ROWS; row++) { for (let col = 0; col < BOARD_COLS; col++) { const tile = timeline.currentState.board[row][col]; if (tile.type !== TILE_TYPE.ERASED) { const dist = Math.sqrt(Math.pow(row - unravelCenter.row, 2) + Math.pow(col - unravelCenter.col, 2)); if (dist <= unravelRadius) { tile.type = TILE_TYPE.ERASED; tile.army = 0; tile.ownerId = 0; } else { tilesRemaining = true; } } } } if (!tilesRemaining) { delete game.multiverse[timelineId]; } } } for (const timelineId in game.multiverse) { const timeline = game.multiverse[timelineId]; const currentGameState = timeline.currentState; for (let row = 0; row < BOARD_ROWS; row++) { for (let col = 0; col < BOARD_COLS; col++) { const tile = currentGameState.board[row][col]; if (tile.causalityTag) { const origin = game.multiverse[tile.causalityTag.originTimelineId]; if (!origin || origin.currentState.gameStep < tile.causalityTag.originStep || origin.isUnravelling) { tile.army = 0; delete tile.causalityTag; game.paradoxEvents.push({ timelineId, coords: { row, col }, duration: 10 }); } } } } for (let i = currentGameState.moves.length - 1; i >= 0; i--) { const move = currentGameState.moves[i]; if (move.causalityTag) { const origin = game.multiverse[move.causalityTag.originTimelineId]; if (!origin || origin.currentState.gameStep < move.causalityTag.originStep || origin.isUnravelling) { const coords = move.path[move.pathIndex]; game.paradoxEvents.push({ timelineId, coords, duration: 10 }); currentGameState.moves.splice(i, 1); } } } } }
function freezeTimeline(playerId, activeTimelineId, game, duration, cost) { const timeline = game.multiverse[activeTimelineId]; if (!timeline) return; const generalInfo = findGeneral(playerId, timeline.currentState); if (!generalInfo || generalInfo.tile.army < cost) return; const action = { type: 'FREEZE', playerId, cost, duration }; timeline.actions.push({ step: timeline.currentState.gameStep, action }); applyAction(timeline.currentState, action); timeline.freezeUntilStep = timeline.currentState.gameStep + duration; timeline.isFrozen = true; }
function overclockTimeline(playerId, activeTimelineId, game, duration, cost) { const timeline = game.multiverse[activeTimelineId]; if (!timeline) return; const generalInfo = findGeneral(playerId, timeline.currentState); if (!generalInfo || generalInfo.tile.army < cost) return; const action = { type: 'OVERCLOCK', playerId, cost, duration }; timeline.actions.push({ step: timeline.currentState.gameStep, action }); applyAction(timeline.currentState, action); timeline.overclockUntilStep = timeline.currentState.gameStep + duration; timeline.speedMultiplier = 2.0; }
function rollbackTimeline(playerId, activeTimelineId, targetStep, game) { const timeline = game.multiverse[activeTimelineId]; if (!timeline) return; if (targetStep < timeline.anchorStep || targetStep >= timeline.currentState.gameStep) return; const lastKeyframe = [...timeline.keyframes].reverse().find(kf => kf.step <= targetStep); if (!lastKeyframe) { return; } let preSimState = JSON.parse(JSON.stringify(lastKeyframe.gameState)); const actionsToReplay = timeline.actions.filter(a => a.step > lastKeyframe.step && a.step <= targetStep); for (let step = lastKeyframe.step; step < targetStep; step++) { for (const actionRecord of actionsToReplay) { if (actionRecord.step === step) { applyAction(preSimState, actionRecord.action); } } runSingleTickLogic(preSimState, activeTimelineId, game); } const generalInPast = findGeneral(playerId, preSimState); const stepsToRollback = timeline.currentState.gameStep - targetStep; const rollbackCost = Math.floor(10 * Math.pow(1.05, stepsToRollback / 10)); if (!generalInPast || generalInPast.tile.army < rollbackCost) { return; } generalInPast.tile.army -= rollbackCost; timeline.currentState = preSimState; timeline.actions = timeline.actions.filter(a => a.step <= targetStep); timeline.keyframes = timeline.keyframes.filter(kf => kf.step <= targetStep); const unravelQueue = []; for (const otherTimelineId in game.multiverse) { const otherTimeline = game.multiverse[otherTimelineId]; if (otherTimeline.parentId === activeTimelineId && otherTimeline.splitStep > timeline.currentState.gameStep) { if (!unravelQueue.includes(otherTimeline.id)) { unravelQueue.push(otherTimeline.id); } } } let i = 0; while (i < unravelQueue.length) { const parentIdToUnravel = unravelQueue[i]; i++; for (const childId in game.multiverse) { const childTimeline = game.multiverse[childId]; if (childTimeline.parentId === parentIdToUnravel) { if (!unravelQueue.includes(childTimeline.id)) { unravelQueue.push(childTimeline.id); } } } } for (const timelineIdToUnravel of unravelQueue) { const timelineToUnravel = game.multiverse[timelineIdToUnravel]; if (timelineToUnravel) { timelineToUnravel.isUnravelling = true; timelineToUnravel.unravelCenter = { row: Math.floor(BOARD_ROWS / 2), col: Math.floor(BOARD_COLS / 2) }; } } }
function anchorTimeline(playerId, activeTimelineId, game) { const timeline = game.multiverse[activeTimelineId]; if (!timeline) return; const generalInfo = findGeneral(playerId, timeline.currentState); if (!generalInfo || generalInfo.tile.army < TIME_ACTION_COST.ANCHOR) return; const action = { type: 'ANCHOR', playerId }; timeline.actions.push({ step: timeline.currentState.gameStep, action }); applyAction(timeline.currentState, action); timeline.anchorStep = timeline.currentState.gameStep; }
function openPortal(playerId, activeTimelineId, selectedTile, game, duration, cost) { const fromTimeline = game.multiverse[activeTimelineId]; if (!fromTimeline || !selectedTile) return; const fromGameState = fromTimeline.currentState; const portalTile = fromGameState.board[selectedTile.row][selectedTile.col]; if (portalTile.ownerId !== playerId) return; const generalInfo = findGeneral(playerId, fromGameState); if (!generalInfo || generalInfo.tile.army < cost) return; const targetableTimelines = Object.keys(game.multiverse).filter(id => id !== activeTimelineId); if (targetableTimelines.length === 0) return; const action = { type: 'HOP', playerId, cost, duration }; fromTimeline.actions.push({ step: fromGameState.gameStep, action }); applyAction(fromGameState, action); const toTimelineId = targetableTimelines[0]; const portalCoords = { row: selectedTile.row, col: selectedTile.col }; const expiresOnStep = fromGameState.gameStep + duration; game.portals.push({ fromTimelineId: activeTimelineId, toTimelineId: toTimelineId, coords: portalCoords, expiresOnStep: expiresOnStep }); game.portals.push({ fromTimelineId: toTimelineId, toTimelineId: activeTimelineId, coords: portalCoords, expiresOnStep: expiresOnStep }); }
function findGeneral(playerId, currentGameState) { for (let row = 0; row < BOARD_ROWS; row++) { for (let col = 0; col < BOARD_COLS; col++) { const tile = currentGameState.board[row][col]; if (tile.type === TILE_TYPE.GENERAL && tile.ownerId === playerId) return { row, col, tile }; } } return null; }
function handlePlayerDefeat(victorId, defeatedId, currentGameState) { for (let row = 0; row < BOARD_ROWS; row++) { for (let col = 0; col < BOARD_COLS; col++) { if (currentGameState.board[row][col].ownerId === defeatedId) currentGameState.board[row][col].ownerId = victorId; } } for (let i = currentGameState.moves.length - 1; i >= 0; i--) { if (currentGameState.moves[i].ownerId === defeatedId) { currentGameState.moves.splice(i, 1); } } }
function calculateVisibility(playerId, game) { const visibilityGrid = Array(BOARD_ROWS).fill(null).map(() => Array(BOARD_COLS).fill(false)); if (!game.settings.fogOfWar) { return visibilityGrid.map(row => row.fill(true)); } const visibilityRadius = 2; for(const timelineId in game.multiverse){ const currentGameState = game.multiverse[timelineId].currentState; for (let row = 0; row < BOARD_ROWS; row++) { for (let col = 0; col < BOARD_COLS; col++) { if (currentGameState.board[row][col].ownerId === playerId) { for (let scanRow = row - visibilityRadius; scanRow <= row + visibilityRadius; scanRow++) { for (let scanCol = col - visibilityRadius; scanCol <= col + visibilityRadius; scanCol++) { if (scanRow >= 0 && scanRow < BOARD_ROWS && scanCol >= 0 && scanCol < BOARD_COLS) visibilityGrid[scanRow][scanCol] = true; } } } } } } return visibilityGrid; }

// --- 7. SOCKET.IO EVENT HANDLING ---
// This is the main entry point for all client communication.
io.on('connection', (socket) => {
    // Reject connections if the game is full or already in progress.
    if (game.playerCount >= MAX_PLAYERS || game.gameState === 'RUNNING') {
        socket.emit('game-in-progress');
        socket.disconnect();
        return;
    }

    // A. New Player Connection
    game.playerCount++;
    const playerId = game.playerCount;
    const color = PLAYER_COLORS[(playerId - 1) % PLAYER_COLORS.length];
    game.players[socket.id] = { id: playerId, name: `Player ${playerId}`, color: color, isReady: false };

    // The first player to connect becomes the host.
    if (game.hostId === null) {
        game.hostId = socket.id;
    }

    // Send the new player their ID and color.
    socket.emit('player-assignment', { playerId, color });
    // Update everyone's lobby view.
    const hostPlayerId = game.players[game.hostId]?.id;
    io.emit('lobby-update', { players: Object.values(game.players), settings: game.settings, hostPlayerId });

    // B. Host Game Settings Update
    socket.on('update-game-settings', (newSettings) => {
        // Only the host can change settings, and only in the lobby.
        if (socket.id === game.hostId && game.gameState === 'LOBBY') {
            game.settings.fogOfWar = !!newSettings.fogOfWar;
            game.settings.staggeredStart = !!newSettings.staggeredStart;
            game.settings.fairGenerals = !!newSettings.fairGenerals;
            game.settings.mountainPercent = Math.max(0, Math.min(50, parseInt(newSettings.mountainPercent) || 0));
            game.settings.forestPercent = Math.max(0, Math.min(50, parseInt(newSettings.forestPercent) || 0));
            game.settings.cityCount = Math.max(0, Math.min(20, parseInt(newSettings.cityCount) || 0));
            const hostPlayerId = game.players[game.hostId]?.id;
            io.emit('lobby-update', { players: Object.values(game.players), settings: game.settings, hostPlayerId });
        }
    });

    // C. Player Ready Status
    socket.on('player-ready', (isReady) => {
        if (game.gameState !== 'LOBBY') return;
        const player = game.players[socket.id];
        if (player) {
            player.isReady = isReady;
            const hostPlayerId = game.players[game.hostId]?.id;
            io.emit('lobby-update', { players: Object.values(game.players), settings: game.settings, hostPlayerId });

            const allPlayers = Object.values(game.players);
            // Check if all connected players are ready (and there are at least 2).
            const allReady = allPlayers.length > 0 && allPlayers.every(p => p.isReady);

            if (allReady && allPlayers.length >= 2) {
                initializeGame(game);
                
                // The dynamic game loop: tick speed is affected by the number of active timelines.
                const dynamicGameLoop = () => {
                    if (game.gameState !== 'RUNNING') return;
                    const activeTimelinesCount = Object.values(game.multiverse).filter(t => !t.isFrozen).length || 1;
                    const tickDuration = GAME_TICK_MS * activeTimelinesCount;
                    
                    gameLoop(game); // Run the main simulation.

                    const playerStats = calculatePlayerStats(game);

                    // Send personalized game state updates to each player (respecting fog of war).
                    for (const socketId in game.players) {
                        if (io.sockets.sockets.get(socketId)) {
                            const player = game.players[socketId];
                            const visibilityGrid = calculateVisibility(player.id, game);
                            const personalizedState = {
                                multiverse: game.multiverse,
                                portals: game.portals,
                                paradoxEvents: game.paradoxEvents,
                                visibilityGrid: visibilityGrid,
                                boardDimensions: game.boardDimensions,
                                playerStats: playerStats,
                                settings: game.settings
                            };
                            io.to(socketId).emit('game-state-update', personalizedState);
                        }
                    }
                    // Schedule the next tick.
                    if (game.gameState === 'RUNNING') {
                        game.gameInterval = setTimeout(dynamicGameLoop, tickDuration);
                    }
                };
                dynamicGameLoop();
            }
        }
    });
    
    // D. Affordability and Info Requests
    // These handlers allow the client to ask "Can I afford this?" before showing the final confirmation modal.
    socket.on('get-rollback-info', ({ activeTimelineId }) => { const player = game.players[socket.id]; if (!player) return; const timeline = game.multiverse[activeTimelineId]; if (!timeline) return; let oldestAffordableStep = timeline.currentState.gameStep; for (let step = timeline.currentState.gameStep -1; step >= timeline.anchorStep; step--) { const lastKeyframe = [...timeline.keyframes].reverse().find(kf => kf.step <= step); if (!lastKeyframe) break; let tempState = JSON.parse(JSON.stringify(lastKeyframe.gameState)); const actionsToReplay = timeline.actions.filter(a => a.step > lastKeyframe.step && a.step <= step); for (let s = lastKeyframe.step; s < step; s++) { for (const actionRecord of actionsToReplay) { if (actionRecord.step === s) applyAction(tempState, actionRecord.action); } runSingleTickLogic(tempState, activeTimelineId, game); } const generalInPast = findGeneral(player.id, tempState); const stepsToRollback = timeline.currentState.gameStep - step; const cost = Math.floor(10 * Math.pow(1.05, stepsToRollback / 10)); if (generalInPast && generalInPast.tile.army >= cost) { oldestAffordableStep = step; } else { break; } } socket.emit('rollback-info-response', { oldestAffordableStep }); });
    socket.on('get-affordability-info', ({ actionType, activeTimelineId }) => { const player = game.players[socket.id]; if (!player) return; const timeline = game.multiverse[activeTimelineId]; if (!timeline) return; const generalInfo = findGeneral(player.id, timeline.currentState); if (!generalInfo) return; const generalArmy = generalInfo.tile.army; const costCalculator = COST_CALCULATORS[actionType]; if (!costCalculator) return; let maxDuration = 0; for (let d = 1; d < 500; d++) { if (costCalculator(d) <= generalArmy) { maxDuration = d; } else { break; } } socket.emit('affordability-info-response', { actionType, maxDuration }); });
    
    // E. Player Action Handler
    socket.on('player-action', (action) => {
        if (game.gameState !== 'RUNNING') return;
        const player = game.players[socket.id];
        if (!player) return;

        // Route the action to the appropriate handler function.
        switch (action.type) {
            case 'MOVE':
                processMove(player.id, action, action.activeTimelineId, game);
                break;
            case 'SPLIT':
                splitTimeline(player.id, action.activeTimelineId, game);
                break;
            case 'FREEZE':
                freezeTimeline(player.id, action.activeTimelineId, game, action.duration, action.cost);
                break;
            case 'OVERCLOCK':
                overclockTimeline(player.id, action.activeTimelineId, game, action.duration, action.cost);
                break;
            case 'ROLLBACK':
                rollbackTimeline(player.id, action.activeTimelineId, action.targetStep, game);
                break;
            case 'ANCHOR':
                anchorTimeline(player.id, action.activeTimelineId, game);
                break;
            case 'HOP':
                openPortal(player.id, action.activeTimelineId, action.selectedTile, game, action.duration, action.cost);
                break;
        }
    });

    // F. Player Disconnection
    socket.on('disconnect', () => {
        const disconnectedPlayer = game.players[socket.id];
        if (disconnectedPlayer) {
            // If the game is running, treat the disconnection as a defeat.
            if (game.gameState === 'RUNNING') {
                const disconnectedPlayerId = disconnectedPlayer.id;
                for (const timelineId in game.multiverse) {
                    const timeline = game.multiverse[timelineId];
                    // Turn all their tiles neutral (ownerId 0).
                    handlePlayerDefeat(0, disconnectedPlayerId, timeline.currentState); 
                }
            }
            delete game.players[socket.id];
            game.playerCount--;

            // If the host disconnects, assign a new host.
            if (socket.id === game.hostId) {
                const newHostSocket = Object.keys(game.players)[0];
                game.hostId = newHostSocket || null;
            }

            // Update the lobby or player list for remaining players.
            if (game.gameState === 'LOBBY') {
                const hostPlayerId = game.players[game.hostId]?.id;
                 io.emit('lobby-update', { players: Object.values(game.players), settings: game.settings, hostPlayerId });
            } else {
                 io.emit('player-list-update', Object.values(game.players));
            }
        }
        
        // If not enough players remain, end the game.
        if (game.gameState === 'RUNNING' && game.playerCount < 2) {
            clearTimeout(game.gameInterval);
            io.emit('game-over', { winnerId: 'none', reason: 'Not enough players.' });
            game = createNewGame(); // Reset to lobby.
        }
    });
});

// --- 8. START THE SERVER ---
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});