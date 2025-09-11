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
const TIME_ACTION_COST = { SPLIT: 50, FREEZE: 30, OVERCLOCK: 40, ROLLBACK: 60, ANCHOR: 25, HOP: 75 };
const TIME_ACTION_DURATION = { FREEZE_TICKS: 20, OVERCLOCK_TICKS: 20, ROLLBACK_TICKS: 10, HOP_TICKS: 30 };
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
    console.log(`New dimensions for ${playerCount} players: ${newCols}x${newRows}`);
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
    console.log("Initializing new game state...");
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
    console.log("Game initialized.");
    game.isGameRunning = true;
    io.emit('game-start');
}

function runSingleTickLogic(currentGameState) {
    for (let i = currentGameState.moves.length - 1; i >= 0; i--) {
        const move = currentGameState.moves[i];
        move.progress++;

        if (move.progress >= MOVE_TICKS) {
            move.progress = 0;

            const leavingPos = move.path[move.pathIndex];
            const leavingTile = currentGameState.board[leavingPos.row][leavingPos.col];

            if (leavingTile.ownerId === move.ownerId) {
                move.army += leavingTile.army - 1;
                leavingTile.army = 1;
            }

            move.pathIndex++;
            const arrivingPos = move.path[move.pathIndex];
            if (!arrivingPos) { 
                currentGameState.moves.splice(i, 1);
                continue;
            }
            const arrivingTile = currentGameState.board[arrivingPos.row][arrivingPos.col];

            const isFinalStep = move.pathIndex >= move.path.length - 1;

            if (arrivingTile.ownerId !== move.ownerId) { 
                if (move.army > arrivingTile.army) {
                    move.army -= arrivingTile.army;
                    if (arrivingTile.type === TILE_TYPE.GENERAL) {
                        handlePlayerDefeat(move.ownerId, arrivingTile.ownerId, currentGameState);
                    }
                    arrivingTile.ownerId = move.ownerId;
                    arrivingTile.army = move.army;

                    if (!isFinalStep) {
                        if (move.army > 1) {
                            arrivingTile.army = 1;
                            move.army -= 1;
                        } else { 
                            currentGameState.moves.splice(i, 1);
                            continue;
                        }
                    } else { 
                        currentGameState.moves.splice(i, 1);
                        continue;
                    }
                } else { 
                    arrivingTile.army -= move.army;
                    currentGameState.moves.splice(i, 1);
                    continue;
                }
            } else { 
                if (isFinalStep) { 
                    arrivingTile.army += move.army;
                    currentGameState.moves.splice(i, 1);
                    continue;
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
            if (startTile.causalityTag) { newMove.causalityTag = startTile.causalityTag; }
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


function gameLoop(game) {
    const activePlayers = new Set();
    for (const timelineId in game.multiverse) {
        const timeline = game.multiverse[timelineId];
        const currentGameState = timeline.currentState;
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
        console.log(`Game over! Winner is Player ${winnerId}`);
        io.emit('game-over', { winnerId });
        clearTimeout(game.gameInterval);
        game.isGameRunning = false;
        setTimeout(() => {
            console.log("Resetting game state for new match.");
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
            updateTimeline(timeline, game);
        }
    }
}
function updateTimeline(timeline) {
    if (timeline.isFrozen) { timeline.currentState.gameStep++; return; }

    runSingleTickLogic(timeline.currentState);

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

    const generalInfo = findGeneral(playerId, timeline.currentState);
    if (!generalInfo || generalInfo.tile.army < TIME_ACTION_COST.ROLLBACK) return;
    if (targetStep < timeline.anchorStep || targetStep >= timeline.currentState.gameStep) return;

    const lastKeyframe = [...timeline.keyframes].reverse().find(kf => kf.step <= targetStep);
    if (!lastKeyframe) { console.log("Rollback failed: No valid keyframe found."); return; }
    
    console.log(`Rolling back timeline ${activeTimelineId} from step ${timeline.currentState.gameStep} to ${targetStep}, starting from keyframe at ${lastKeyframe.step}`);
    
    let simulationState = JSON.parse(JSON.stringify(lastKeyframe.gameState));
    const actionsToReplay = timeline.actions.filter(a => a.step > lastKeyframe.step && a.step <= targetStep);

    for (let step = lastKeyframe.step; step < targetStep; step++) {
        for (const actionRecord of actionsToReplay) {
            if (actionRecord.step === step) {
                applyAction(simulationState, actionRecord.action);
            }
        }
        runSingleTickLogic(simulationState);
    }
    
    const originalGeneral = findGeneral(playerId, timeline.currentState);
    if (originalGeneral) {
        originalGeneral.tile.army -= TIME_ACTION_COST.ROLLBACK;
        const newGeneral = findGeneral(playerId, simulationState);
        if(newGeneral) newGeneral.tile.army = originalGeneral.tile.army;
    }
    
    timeline.currentState = simulationState;
    timeline.actions = timeline.actions.filter(a => a.step <= targetStep);
    timeline.keyframes = timeline.keyframes.filter(kf => kf.step <= targetStep);
    
    console.log(`Rollback complete. New state at step ${timeline.currentState.gameStep}`);
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
function openPortal(playerId, activeTimelineId, selectedTile, game) { const fromTimeline = game.multiverse[activeTimelineId]; if (!fromTimeline || !selectedTile) return; const fromGameState = fromTimeline.currentState; const portalTile = fromGameState.board[selectedTile.row][selectedTile.col]; if (portalTile.ownerId !== playerId) return; const generalInfo = findGeneral(playerId, fromGameState); if (!generalInfo || generalInfo.tile.army < TIME_ACTION_COST.HOP) return; const targetableTimelines = Object.keys(game.multiverse).filter(id => id !== activeTimelineId); if (targetableTimelines.length === 0) return; generalInfo.tile.army -= TIME_ACTION_COST.HOP; const toTimelineId = targetableTimelines[0]; const portalCoords = { row: selectedTile.row, col: selectedTile.col }; const expiresOnStep = fromGameState.gameStep + TIME_ACTION_DURATION.HOP_TICKS; game.portals.push({ fromTimelineId: activeTimelineId, toTimelineId: toTimelineId, coords: portalCoords, expiresOnStep: expiresOnStep }); game.portals.push({ fromTimelineId: toTimelineId, toTimelineId: activeTimelineId, coords: portalCoords, expiresOnStep: expiresOnStep }); }

function processMove(playerId, path, activeTimelineId, game) {
    const timeline = game.multiverse[activeTimelineId];
    if (!timeline || !path || path.length < 2) return;

    const board = timeline.currentState.board;

    // --- NEW: Robust Path Validation ---
    for (let i = 0; i < path.length; i++) {
        const { row, col } = path[i];

        // Check 1: Tile must exist
        const tile = board[row]?.[col];
        if (!tile) {
            console.log(`Invalid move from player ${playerId}: Path contains non-existent tile.`);
            return;
        }

        // Check 2: Tile must not be a mountain
        if (tile.type === TILE_TYPE.MOUNTAIN) {
            console.log(`Invalid move from player ${playerId}: Path through mountain.`);
            return;
        }

        // Check 3: Each step must be adjacent to the last
        if (i > 0) {
            const prev = path[i - 1];
            const dx = Math.abs(col - prev.col);
            const dy = Math.abs(row - prev.row);
            // Allow only cardinal moves (not diagonal)
            if (dx + dy !== 1) {
                console.log(`Invalid move from player ${playerId}: Path is not contiguous or is diagonal.`);
                return;
            }
        }
    }

    const startTile = board[path[0].row][path[0].col];
    if (startTile.ownerId !== playerId || startTile.army <= 1) return;

    const action = { type: 'MOVE', playerId, path };
    timeline.actions.push({ step: timeline.currentState.gameStep, action });
    applyAction(timeline.currentState, action);
}

function findGeneral(playerId, currentGameState) { for (let row = 0; row < BOARD_ROWS; row++) { for (let col = 0; col < BOARD_COLS; col++) { const tile = currentGameState.board[row][col]; if (tile.type === TILE_TYPE.GENERAL && tile.ownerId === playerId) return { row, col, tile }; } } return null; }
function handlePlayerDefeat(victorId, defeatedId, currentGameState) { for (let row = 0; row < BOARD_ROWS; row++) { for (let col = 0; col < BOARD_COLS; col++) { if (currentGameState.board[row][col].ownerId === defeatedId) currentGameState.board[row][col].ownerId = victorId; } } for (const move of currentGameState.moves) { if (move.ownerId === defeatedId) move.ownerId = victorId; } }
function findValidAdjacentTile(coords, currentGameState) { const { row, col } = coords; for (let r = row - 1; r <= row + 1; r++) { for (let c = col - 1; c <= col + 1; c++) { if (r === row && c === col) continue; if (r >= 0 && r < BOARD_ROWS && c >= 0 && c < BOARD_COLS) { const neighborTile = currentGameState.board[r][c]; if (neighborTile.type !== TILE_TYPE.MOUNTAIN) return { row: r, col: c }; } } } return null; }
function calculateVisibility(playerId, game) { const visibilityGrid = Array(BOARD_ROWS).fill(null).map(() => Array(BOARD_COLS).fill(false)); const visibilityRadius = 2; for(const timelineId in game.multiverse){ const currentGameState = game.multiverse[timelineId].currentState; for (let row = 0; row < BOARD_ROWS; row++) { for (let col = 0; col < BOARD_COLS; col++) { if (currentGameState.board[row][col].ownerId === playerId) { for (let scanRow = row - visibilityRadius; scanRow <= row + visibilityRadius; scanRow++) { for (let scanCol = col - visibilityRadius; scanCol <= col + visibilityRadius; scanCol++) { if (scanRow >= 0 && scanRow < BOARD_ROWS && scanCol >= 0 && scanCol < BOARD_COLS) visibilityGrid[scanRow][scanCol] = true; } } } } } } return visibilityGrid; }

io.on('connection', (socket) => {
    console.log(`A user connected: ${socket.id}`);
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
                console.log("All players are ready. Starting game...");
                initializeGame(game);
                const dynamicGameLoop = () => {
                    if (!game.isGameRunning) return;
                    const activeTimelinesCount = Object.values(game.multiverse).filter(t => !t.isFrozen).length || 1;
                    const tickDuration = GAME_TICK_MS / activeTimelinesCount;
                    gameLoop(game);
                    for (const socketId in game.players) {
                        if (io.sockets.sockets.get(socketId)) {
                            const player = game.players[socketId];
                            const visibilityGrid = calculateVisibility(player.id, game);
                            const personalizedState = {
                                multiverse: game.multiverse, portals: game.portals, paradoxEvents: game.paradoxEvents,
                                visibilityGrid: visibilityGrid, boardDimensions: game.boardDimensions
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
        console.log(`User disconnected: ${socket.id}`);
        if (game.players[socket.id]) {
            delete game.players[socket.id];
            game.playerCount--;
        }
        io.emit('player-list-update', Object.values(game.players));
        if (game.isGameRunning && game.playerCount < 2) {
            clearTimeout(game.gameInterval);
            console.log("Not enough players. Game stopped and state reset.");
            io.emit('game-over', { winnerId: 'none', reason: 'Not enough players.' });
            game = createNewGame();
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});