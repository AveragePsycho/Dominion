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

let BOARD_COLS = 40, BOARD_ROWS = 30;
const GAME_TICK_MS = 500, MOVE_TICKS = 2, KEYFRAME_INTERVAL = 60;
const TIME_ACTION_COST = { SPLIT: 50, FREEZE: 30, OVERCLOCK: 40, ANCHOR: 25, HOP: 75 };
const TIME_ACTION_DURATION = { FREEZE_TICKS: 20, OVERCLOCK_TICKS: 20, HOP_TICKS: 30 };
const TILE_TYPE = { EMPTY: 0, MOUNTAIN: 1, CITY: 2, GENERAL: 3, FOREST: 4 };
const PLAYER_COLORS = ['#007bff', '#dc3545', '#28a745', '#ffc107', '#17a2b8', '#6f42c1', '#fd7e14', '#e83e8c'];
let game = createNewGame();

function createNewGame() {
    return {
        multiverse: {}, portals: [], paradoxEvents: [], players: {}, playerCount: 0,
        gameInterval: null, boardDimensions: { cols: BOARD_COLS, rows: BOARD_ROWS }, isGameRunning: false
    };
}

function calculateMapDimensions(playerCount) {
    const baseArea = 40 * 30;
    const requiredArea = baseArea * (1 + (playerCount - 2) * 0.5);
    const ratio = 16 / 9;
    const newCols = Math.round(Math.sqrt(requiredArea * ratio));
    const newRows = Math.round(newCols / ratio);
    return { cols: newCols, rows: newRows };
}

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
                if (dist < minDistance) { tooClose = true; break; }
            }
            if (!tooClose) { validSpawn = true; }
            attempts++;
        }
        spawnPoints.push({ row: spawnRow, col: spawnCol, playerId: i });
    }
    return spawnPoints;
}

function initializeGame(game) {
    game.boardDimensions = calculateMapDimensions(game.playerCount);
    const { cols, rows } = game.boardDimensions;
    BOARD_COLS = cols; BOARD_ROWS = rows;
    const initialGameState = { board: [], gameStep: 0, moves: [] };
    const newBoard = [];
    for (let row = 0; row < rows; row++) {
        const currentRow = [];
        for (let col = 0; col < cols; col++) {
            const tile = { type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 };
            if (Math.random() < 0.1) { tile.type = TILE_TYPE.MOUNTAIN; }
            else if (Math.random() < 0.15) { tile.type = TILE_TYPE.FOREST; }
            currentRow.push(tile);
        }
        newBoard.push(currentRow);
    }
    initialGameState.board = newBoard;
    const numberOfCities = Math.floor((cols * rows) / 150);
    for (let i = 0; i < numberOfCities; i++) {
        let cityRow, cityCol;
        do { cityRow = Math.floor(Math.random() * rows); cityCol = Math.floor(Math.random() * cols); }
        while (initialGameState.board[cityRow][cityCol].type !== TILE_TYPE.EMPTY);
        const cityTile = initialGameState.board[cityRow][cityCol];
        cityTile.type = TILE_TYPE.CITY; cityTile.army = 40 + Math.floor(Math.random() * 20);
    }
    const spawnPoints = generateSpawnPoints(game.boardDimensions, game.playerCount);
    spawnPoints.forEach(spawn => {
        if (initialGameState.board[spawn.row][spawn.col].type === TILE_TYPE.MOUNTAIN) {
            initialGameState.board[spawn.row][spawn.col].type = TILE_TYPE.EMPTY;
        }
        initialGameState.board[spawn.row][spawn.col] = { type: TILE_TYPE.GENERAL, ownerId: spawn.playerId, army: 1 };
    });
    
    const firstTimelineId = 'timeline-alpha';
    game.multiverse[firstTimelineId] = {
        id: firstTimelineId,
        currentState: initialGameState,
        keyframes: [{ step: 0, gameState: JSON.parse(JSON.stringify(initialGameState)) }],
        actions: [],
        isFrozen: false, freezeUntilStep: 0, overclockUntilStep: 0,
        speedMultiplier: 1.0, anchorStep: 0, parentId: null, splitStep: 0,
    };
    game.isGameRunning = true;
    io.emit('game-start');
}

function runSingleTickLogic(currentGameState, timelineId, game) {
    for (let i = currentGameState.moves.length - 1; i >= 0; i--) {
        const move = currentGameState.moves[i];
        move.progress++;

        if (move.progress >= MOVE_TICKS) {
            move.progress = 0;

            const leavingPos = move.path[move.pathIndex];
            const isFinalSegment = move.pathIndex >= move.path.length - 2;
            const arrivingPos = move.path[move.pathIndex + 1];

            if (!arrivingPos) { // Clean up malformed or finished moves
                currentGameState.moves.splice(i, 1);
                continue;
            }

            const leavingTile = currentGameState.board[leavingPos.row][leavingPos.col];
            const arrivingTile = currentGameState.board[arrivingPos.row][arrivingPos.col];

            // Snowball mechanic: absorb troops from the tile the army is leaving.
            if (leavingTile.ownerId === move.ownerId) {
                move.army += leavingTile.army - 1;
                leavingTile.army = 1;
            }

            const propagateTag = () => {
                if (move.causalityTag) {
                    arrivingTile.causalityTag = move.causalityTag;
                }
            };

            // --- Arrival Logic ---
            if (arrivingTile.ownerId !== move.ownerId) { // Combat
                if (move.army > arrivingTile.army) {
                    move.army -= arrivingTile.army;
                    if (arrivingTile.type === TILE_TYPE.GENERAL) {
                        handlePlayerDefeat(move.ownerId, arrivingTile.ownerId, currentGameState);
                    }
                    arrivingTile.ownerId = move.ownerId;
                    
                    if (isFinalSegment) {
                        arrivingTile.army = move.army;
                    } else {
                        // If there's enough army to continue, leave 1 and move on
                        if (move.army > 1) {
                            arrivingTile.army = 1;
                            move.army -= 1;
                        } else { // Otherwise, the move ends here
                            arrivingTile.army = move.army;
                            currentGameState.moves.splice(i, 1);
                        }
                    }
                    propagateTag();
                } else { // Attacker loses
                    arrivingTile.army -= move.army;
                    currentGameState.moves.splice(i, 1);
                }
            } else { // Reinforcing a friendly tile
                if (isFinalSegment) {
                    arrivingTile.army += move.army;
                    propagateTag();
                } else {
                    // "Pass over" logic: moving army absorbs the friendly tile's army and continues
                    move.army += arrivingTile.army - 1;
                    arrivingTile.army = 1;
                    propagateTag();
                }
            }

            // --- Post-Arrival Logic ---
            if (isFinalSegment) {
                // Portal check for moves that are finishing
                const portal = game.portals.find(p => p.fromTimelineId === timelineId && p.coords.row === arrivingPos.row && p.coords.col === arrivingPos.col);
                if (portal) {
                    const toTimeline = game.multiverse[portal.toTimelineId];
                    if (toTimeline) {
                        const exitTile = findValidAdjacentTile(portal.coords, toTimeline.currentState);
                        if (exitTile) {
                            const newPath = [exitTile];
                            const causalityTag = { originTimelineId: timelineId, originStep: currentGameState.gameStep };
                            const newMove = { ownerId: move.ownerId, army: move.army, path: newPath, pathIndex: 0, progress: 0, causalityTag };
                            toTimeline.currentState.moves.push(newMove);
                        } else {
                            arrivingTile.army += move.army; // Portal exit is blocked, refund army
                        }
                    }
                }
                currentGameState.moves.splice(i, 1); // The move is completed
            } else {
                // If the move was not spliced, it continues to the next segment
                if (currentGameState.moves.includes(move)) {
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
                if (tile.type === TILE_TYPE.GENERAL || tile.type === TILE_TYPE.CITY) {
                    if (currentGameState.gameStep % 1 === 0) tile.army++;
                } else if (tile.type === TILE_TYPE.EMPTY || tile.type === TILE_TYPE.FOREST) {
                    if (currentGameState.gameStep % 4 === 0) tile.army++;
                }
            }
        }
    }
}


function applyAction(gameState, action) {
    const { type, playerId } = action;
    const generalInfo = findGeneral(playerId, gameState);

    switch (type) {
        case 'MOVE':
            const startTile = gameState.board[action.path[0].row][action.path[0].col];
            if (startTile.army <= 1) break;
            const movingArmy = startTile.army - 1;
            startTile.army = 1;
            const newMove = { ownerId: playerId, army: movingArmy, path: action.path, pathIndex: 0, progress: 0 };
            if (startTile.causalityTag) { 
                newMove.causalityTag = startTile.causalityTag; 
            }
            gameState.moves.push(newMove);
            break;
        case 'SPLIT':
            if (generalInfo) generalInfo.tile.army -= TIME_ACTION_COST.SPLIT;
            break;
        case 'FREEZE':
            if (generalInfo) generalInfo.tile.army -= TIME_ACTION_COST.FREEZE;
            break;
        case 'OVERCLOCK':
            if (generalInfo) generalInfo.tile.army -= TIME_ACTION_COST.OVERCLOCK;
            break;
        case 'ANCHOR':
            if (generalInfo) generalInfo.tile.army -= TIME_ACTION_COST.ANCHOR;
            break;
        case 'HOP':
            if (generalInfo) generalInfo.tile.army -= TIME_ACTION_COST.HOP;
            break;
    }
}

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
    return stats;
}

function gameLoop(game) {
    const activePlayers = new Set();
    for (const timelineId in game.multiverse) {
        const currentGameState = game.multiverse[timelineId].currentState;
        for (let row = 0; row < BOARD_ROWS; row++) {
            for (let col = 0; col < BOARD_COLS; col++) {
                const tile = currentGameState.board[row][col];
                if (tile.type === TILE_TYPE.GENERAL && tile.ownerId !== 0) {
                    activePlayers.add(tile.ownerId);
                }
            }
        }
    }

    if (activePlayers.size <= 1 && game.playerCount > 1 && game.isGameRunning) {
        const winnerId = activePlayers.values().next().value || "No one";
        io.emit('game-over', { winnerId });
        clearTimeout(game.gameInterval);
        game.isGameRunning = false;
        setTimeout(() => {
            const connectedSockets = new Map(io.sockets.sockets);
            game = createNewGame();
            let i = 1;
            connectedSockets.forEach((socket, socketId) => {
                const color = PLAYER_COLORS[(i-1) % PLAYER_COLORS.length];
                game.players[socketId] = { id: i, name: `Player ${i}`, color: color, isReady: false };
                socket.emit('player-assignment', {playerId: i, color: color});
                i++;
            });
            game.playerCount = Object.keys(game.players).length;
            io.emit('player-list-update', Object.values(game.players));
        }, 10000);
        return;
    }


    const masterClock = game.multiverse['timeline-alpha'] ? game.multiverse['timeline-alpha'].currentState.gameStep : 0;
    game.portals = game.portals.filter(p => p.expiresOnStep > masterClock);
    paradoxHandler(game);
    game.paradoxEvents = game.paradoxEvents.filter(event => { event.duration--; return event.duration > 0; });
    for (const timelineId in game.multiverse) {
        const timeline = game.multiverse[timelineId];
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

function updateTimeline(timeline, timelineId, game) {
    if (timeline.isFrozen) { timeline.currentState.gameStep++; return; }
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

function paradoxHandler(game) { for (const timelineId in game.multiverse) { const timeline = game.multiverse[timelineId]; const currentGameState = timeline.currentState; for (let row = 0; row < BOARD_ROWS; row++) { for (let col = 0; col < BOARD_COLS; col++) { const tile = currentGameState.board[row][col]; if (tile.causalityTag) { const origin = game.multiverse[tile.causalityTag.originTimelineId]; if (!origin || origin.currentState.gameStep < tile.causalityTag.originStep) { tile.army = 0; delete tile.causalityTag; game.paradoxEvents.push({ timelineId, coords: { row, col }, duration: 10 }); } } } } for (let i = currentGameState.moves.length - 1; i >= 0; i--) { const move = currentGameState.moves[i]; if (move.causalityTag) { const origin = game.multiverse[move.causalityTag.originTimelineId]; if (!origin || origin.currentState.gameStep < move.causalityTag.originStep) { const coords = move.path[move.pathIndex]; game.paradoxEvents.push({ timelineId, coords, duration: 10 }); currentGameState.moves.splice(i, 1); } } } } }

function splitTimeline(playerId, activeTimelineId, game) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline) return;
    const generalInfo = findGeneral(playerId, timeline.currentState);
    if (!generalInfo || generalInfo.tile.army < TIME_ACTION_COST.SPLIT) return;
    
    const action = { type: 'SPLIT', playerId };
    timeline.actions.push({ step: timeline.currentState.gameStep, action });
    applyAction(timeline.currentState, action);

    const newGameState = JSON.parse(JSON.stringify(timeline.currentState));
    const newTimelineId = `timeline-${Date.now()}`;
    game.multiverse[newTimelineId] = {
        id: newTimelineId,
        currentState: newGameState,
        keyframes: [{ step: newGameState.gameStep, gameState: JSON.parse(JSON.stringify(newGameState)) }],
        actions: timeline.actions.filter(a => a.step <= newGameState.gameStep), 
        isFrozen: false, freezeUntilStep: 0, overclockUntilStep: 0,
        speedMultiplier: 1.0, anchorStep: newGameState.gameStep, parentId: activeTimelineId, splitStep: timeline.currentState.gameStep,
    };
}

function freezeTimeline(playerId, activeTimelineId, game) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline) return;
    const generalInfo = findGeneral(playerId, timeline.currentState);
    if (!generalInfo || generalInfo.tile.army < TIME_ACTION_COST.FREEZE) return;
    
    const action = { type: 'FREEZE', playerId };
    timeline.actions.push({ step: timeline.currentState.gameStep, action });
    applyAction(timeline.currentState, action);
    
    timeline.freezeUntilStep = timeline.currentState.gameStep + TIME_ACTION_DURATION.FREEZE_TICKS;
    timeline.isFrozen = true;
}

function overclockTimeline(playerId, activeTimelineId, game) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline) return;
    const generalInfo = findGeneral(playerId, timeline.currentState);
    if (!generalInfo || generalInfo.tile.army < TIME_ACTION_COST.OVERCLOCK) return;

    const action = { type: 'OVERCLOCK', playerId };
    timeline.actions.push({ step: timeline.currentState.gameStep, action });
    applyAction(timeline.currentState, action);

    timeline.overclockUntilStep = timeline.currentState.gameStep + TIME_ACTION_DURATION.OVERCLOCK_TICKS;
    timeline.speedMultiplier = 2.0;
}

function rollbackTimeline(playerId, activeTimelineId, targetStep, game) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline) return;

    if (targetStep < timeline.anchorStep || targetStep >= timeline.currentState.gameStep) return;

    const lastKeyframe = [...timeline.keyframes].reverse().find(kf => kf.step <= targetStep);
    if (!lastKeyframe) { return; }

    let preSimState = JSON.parse(JSON.stringify(lastKeyframe.gameState));
    const actionsToReplay = timeline.actions.filter(a => a.step > lastKeyframe.step && a.step <= targetStep);

    for (let step = lastKeyframe.step; step < targetStep; step++) {
        for (const actionRecord of actionsToReplay) {
            if (actionRecord.step === step) {
                applyAction(preSimState, actionRecord.action);
            }
        }
        runSingleTickLogic(preSimState, activeTimelineId, game);
    }

    const generalInPast = findGeneral(playerId, preSimState);
    const stepsToRollback = timeline.currentState.gameStep - targetStep;
    const rollbackCost = Math.floor(10 * Math.pow(1.05, stepsToRollback / 10));

    if (!generalInPast || generalInPast.tile.army < rollbackCost) {
        return;
    }
    
    generalInPast.tile.army -= rollbackCost;
    
    timeline.currentState = preSimState;
    timeline.actions = timeline.actions.filter(a => a.step <= targetStep);
    timeline.keyframes = timeline.keyframes.filter(kf => kf.step <= targetStep);
}

function anchorTimeline(playerId, activeTimelineId, game) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline) return;
    const generalInfo = findGeneral(playerId, timeline.currentState);
    if (!generalInfo || generalInfo.tile.army < TIME_ACTION_COST.ANCHOR) return;

    const action = { type: 'ANCHOR', playerId };
    timeline.actions.push({ step: timeline.currentState.gameStep, action });
    applyAction(timeline.currentState, action);

    timeline.anchorStep = timeline.currentState.gameStep;
}

function openPortal(playerId, activeTimelineId, selectedTile, game) {
    const fromTimeline = game.multiverse[activeTimelineId];
    if (!fromTimeline || !selectedTile) return;
    const fromGameState = fromTimeline.currentState;
    const portalTile = fromGameState.board[selectedTile.row][selectedTile.col];
    if (portalTile.ownerId !== playerId) return;
    const generalInfo = findGeneral(playerId, fromGameState);
    if (!generalInfo || generalInfo.tile.army < TIME_ACTION_COST.HOP) return;
    const targetableTimelines = Object.keys(game.multiverse).filter(id => id !== activeTimelineId);
    if (targetableTimelines.length === 0) return;
    
    const action = { type: 'HOP', playerId };
    fromTimeline.actions.push({ step: fromGameState.gameStep, action });
    applyAction(fromGameState, action);

    const toTimelineId = targetableTimelines[0];
    const portalCoords = { row: selectedTile.row, col: selectedTile.col };
    const expiresOnStep = fromGameState.gameStep + TIME_ACTION_DURATION.HOP_TICKS;
    game.portals.push({ fromTimelineId: activeTimelineId, toTimelineId: toTimelineId, coords: portalCoords, expiresOnStep: expiresOnStep });
    game.portals.push({ fromTimelineId: toTimelineId, toTimelineId: activeTimelineId, coords: portalCoords, expiresOnStep: expiresOnStep });
}

function processMove(playerId, path, activeTimelineId, game) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline || !path || path.length < 2) return;

    const gameState = timeline.currentState;
    const board = gameState.board;

    const existingMoveIndex = gameState.moves.findIndex(move => move.ownerId === playerId);
    if (existingMoveIndex !== -1) {
        const oldMove = gameState.moves[existingMoveIndex];
        const currentPos = oldMove.path[oldMove.pathIndex];
        board[currentPos.row][currentPos.col].army += oldMove.army;
        gameState.moves.splice(existingMoveIndex, 1);
    }

    for (let i = 0; i < path.length; i++) {
        const { row, col } = path[i];
        const tile = board[row]?.[col];
        if (!tile || tile.type === TILE_TYPE.MOUNTAIN) {
            return;
        }
        if (i > 0) {
            const prev = path[i - 1];
            const dx = Math.abs(col - prev.col);
            const dy = Math.abs(row - prev.row);
            if (dx + dy !== 1) {
                return;
            }
        }
    }

    const startTile = board[path[0].row][path[0].col];
    if (startTile.ownerId !== playerId || startTile.army <= 1) return;

    const action = { type: 'MOVE', playerId, path };
    timeline.actions.push({ step: gameState.gameStep, action });
    applyAction(gameState, action);
}

function findGeneral(playerId, currentGameState) { for (let row = 0; row < BOARD_ROWS; row++) { for (let col = 0; col < BOARD_COLS; col++) { const tile = currentGameState.board[row][col]; if (tile.type === TILE_TYPE.GENERAL && tile.ownerId === playerId) return { row, col, tile }; } } return null; }
function handlePlayerDefeat(victorId, defeatedId, currentGameState) { for (let row = 0; row < BOARD_ROWS; row++) { for (let col = 0; col < BOARD_COLS; col++) { if (currentGameState.board[row][col].ownerId === defeatedId) currentGameState.board[row][col].ownerId = victorId; } } for (let i = currentGameState.moves.length - 1; i >= 0; i--) { if (currentGameState.moves[i].ownerId === defeatedId) { currentGameState.moves.splice(i, 1); } } }
function findValidAdjacentTile(coords, currentGameState) { const { row, col } = coords; for (let r = row - 1; r <= row + 1; r++) { for (let c = col - 1; c <= col + 1; c++) { if (r === row && c === col) continue; if (r >= 0 && r < BOARD_ROWS && c >= 0 && c < BOARD_COLS) { const neighborTile = currentGameState.board[r][c]; if (neighborTile.type !== TILE_TYPE.MOUNTAIN) return { row: r, col: c }; } } } return null; }
function calculateVisibility(playerId, game) { const visibilityGrid = Array(BOARD_ROWS).fill(null).map(() => Array(BOARD_COLS).fill(false)); const visibilityRadius = 2; for(const timelineId in game.multiverse){ const currentGameState = game.multiverse[timelineId].currentState; for (let row = 0; row < BOARD_ROWS; row++) { for (let col = 0; col < BOARD_COLS; col++) { if (currentGameState.board[row][col].ownerId === playerId) { for (let scanRow = row - visibilityRadius; scanRow <= row + visibilityRadius; scanRow++) { for (let scanCol = col - visibilityRadius; scanCol <= col + visibilityRadius; scanCol++) { if (scanRow >= 0 && scanRow < BOARD_ROWS && scanCol >= 0 && scanCol < BOARD_COLS) visibilityGrid[scanRow][scanCol] = true; } } } } } } return visibilityGrid; }

io.on('connection', (socket) => {
    if (game.playerCount >= 8 || game.isGameRunning) {
        socket.emit('game-in-progress');
        socket.disconnect();
        return;
    }
    game.playerCount++;
    const playerId = game.playerCount;
    const color = PLAYER_COLORS[(playerId - 1) % PLAYER_COLORS.length];
    game.players[socket.id] = { id: playerId, name: `Player ${playerId}`, color: color, isReady: false };

    socket.emit('player-assignment', { playerId, color });
    io.emit('player-list-update', Object.values(game.players));

    socket.on('player-ready', (isReady) => {
        if (game.isGameRunning) return;
        const player = game.players[socket.id];
        if (player) {
            player.isReady = isReady;
            io.emit('player-list-update', Object.values(game.players));

            const allPlayers = Object.values(game.players);
            const allReady = allPlayers.every(p => p.isReady);

            if (game.playerCount >= 2 && allReady) {
                initializeGame(game);
                const dynamicGameLoop = () => {
                    if (!game.isGameRunning) return;
                    const activeTimelinesCount = Object.values(game.multiverse).filter(t => !t.isFrozen).length || 1;
                    const tickDuration = GAME_TICK_MS * activeTimelinesCount;
                    gameLoop(game);

                    const playerStats = calculatePlayerStats(game);

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
                                playerStats: playerStats
                            };
                            io.to(socketId).emit('game-state-update', personalizedState);
                        }
                    }
                    if (game.isGameRunning) {
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
        for (let step = timeline.currentState.gameStep -1; step >= timeline.anchorStep; step--) {
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

    socket.on('player-action', (action) => {
        if (!game.isGameRunning) return;
        const player = game.players[socket.id];
        if (!player) return;

        switch (action.type) {
            case 'MOVE':
                processMove(player.id, action.path, action.activeTimelineId, game);
                break;
            case 'SPLIT':
                splitTimeline(player.id, action.activeTimelineId, game);
                break;
            case 'FREEZE':
                freezeTimeline(player.id, action.activeTimelineId, game);
                break;
            case 'OVERCLOCK':
                overclockTimeline(player.id, action.activeTimelineId, game);
                break;
            case 'ROLLBACK':
                rollbackTimeline(player.id, action.activeTimelineId, action.targetStep, game);
                break;
            case 'ANCHOR':
                anchorTimeline(player.id, action.activeTimelineId, game);
                break;
            case 'HOP':
                openPortal(player.id, action.activeTimelineId, action.selectedTile, game);
                break;
        }
    });

    socket.on('disconnect', () => {
        if (game.players[socket.id]) {
            const disconnectedPlayerId = game.players[socket.id].id;
            for (const timelineId in game.multiverse) {
                const timeline = game.multiverse[timelineId];
                handlePlayerDefeat(0, disconnectedPlayerId, timeline.currentState); 
            }
            delete game.players[socket.id];
            game.playerCount--;
        }
        io.emit('player-list-update', Object.values(game.players));
        if (game.isGameRunning && game.playerCount < 2) {
            clearTimeout(game.gameInterval);
            io.emit('game-over', { winnerId: 'none', reason: 'Not enough players.' });
            game = createNewGame();
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});