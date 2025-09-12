// public/client.js

window.onload = function() {
    console.log("Client script loaded!");
    const socket = io();

    // --- 1. LOCAL STATE & CONSTANTS ---
    // These values must match their server-side counterparts for the simulation to appear correct.
    const BASE_TILE_SIZE = 20;
    let PLAYER_COLORS = { 0: '#333333' }; // Color map for players, updated from server.
    const TILE_TYPE = { EMPTY: 0, MOUNTAIN: 1, CITY: 2, GENERAL: 3, FOREST: 4, ERASED: 5 };
    const MOVE_TICKS = 2; // Ticks per tile move.
    const GAME_TICK_MS = 500; // Base duration of a server tick.

    // Client-side cost calculators for immediate UI feedback in modals.
    // The server still performs the final validation.
    function calculateFreezeCost(duration) { return Math.floor(15 * Math.pow(1.07, duration / 5)); }
    function calculateOverclockCost(duration) { return Math.floor(20 * Math.pow(1.08, duration / 5)); }
    function calculatePortalCost(duration) { return Math.floor(40 * Math.pow(1.06, duration / 5)); }
    const COST_CALCULATORS = {
        FREEZE: calculateFreezeCost,
        OVERCLOCK: calculateOverclockCost,
        HOP: calculatePortalCost,
    };

    // This object holds all the game state data received from the server.
    let localGameState = {
        multiverse: {}, portals: [], paradoxEvents: [], visibilityGrid: [],
        boardDimensions: { cols: 40, rows: 30 },
        playerStats: {},
        settings: {}
    };
    let myPlayerId = null, myColor = '#FFFFFF', activeTimelineId = 'timeline-alpha';
    // State for handling player input (mouse drags, clicks).
    let inputState = { isDragging: false, startTile: null, path: [], endTile: null, isSplitMove: false };
    let selectedTile = null, isFogOfWarEnabled = true;
    let isReady = false; // Player's ready status in the lobby.
    let isHost = false;  // Is this client the host?
    let players = [];    // List of all players in the game.
    
    // Used for interpolating army movements between server updates for smoother animations.
    let lastServerUpdate = performance.now();

    // Camera state for panning and zooming.
    const camera = { x: 0, y: 0, zoom: 1.0, minZoom: 0.3, maxZoom: 3.0 };
    let panningState = { isPanning: false, lastMouseX: 0, lastMouseY: 0 };

    // --- 2. CANVAS & UI ELEMENT SETUP ---
    // Get references to all the important HTML elements.
    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 1280;
    canvas.height = 720;
    
    const treeCanvas = document.getElementById('timeline-tree-canvas');
    const treeCtx = treeCanvas.getContext('2d');

    const readyBtn = document.getElementById('ready-btn');
    const timelineControls = document.getElementById('timeline-controls');
    const timelineListContainer = document.getElementById('timeline-list-container');
    const customizationContainer = document.getElementById('customization-container');

    // Customization UI Elements
    const fogToggle = document.getElementById('fogToggle');
    const staggeredStartToggle = document.getElementById('staggeredStartToggle');
    const fairGeneralsToggle = document.getElementById('fairGeneralsToggle');
    const mountainPercent = document.getElementById('mountainPercent');
    const forestPercent = document.getElementById('forestPercent');
    const cityCount = document.getElementById('cityCount');
    const allCustomizationInputs = [fogToggle, staggeredStartToggle, fairGeneralsToggle, mountainPercent, forestPercent, cityCount];

    // Custom Modal Elements
    const modalOverlay = document.getElementById('custom-modal-overlay');
    const modalTitle = document.getElementById('modal-title');
    const modalMessage = document.getElementById('modal-message');
    const modalInput = document.getElementById('modal-input');
    const modalCostDisplay = document.getElementById('modal-cost-display');
    const modalConfirmBtn = document.getElementById('modal-confirm-btn');
    const modalCancelBtn = document.getElementById('modal-cancel-btn');

    /**
     * A flexible, promise-based function to show a modal dialog for user input or confirmation.
     * @param {object} config - Configuration for the modal (title, message, etc.).
     * @returns {Promise} A promise that resolves with the user's input or rejects on cancellation.
     */
    function showModal(config) {
        modalTitle.textContent = config.title;
        modalMessage.textContent = config.message;
        modalInput.classList.toggle('hidden', !config.showInput);
        if (config.showInput) {
            modalInput.value = config.defaultValue || '';
            setTimeout(() => modalInput.focus(), 10);
        }
        modalCostDisplay.textContent = config.costText || '';
        modalCostDisplay.classList.toggle('hidden', !config.costText);
        modalConfirmBtn.textContent = config.confirmText || 'Confirm';
        modalCancelBtn.textContent = config.cancelText || 'Cancel';
        modalOverlay.classList.remove('hidden');
        return new Promise((resolve, reject) => {
            const onConfirm = () => {
                cleanup();
                resolve(config.showInput ? modalInput.value : true);
            };
            const onCancel = () => {
                cleanup();
                reject();
            };
            const onKeyup = (e) => {
                if(e.key === 'Enter' && !modalConfirmBtn.disabled) onConfirm();
                if(e.key === 'Escape') onCancel();
            }
            function cleanup() {
                modalConfirmBtn.removeEventListener('click', onConfirm);
                modalCancelBtn.removeEventListener('click', onCancel);
                window.removeEventListener('keyup', onKeyup);
                modalOverlay.classList.add('hidden');
            }
            modalConfirmBtn.addEventListener('click', onConfirm);
            modalCancelBtn.addEventListener('click', onCancel);
            window.addEventListener('keyup', onKeyup);
        });
    }


    // --- 3. SOCKET.IO EVENT HANDLERS ---
    // These functions react to messages from the server.

    // Received upon first connecting to the server.
    socket.on('player-assignment', (data) => {
        myPlayerId = data.playerId; myColor = data.color;
        const playerIdDisplay = document.getElementById('player-id-display');
        if (playerIdDisplay) { playerIdDisplay.textContent = `You are Player ${myPlayerId}`; playerIdDisplay.style.color = myColor; }
    });

    // Updates the lobby with the current list of players, settings, and host.
    socket.on('lobby-update', ({ players: playerList, settings, hostPlayerId }) => {
        players = playerList;
        PLAYER_COLORS = { 0: '#333333' }; 
        players.forEach(p => { PLAYER_COLORS[p.id] = p.color; });

        isHost = myPlayerId === hostPlayerId;
        updatePlayerListView(hostPlayerId);
        updateLobbyUI(settings);
    });

    // The main firehose of data during the game. Receives the entire game state.
    socket.on('game-state-update', (newState) => {
        // Handle cases where the active timeline might cease to exist (e.g., due to a rollback).
        if (!localGameState.multiverse[activeTimelineId] && Object.keys(newState.multiverse).length > 0) {
            activeTimelineId = Object.keys(newState.multiverse)[0] || 'timeline-alpha';
        }
        if (newState.multiverse && !newState.multiverse[activeTimelineId]) {
            const oldTimeline = localGameState.multiverse[activeTimelineId];
            activeTimelineId = (oldTimeline && newState.multiverse[oldTimeline.parentId]) ? oldTimeline.parentId : 'timeline-alpha';
        }

        // Replace the local state with the new state from the server.
        localGameState = newState;
        lastServerUpdate = performance.now(); // Reset the animation timer.
        updatePlayerListView(null);

        // Update the cost displayed on the "Split Timeline" button.
        const splitBtn = document.getElementById('split-timeline-btn');
        if (splitBtn && localGameState.multiverse) {
            const numTimelines = Object.keys(localGameState.multiverse).length;
            const splitCost = Math.floor(250 * Math.pow(1.25, numTimelines - 1));
            splitBtn.textContent = `Split Timeline (Cost: ${splitCost})`;
        }

        // Handle the "Staggered Start" game setting.
        if (localGameState.settings && localGameState.settings.staggeredStart) {
            const stats = localGameState.playerStats;
            const totalArmy = stats?.global?.[myPlayerId]?.army || 0;
            if (totalArmy >= 1000) { // Timeline controls are hidden until player reaches 1000 army.
                timelineControls.classList.remove('hidden');
                timelineListContainer.classList.remove('hidden');
            } else {
                timelineControls.classList.add('hidden');
                timelineListContainer.classList.add('hidden');
            }
        }
    });
    
    /** Updates the player list UI element with current names, army counts, and ready status. */
    function updatePlayerListView(hostPlayerId) {
        const playerListElement = document.getElementById('player-list');
        if (playerListElement) {
            playerListElement.innerHTML = '<h3>Connected Players</h3>';
            players.forEach(player => {
                const playerEl = document.createElement('div');
                const readyStatus = player.isReady ? '✔️ Ready' : '❌ Not Ready';
                const hostLabel = player.id === hostPlayerId ? ' (Host)' : '';
                
                let armyDisplay = '';
                if (Object.keys(localGameState.multiverse).length > 0) {
                    const armyCount = localGameState.playerStats?.[activeTimelineId]?.[player.id]?.army || 0;
                    armyDisplay = `(Army: ${armyCount})`;
                }

                playerEl.textContent = `${player.name}${hostLabel} ${armyDisplay} - ${readyStatus}`;
                
                playerEl.style.color = player.color;
                playerEl.style.fontWeight = 'bold';
                playerListElement.appendChild(playerEl);
            });
        }
    }
    
    /** Updates the lobby customization UI based on settings from the server. */
    function updateLobbyUI(settings) {
        // Only the host can edit the settings.
        allCustomizationInputs.forEach(input => input.disabled = !isHost);
        fogToggle.checked = settings.fogOfWar;
        staggeredStartToggle.checked = settings.staggeredStart;
        fairGeneralsToggle.checked = settings.fairGenerals;
        mountainPercent.value = settings.mountainPercent;
        forestPercent.value = settings.forestPercent;
        cityCount.value = settings.cityCount;
    }

    /** Emits the current lobby settings to the server. Only the host can do this. */
    function emitSettings() {
        if (!isHost) return;
        const newSettings = {
            fogOfWar: fogToggle.checked,
            staggeredStart: staggeredStartToggle.checked,
            fairGenerals: fairGeneralsToggle.checked,
            mountainPercent: mountainPercent.value,
            forestPercent: forestPercent.value,
            cityCount: cityCount.value
        };
        socket.emit('update-game-settings', newSettings);
    }
    allCustomizationInputs.forEach(input => input.addEventListener('change', emitSettings));
    
    // Fired when the game starts. Hides lobby UI and shows game UI.
    socket.on('game-start', ({ settings }) => {
        document.getElementById('game-status').innerText = "";
        readyBtn.style.display = 'none';
        customizationContainer.classList.add('hidden');
        isFogOfWarEnabled = settings.fogOfWar;

        if (!settings.staggeredStart) {
            timelineControls.classList.remove('hidden');
            timelineListContainer.classList.remove('hidden');
        }
    });

    // Fired when the game ends. Shows the winner and returns to the lobby state.
    socket.on('game-over', (data) => {
        const statusDiv = document.getElementById('game-status');
        if (data.winnerId === myPlayerId) { statusDiv.innerText = "You are victorious!"; }
        else { statusDiv.innerText = `Game Over! Player ${data.winnerId} is the winner.`; }
        readyBtn.style.display = 'block';
        customizationContainer.classList.remove('hidden');
        timelineControls.classList.add('hidden');
        timelineListContainer.classList.add('hidden');
        isReady = false; readyBtn.classList.remove('ready'); readyBtn.textContent = 'Ready Up';
    });

    // Fired if a player tries to connect to a game already in progress.
    socket.on('game-in-progress', () => { document.body.innerHTML = '<h1>Game in progress. Please wait for the next round.</h1>'; });

    // Handles responses from the server about what the player can afford.
    socket.on('rollback-info-response', ({ oldestAffordableStep }) => { /* ... modal logic ... */ });
    socket.on('affordability-info-response', ({ actionType, maxDuration }) => { /* ... modal logic ... */ });

    // --- 4. RENDERING LOGIC ---
    // These functions draw the game state onto the canvases.
    
    /** Gets the color for an army based on its causality tag, making "foreign" armies look different. */
    function getCausalityColor(tag, currentStep) { /* ... color calculation logic ... */ return '#FFFFFF'; }
    
    /** The main rendering function, called every animation frame. */
    function render() {
        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Apply camera transformations (pan and zoom).
        ctx.translate(camera.x, camera.y);
        ctx.scale(camera.zoom, camera.zoom);

        const currentTimeline = localGameState.multiverse[activeTimelineId];
        // If no timeline data, show a waiting message.
        if (!currentTimeline) {
            ctx.restore();
            ctx.fillStyle = 'white'; ctx.font = '24px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('Waiting for players to ready up...', canvas.width / 2, canvas.height / 2);
            renderTimelineTree();
            return;
        }

        const activeGameState = currentTimeline.currentState;
        const TILE_SIZE = BASE_TILE_SIZE;

        // Culling: Only draw tiles that are currently visible in the camera's viewport.
        const view = { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, width: canvas.width / camera.zoom, height: canvas.height / camera.zoom };
        const startCol = Math.floor(view.x / TILE_SIZE); const endCol = Math.ceil((view.x + view.width) / TILE_SIZE);
        const startRow = Math.floor(view.y / TILE_SIZE); const endRow = Math.ceil((view.y + view.height) / TILE_SIZE);

        // A. Draw the board tiles.
        for (let row = startRow; row < endRow; row++) { for (let col = startCol; col < endCol; col++) {
            if (row < 0 || row >= localGameState.boardDimensions.rows || col < 0 || col >= localGameState.boardDimensions.cols) continue;
            const x = col * TILE_SIZE, y = row * TILE_SIZE;

            // Fog of War: If a tile isn't visible, draw it as dark gray.
            if (isFogOfWarEnabled && localGameState.visibilityGrid && !localGameState.visibilityGrid[row]?.[col]) {
                ctx.fillStyle = '#111111'; ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE); continue;
            }

            const tile = activeGameState.board[row]?.[col];
            if (!tile) continue;
            if(tile.type === TILE_TYPE.ERASED) { ctx.fillStyle = '#000000'; ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE); continue; }

            // Draw tile based on owner and type.
            ctx.fillStyle = PLAYER_COLORS[tile.ownerId] || '#FFFFFF';
            if (tile.type === TILE_TYPE.MOUNTAIN) { ctx.fillStyle = '#555555'; }
            else if (tile.type === TILE_TYPE.FOREST) { ctx.fillStyle = '#006400'; }
            ctx.fillRect(x, y, TILE_SIZE - 1, TILE_SIZE - 1);

            // Draw decorators for special tiles (portals, generals, cities).
            const isPortal = localGameState.portals.some(p => p.fromTimelineId === activeTimelineId && p.coords.row === row && p.coords.col === col);
            if (isPortal) { /* ... draw portal icon ... */ }
            if (tile.type === TILE_TYPE.GENERAL) { /* ... draw general icon ... */ }
            else if (tile.type === TILE_TYPE.CITY) { /* ... draw city border ... */ }

            // Draw army counts on tiles.
            if (tile.army > 0 && tile.type !== TILE_TYPE.MOUNTAIN && camera.zoom > 0.5) {
                const isMyTile = tile.ownerId === myPlayerId;
                const isArmyVisible = (tile.type !== TILE_TYPE.FOREST) || isMyTile; // Hide enemy army counts in forests.
                if (isArmyVisible) {
                    ctx.fillStyle = getCausalityColor(tile.causalityTag, activeGameState.gameStep);
                    ctx.font = `bold ${TILE_SIZE / 2}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                    ctx.fillText(tile.army, x + TILE_SIZE / 2, y + TILE_SIZE / 2);
                }
            }
        }}

        // B. Draw special effects (e.g., timeline unravelling).
        if (currentTimeline.isUnravelling && currentTimeline.unravelCenter) { /* ... draw unravel effect ... */ }
        
        // C. Draw moving armies with interpolation for smoothness.
        // Calculates where an army *should* be between server updates for a smooth animation.
        const activeTimelinesCount = Object.keys(localGameState.multiverse).filter(id => !localGameState.multiverse[id].isFrozen).length || 1;
        const tickDurationMs = GAME_TICK_MS * activeTimelinesCount;
        const segmentDuration = tickDurationMs * MOVE_TICKS;
        for (const move of activeGameState.moves) {
            const currentPos = move.path[move.pathIndex];
            if (isFogOfWarEnabled && localGameState.visibilityGrid && !localGameState.visibilityGrid[currentPos.row]?.[currentPos.col]) continue;
            
            const segmentStart = move.path[move.pathIndex];
            const segmentEnd = move.path[move.pathIndex + 1];
            if(!segmentStart || !segmentEnd) continue;

            // Interpolation logic:
            const timeSinceUpdate = performance.now() - lastServerUpdate;
            const progressInSegment = (tickDurationMs * move.progress) + timeSinceUpdate;
            const totalFraction = Math.min(progressInSegment / segmentDuration, 1.0);
            const startX = (segmentStart.col * TILE_SIZE) + (TILE_SIZE / 2); const startY = (segmentStart.row * TILE_SIZE) + (TILE_SIZE / 2);
            const endX = (segmentEnd.col * TILE_SIZE) + (TILE_SIZE / 2); const endY = (segmentEnd.row * TILE_SIZE) + (TILE_SIZE / 2);
            const currentX = startX + (endX - startX) * totalFraction; const currentY = startY + (endY - startY) * totalFraction;

            // Draw the army circle and text.
            ctx.beginPath(); ctx.arc(currentX, currentY, TILE_SIZE / 2, 0, Math.PI * 2);
            ctx.fillStyle = PLAYER_COLORS[move.ownerId]; ctx.fill();
            /* ... draw text ... */
        }

        // D. Draw UI feedback (drag path, selected tile).
        if (inputState.isDragging && inputState.path.length > 0) { /* ... draw move path line ... */ }
        if (selectedTile) { /* ... draw selection box ... */ }

        ctx.restore(); // Restore the canvas context to its original state.
        renderTimelineTree(); // Draw the tree on the other canvas.
    }

    /** Renders the branching timeline tree on the right-side panel. */
    function renderTimelineTree() { /* ... timeline tree drawing logic ... */ }
    
    // --- 5. INPUT EVENT LISTENERS ---
    // These functions capture player input and emit actions to the server.

    /** Converts mouse coordinates on the canvas to tile row/column coordinates. */
    function getTileFromMouseEvent(event) {
        const rect = canvas.getBoundingClientRect();
        const x = (event.clientX - rect.left - camera.x) / camera.zoom;
        const y = (event.clientY - rect.top - camera.y) / camera.zoom;
        const col = Math.floor(x / BASE_TILE_SIZE); const row = Math.floor(y / BASE_TILE_SIZE);
        if (row >= 0 && row < localGameState.boardDimensions.rows && col >= 0 && col < localGameState.boardDimensions.cols) return { row, col };
        return null;
    }

    // Handles mouse clicks for starting moves, selections, or panning.
    canvas.addEventListener('mousedown', (event) => {
        const tileCoords = getTileFromMouseEvent(event);
        if (!tileCoords) return;

        if (event.button === 0 || event.button === 2) { // Left or Right click starts a move.
            inputState.isDragging = true;
            inputState.startTile = tileCoords;
            inputState.path = [tileCoords];
            inputState.endTile = tileCoords;
            inputState.isSplitMove = (event.button === 2); // Right click is a 50% split move.
        } else if (event.button === 1) { // Middle click starts panning.
            event.preventDefault();
            panningState.isPanning = true; 
            panningState.lastMouseX = event.clientX; panningState.lastMouseY = event.clientY;
        }
    });

    // Handles mouse movement for drawing move paths or panning the camera.
    canvas.addEventListener('mousemove', (event) => {
        if (inputState.isDragging) {
            const currentTileCoords = getTileFromMouseEvent(event);
            if (currentTileCoords) {
                inputState.endTile = currentTileCoords;
                const lastTileInPath = inputState.path[inputState.path.length - 1];
                // Add a new tile to the path if the mouse has moved to a new tile.
                if (currentTileCoords.row !== lastTileInPath.row || currentTileCoords.col !== lastTileInPath.col) {
                    /* ... add to path if not a mountain ... */
                }
            }
        } else if (panningState.isPanning) {
            const dx = event.clientX - panningState.lastMouseX; const dy = event.clientY - panningState.lastMouseY;
            camera.x += dx; camera.y += dy;
            panningState.lastMouseX = event.clientX; panningState.lastMouseY = event.clientY;
        }
    });

    // Handles releasing the mouse button to finalize a move, selection, or pan.
    canvas.addEventListener('mouseup', (event) => {
        if (event.button === 0 || event.button === 2) { // Left or Right mouse button.
            if (inputState.isDragging) {
                if (inputState.path.length > 1) { // If the path is longer than one tile, it's a move.
                    socket.emit('player-action', { 
                        type: 'MOVE', 
                        path: inputState.path, 
                        isSplit: inputState.isSplitMove,
                        activeTimelineId: activeTimelineId 
                    });
                    selectedTile = null;
                } else { // Otherwise, it's a selection.
                    selectedTile = inputState.startTile;
                }
                // Reset input state.
                inputState.isDragging = false; inputState.isSplitMove = false;
                inputState.startTile = null; inputState.endTile = null; inputState.path = [];
            }
        } else if (event.button === 1) { // Middle mouse button.
            panningState.isPanning = false;
        }
    });
    
    canvas.addEventListener('contextmenu', e => e.preventDefault()); // Prevent right-click menu.
    canvas.addEventListener('wheel', (event) => { /* ... zoom logic ... */ });
    
    readyBtn.addEventListener('click', () => {
        isReady = !isReady; // Toggle ready state
        socket.emit('player-ready', isReady); // Inform the server of the change
        // Update the button's appearance to give feedback to the user
        readyBtn.textContent = isReady ? 'Unready' : 'Ready Up';
        readyBtn.classList.toggle('ready', isReady);
    });

    window.addEventListener('keydown', (event) => { /* ... keyboard shortcut logic (WASD, QE) ... */ });
    
    // Event listeners for all the timeline control buttons.
    document.getElementById('split-timeline-btn').addEventListener('click', () => { /* ... */ });
    document.getElementById('rollback-timeline-btn').addEventListener('click', () => { /* ... */ });
    document.getElementById('anchor-timeline-btn').addEventListener('click', () => { /* ... */ });
    document.getElementById('freeze-timeline-btn').addEventListener('click', () => { /* ... */ });
    document.getElementById('overclock-timeline-btn').addEventListener('click', () => { /* ... */ });
    document.getElementById('hop-timeline-btn').addEventListener('click', () => { /* ... */ });

    // --- 6. START THE RENDER LOOP ---
    // This function starts the continuous rendering process.
    function animationLoop() {
        render();
        requestAnimationFrame(animationLoop);
    }
    requestAnimationFrame(animationLoop);
};