// public/client.js

/**
 * @file Manages all client-side logic for the Dominion game, including rendering,
 * user input, and communication with the server via Socket.io.
 * @author CSA
 */

window.onload = function() {
    console.log("Client script loaded!");
    const socket = io();

    // --- 1. LOCAL STATE & CONSTANTS ---

    const BASE_TILE_SIZE = 20;
    let PLAYER_COLORS = { 0: '#333333' };
    const TILE_TYPE = { EMPTY: 0, MOUNTAIN: 1, CITY: 2, GENERAL: 3, FOREST: 4, ERASED: 5 };
    const MOVE_TICKS = 2;
    const GAME_TICK_MS = 125;
    
    /**
     * Client-side cost calculation functions for displaying costs in the UI.
     * These functions provide immediate feedback to the player about the resource cost of a potential action.
     * @param {number} duration - The duration of the effect in game steps.
     * @returns {number} The calculated cost in army units.
     */
    function calculateFreezeCost(duration) { return Math.floor(15 * Math.pow(1.07, duration / 5)); }
    function calculateOverclockCost(duration) { return Math.floor(20 * Math.pow(1.08, duration / 5)); }
    function calculatePortalCost(duration) { return Math.floor(40 * Math.pow(1.06, duration / 5)); }
    const COST_CALCULATORS = { FREEZE: calculateFreezeCost, OVERCLOCK: calculateOverclockCost, HOP: calculatePortalCost };

    /**
     * @type {object} localGameState - The primary container for all game state data received from the server.
     * This object is treated as immutable within a single client tick and is completely replaced upon receiving a 'game-state-update' event.
     */
    let localGameState = {
        multiverse: {},
        portals: [],
        paradoxEvents: [],
        visibility: {}, // Maps timelineId to a visibility grid.
        boardDimensions: { cols: 40, rows: 30 },
        playerStats: {},
        settings: {}
    };

    // --- Player and session state ---
    let myPlayerId = null;
    let myColor = '#FFFFFF';
    let activeTimelineId = 'timeline-alpha';
    let isReady = false;
    let isHost = false;
    let players = [];
    
    // --- UI and Interaction State ---
    let lastServerUpdate = performance.now();
    let inputState = { isDragging: false, startTile: null, path: [], endTile: null, isSplitMove: false };
    let selectedTile = null;
    let isFogOfWarEnabled = true;
    let previouslyVisibleEnemies = {}; 
    let timelineAlerts = {}; 
    let hoveredTimelineId = null;
    let timelineTreeHitboxes = []; 
    const treeCamera = { y: 0, targetY: 0 };
    let isMouseOverTree = false;
    let historyPreviewState = { timelineId: null, step: null, gameState: null };
    let scrubberState = { active: false, timelineId: null };

    // Game Camera
    const camera = { x: 0, y: 0, zoom: 1.0, minZoom: 0.3, maxZoom: 3.0 };
    let panningState = { isPanning: false, lastMouseX: 0, lastMouseY: 0 };

    // --- DOM Element Caching ---
    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 1280; canvas.height = 720;
    
    const treeCanvas = document.getElementById('timeline-tree-canvas');
    const treeCtx = treeCanvas.getContext('2d');
    const timelineScrubber = document.getElementById('timeline-scrubber');

    const historyPreviewContainer = document.getElementById('history-preview-container');
    const historyPreviewCanvas = document.getElementById('history-preview-canvas');
    const historyPreviewCtx = historyPreviewCanvas.getContext('2d');
    const historyPreviewInfo = document.getElementById('history-preview-info');

    const readyBtn = document.getElementById('ready-btn');
    const timelineControls = document.getElementById('timeline-controls');
    const timelineListContainer = document.getElementById('timeline-list-container');
    const customizationContainer = document.getElementById('customization-container');
    const allCustomizationInputs = [document.getElementById('fogToggle'), document.getElementById('staggeredStartToggle'), document.getElementById('fairGeneralsToggle'), document.getElementById('mountainPercent'), document.getElementById('forestPercent'), document.getElementById('cityCount')];
    
    const modalOverlay = document.getElementById('custom-modal-overlay');
    const modalTitle = document.getElementById('modal-title');
    const modalMessage = document.getElementById('modal-message');
    const modalInput = document.getElementById('modal-input');
    const modalCostDisplay = document.getElementById('modal-cost-display');
    const modalConfirmBtn = document.getElementById('modal-confirm-btn');
    const modalCancelBtn = document.getElementById('modal-cancel-btn');

    /**
     * Displays a customizable modal dialog for user interaction, such as input or confirmation.
     * This function abstracts the modal's DOM manipulation and event handling into a reusable Promise-based interface.
     * @param {object} config - The configuration for the modal.
     * @param {string} config.title - The title to display in the modal header.
     * @param {string} config.message - The instructional message to show the user.
     * @param {boolean} [config.showInput=false] - Whether to show a numerical input field.
     * @param {string} [config.defaultValue=''] - The default value for the input field.
     * @param {string} [config.costText=''] - Optional text to display resource costs.
     * @param {string} [config.confirmText='Confirm'] - The text for the confirm button.
     * @param {string} [config.cancelText='Cancel'] - The text for the cancel button.
     * @returns {Promise<string|boolean>} A promise that resolves with the input value if an input is shown, or `true` on confirmation. The promise rejects if the user cancels the action.
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

    // --- 2. SOCKET.IO EVENT HANDLERS ---

    /**
     * Handles the 'player-assignment' event from the server.
     * This function is called once when the client connects and is assigned a unique player ID and color by the server.
     * @param {object} data - The assignment data from the server.
     * @param {number} data.playerId - The unique ID for this player.
     * @param {string} data.color - The hexadecimal color string assigned to this player.
     */
    function onPlayerAssignment(data) {
        myPlayerId = data.playerId;
        myColor = data.color;
        const playerIdDisplay = document.getElementById('player-id-display');
        if (playerIdDisplay) {
            playerIdDisplay.textContent = `You are Player ${myPlayerId}`;
            playerIdDisplay.style.color = myColor;
        }
    }

    /**
     * Handles the 'lobby-update' event, which syncs the lobby state, including the player list and game settings.
     * This is called whenever a player joins, leaves, readies up, or when the host changes a game setting.
     * @param {object} data - The lobby update data.
     * @param {Array<object>} data.players - The list of all players currently in the lobby.
     * @param {object} data.settings - The current game settings.
     * @param {string} data.hostPlayerId - The ID of the current host player.
     */
    function onLobbyUpdate({ players: playerList, settings, hostPlayerId }) {
        players = playerList;
        PLAYER_COLORS = { 0: '#333333' };
        players.forEach(p => { PLAYER_COLORS[p.id] = p.color; });
        isHost = myPlayerId === hostPlayerId;
        updatePlayerListView(hostPlayerId);
        updateLobbyUI(settings);
    }
    
    /**
     * Handles incoming 'game-state-update' events from the server. This is the primary function for syncing the client's game state with the server.
     * It performs a critical sequence of operations:
     * 1. Stores the currently active timeline's state *before* the update. This is crucial for correctly handling cases where the active timeline is deleted.
     * 2. Overwrites the entire local game state with the new state from the server. This is the source of truth.
     * 3. Validates the `activeTimelineId`. If the previously active timeline no longer exists in the new state, it intelligently selects a new active timeline, preferring the parent of the deleted timeline or falling back to the first available one.
     * This corrected order of operations prevents race conditions and ensures the client renderer always has valid data, fixing bugs related to fog of war and timeline display.
     * @param {object} newState - The comprehensive new game state from the server.
     */
    function onGameStateUpdate(newState) {
        // First, capture the state of the currently active timeline *before* we overwrite everything.
        // This is essential for a graceful fallback if the active timeline gets removed (e.g., due to an unravel event).
        const oldTimelineBeforeUpdate = localGameState.multiverse ? localGameState.multiverse[activeTimelineId] : null;
    
        // Immediately update the local game state. All subsequent logic MUST operate on this new state.
        localGameState = newState;
    
        // Now, validate the activeTimelineId against the new state.
        if (!localGameState.multiverse[activeTimelineId]) {
            // The timeline we were viewing no longer exists. We must select a new one.
            // Our first preference is to switch to the parent of the timeline that was just removed.
            if (oldTimelineBeforeUpdate && localGameState.multiverse[oldTimelineBeforeUpdate.parentId]) {
                activeTimelineId = oldTimelineBeforeUpdate.parentId;
            } else {
                // If the parent doesn't exist or we didn't have a previous timeline,
                // fall back to the first timeline in the multiverse object or the default 'timeline-alpha'.
                activeTimelineId = Object.keys(localGameState.multiverse)[0] || 'timeline-alpha';
            }
        }
    
        // Reset the timer used for client-side move interpolation.
        lastServerUpdate = performance.now();
    
        // Update enemy visibility and timeline alerts based on the new visibility data.
        if (localGameState.visibility && Object.keys(localGameState.visibility).length > 0) {
            for (const timelineId in localGameState.multiverse) {
                const currentVisibleEnemies = new Set();
                const gameState = localGameState.multiverse[timelineId].currentState;
                const visibilityGrid = localGameState.visibility[timelineId];
                if (!visibilityGrid) continue;
    
                for (let r = 0; r < localGameState.boardDimensions.rows; r++) {
                    for (let c = 0; c < localGameState.boardDimensions.cols; c++) {
                        if (visibilityGrid[r][c]) {
                            const tile = gameState.board[r][c];
                            if (tile && tile.ownerId !== 0 && tile.ownerId !== myPlayerId) {
                                currentVisibleEnemies.add(tile.ownerId);
                            }
                        }
                    }
                }
    
                const previouslyVisible = previouslyVisibleEnemies[timelineId] || new Set();
                let newSighting = false;
                for (const enemyId of currentVisibleEnemies) {
                    if (!previouslyVisible.has(enemyId)) {
                        newSighting = true;
                        break;
                    }
                }
    
                if (newSighting && timelineId !== activeTimelineId) {
                    timelineAlerts[timelineId] = Date.now();
                }
                previouslyVisibleEnemies[timelineId] = currentVisibleEnemies;
            }
        }
    
        // Clear any alert for the timeline we are currently viewing.
        if (timelineAlerts[activeTimelineId]) {
            delete timelineAlerts[activeTimelineId];
        }
    
        // Update UI elements with new data.
        updatePlayerListView(null); // Host ID isn't needed here, just army counts.
        const splitBtn = document.getElementById('split-timeline-btn');
        if (splitBtn && localGameState.multiverse) {
            const numTimelines = Object.keys(localGameState.multiverse).length;
            splitBtn.textContent = `Split Timeline (Cost: ${Math.floor(250 * Math.pow(1.25, numTimelines - 1))})`;
        }
        
        // Handle staggered start UI visibility.
        if (localGameState.settings && localGameState.settings.staggeredStart) {
            const totalArmy = localGameState.playerStats?.global?.[myPlayerId]?.army || 0;
            if (totalArmy >= 1000) {
                timelineControls.classList.remove('hidden');
                timelineListContainer.classList.remove('hidden');
            } else {
                timelineControls.classList.add('hidden');
                timelineListContainer.classList.add('hidden');
            }
        } else {
            timelineControls.classList.remove('hidden');
            timelineListContainer.classList.remove('hidden');
        }
    }

    /**
     * Handles the 'game-start' event. This function transitions the UI from the lobby view to the game view.
     * @param {object} data - Contains the final game settings for this match.
     * @param {object} data.settings - The game settings.
     */
    function onGameStart({ settings }) {
        document.getElementById('game-status').innerText = "";
        readyBtn.style.display = 'none';
        customizationContainer.classList.add('hidden');
        isFogOfWarEnabled = settings.fogOfWar;
        previouslyVisibleEnemies = {};
        timelineAlerts = {};
    }

    /**
     * Handles the 'game-over' event, displaying the result of the match and resetting the UI back to the lobby state.
     * @param {object} data - Contains the winner's ID.
     * @param {number|string} data.winnerId - The ID of the winning player, or a string indicating another reason for the game ending.
     */
    function onGameOver(data) {
        const statusDiv = document.getElementById('game-status');
        if (data.winnerId === myPlayerId) {
            statusDiv.innerText = "You are victorious!";
        } else {
            statusDiv.innerText = `Game Over! Player ${data.winnerId} is the winner.`;
        }
        readyBtn.style.display = 'block';
        customizationContainer.classList.remove('hidden');
        timelineControls.classList.add('hidden');
        timelineListContainer.classList.add('hidden');
        isReady = false;
        readyBtn.classList.remove('ready');
        readyBtn.textContent = 'Ready Up';
    }

    /**
     * Handles the 'game-in-progress' event, which prevents a player from joining a match that has already started.
     */
    function onGameInProgress() {
        document.body.innerHTML = '<h1>Game in progress. Please wait for the next round.</h1>';
    }

    /**
     * Handles the response for a rollback information request. It opens a modal dialog for the player to input the desired rollback step.
     * @param {object} data - Contains information about the affordable rollback limit.
     * @param {number} data.oldestAffordableStep - The oldest game step the player can afford to roll back to.
     */
    function onRollbackInfoResponse({ oldestAffordableStep }) {
        const currentStep = localGameState.multiverse[activeTimelineId]?.currentState.gameStep;
        if (!currentStep) return;
        showModal({ title: 'Timeline Rollback', message: `Select a step to roll back to. Current step: ${currentStep}. Oldest affordable step: ${oldestAffordableStep}.`, showInput: true, defaultValue: oldestAffordableStep })
            .then(targetStepInput => {
                const targetStep = parseInt(targetStepInput);
                if (!Number.isInteger(targetStep) || targetStep < oldestAffordableStep || targetStep >= currentStep) {
                    showModal({ title: 'Error', message: 'Invalid or unaffordable step number.' });
                    return;
                }
                const stepsToRollback = currentStep - targetStep;
                const cost = Math.floor(10 * Math.pow(1.05, stepsToRollback / 10));
                return showModal({ title: 'Confirm Rollback', message: `This will roll back ${stepsToRollback} steps to step ${targetStep}.`, costText: `Estimated Cost: ${cost} army`, })
                    .then(() => {
                        socket.emit('player-action', { type: 'ROLLBACK', activeTimelineId: activeTimelineId, targetStep: targetStep });
                    });
            }).catch(() => {});
    }

    /**
     * Handles the response for an affordability check on time-based actions (Freeze, Overclock, Hop).
     * It opens a modal for the player to set the duration of the action.
     * @param {object} data - The affordability data.
     * @param {string} data.actionType - The type of action (e.g., 'FREEZE').
     * @param {number} data.maxDuration - The maximum affordable duration in game steps.
     */
    function onAffordabilityInfoResponse({ actionType, maxDuration }) {
        if (maxDuration <= 0) {
            showModal({ title: 'Unaffordable', message: 'You do not have enough army on your General to perform this action.' });
            return;
        }
        showModal({ title: `Set ${actionType} Duration`, message: `Enter duration for ${actionType} (in steps). Maximum affordable is ${maxDuration} steps.`, showInput: true, defaultValue: maxDuration })
            .then(durationInput => {
                const duration = parseInt(durationInput);
                if (!Number.isInteger(duration) || duration <= 0 || duration > maxDuration) {
                    showModal({ title: 'Error', message: 'Invalid or unaffordable duration.' });
                    return;
                }
                const costCalculator = COST_CALCULATORS[actionType];
                if (!costCalculator) return;
                const cost = costCalculator(duration);
                return showModal({ title: `Confirm ${actionType}`, message: `This action will last for ${duration} steps.`, costText: `Cost: ${cost} army`, })
                    .then(() => {
                        const action = { type: actionType, activeTimelineId: activeTimelineId, duration: duration, cost: cost };
                        if (actionType === 'HOP') {
                            if (selectedTile) {
                                action.selectedTile = selectedTile;
                            } else {
                                showModal({ title: 'Error', message: 'You must select a tile to open a portal.' });
                                return;
                            }
                        }
                        socket.emit('player-action', action);
                    });
            }).catch(() => {});
    }
    
    // Assigning all socket event listeners
    socket.on('player-assignment', onPlayerAssignment);
    socket.on('lobby-update', onLobbyUpdate);
    socket.on('game-state-update', onGameStateUpdate);
    socket.on('game-start', onGameStart);
    socket.on('game-over', onGameOver);
    socket.on('game-in-progress', onGameInProgress);
    socket.on('rollback-info-response', onRollbackInfoResponse);
    socket.on('affordability-info-response', onAffordabilityInfoResponse);

    // --- 3. RENDERING & HELPER FUNCTIONS ---

    /**
     * Updates the player list UI element with current player names, ready status, and army counts for the active timeline.
     * @param {number|null} hostPlayerId - The ID of the host player, to label them as "(Host)". Can be null if not in lobby.
     */
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

    /**
     * Updates the game customization UI based on the current settings received from the server.
     * Also disables the inputs if the current player is not the host.
     * @param {object} settings - The current game settings object.
     */
    function updateLobbyUI(settings) {
        allCustomizationInputs.forEach(input => input.disabled = !isHost);
        allCustomizationInputs[0].checked = settings.fogOfWar;
        allCustomizationInputs[1].checked = settings.staggeredStart;
        allCustomizationInputs[2].checked = settings.fairGenerals;
        allCustomizationInputs[3].value = settings.mountainPercent;
        allCustomizationInputs[4].value = settings.forestPercent;
        allCustomizationInputs[5].value = settings.cityCount;
    }
    
    /**
     * Calculates a color based on a causality tag's "age".
     * This is used to visually represent how "old" an army is relative to the current timeline's step,
     * giving a visual cue about its origins.
     * @param {object} tag - The causality tag, containing an originStep.
     * @param {number} currentStep - The current game step of the timeline.
     * @returns {string} An RGB color string.
     */
    function getCausalityColor(tag, currentStep) {
        if (!tag) return '#FFFFFF'; // Default color for untagged entities.
        const age = currentStep - tag.originStep;
        // Normalize age to a 0-100 scale for color interpolation.
        const normalizedAge = Math.min(Math.max(age, 0), 100); 
        // Interpolate from a dark red (old) to a bright cyan (new).
        const r = Math.floor(139 + (255 - 139) * (normalizedAge / 100));
        const g = Math.floor(0 + (182 - 0) * (normalizedAge / 100));
        const b = Math.floor(0 + (193 - 0) * (normalizedAge / 100));
        return `rgb(${r},${g},${b})`;
    }

    /**
     * The main rendering function for the game board, armies, and UI elements.
     * This function is called on every animation frame.
     */
    function render() {
        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Apply camera transformations (pan and zoom).
        ctx.translate(camera.x, camera.y);
        ctx.scale(camera.zoom, camera.zoom);

        const currentTimeline = localGameState.multiverse[activeTimelineId];
        const currentVisibility = localGameState.visibility ? localGameState.visibility[activeTimelineId] : undefined;

        // If there's no active timeline data, display a waiting message.
        if (!currentTimeline) {
            ctx.restore(); // Restore context before drawing UI text.
            ctx.fillStyle = 'white';
            ctx.font = '24px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Waiting for players to ready up...', canvas.width / 2, canvas.height / 2);
            renderTimelineTree();
            return;
        }

        const activeGameState = currentTimeline.currentState;
        const TILE_SIZE = BASE_TILE_SIZE;

        // Culling: Calculate which grid cells are visible in the current viewport.
        const view = { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, width: canvas.width / camera.zoom, height: canvas.height / camera.zoom };
        const startCol = Math.floor(view.x / TILE_SIZE);
        const endCol = Math.ceil((view.x + view.width) / TILE_SIZE);
        const startRow = Math.floor(view.y / TILE_SIZE);
        const endRow = Math.ceil((view.y + view.height) / TILE_SIZE);

        // --- Render Tiles ---
        for (let row = startRow; row < endRow; row++) {
            for (let col = startCol; col < endCol; col++) {
                if (row < 0 || row >= localGameState.boardDimensions.rows || col < 0 || col >= localGameState.boardDimensions.cols) continue;
                const x = col * TILE_SIZE, y = row * TILE_SIZE;
                
                // --- Render Fog of War ---
                if (isFogOfWarEnabled && currentVisibility && !currentVisibility[row]?.[col]) {
                    ctx.fillStyle = '#111111'; // Dark gray for fog.
                    ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
                    continue; // Skip rendering the actual tile underneath.
                }

                const tile = activeGameState.board[row]?.[col];
                if (!tile) continue;
                if (tile.type === TILE_TYPE.ERASED) { ctx.fillStyle = '#000000'; ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE); continue; }
                
                // --- Render Tile Base Color ---
                ctx.fillStyle = PLAYER_COLORS[tile.ownerId] || '#FFFFFF';
                if (tile.type === TILE_TYPE.MOUNTAIN) ctx.fillStyle = '#555555';
                else if (tile.type === TILE_TYPE.FOREST) ctx.fillStyle = '#006400';
                ctx.fillRect(x, y, TILE_SIZE - 1, TILE_SIZE - 1); // -1 for grid lines
                
                // --- Render Portals ---
                const isPortal = localGameState.portals.some(p => p.fromTimelineId === activeTimelineId && p.coords.row === row && p.coords.col === col);
                if (isPortal) { ctx.fillStyle = '#8A2BE2'; ctx.beginPath(); ctx.arc(x + TILE_SIZE * 0.75, y + TILE_SIZE * 0.25, TILE_SIZE / 5, 0, Math.PI * 2); ctx.fill(); }
                
                // --- Render Tile Decorators (General, City) ---
                if (tile.type === TILE_TYPE.GENERAL) { ctx.fillStyle = '#490c3aff'; ctx.beginPath(); ctx.arc(x + TILE_SIZE / 2, y + TILE_SIZE / 2, TILE_SIZE / 4, 0, Math.PI * 2); ctx.fill(); }
                else if (tile.type === TILE_TYPE.CITY) { ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2 / camera.zoom; ctx.strokeRect(x + 1, y + 1, TILE_SIZE - 3, TILE_SIZE - 3); }
                
                // --- Render Army Counts ---
                if (tile.army > 0 && tile.type !== TILE_TYPE.MOUNTAIN && camera.zoom > 0.5) {
                    const isMyTile = tile.ownerId === myPlayerId;
                    const isArmyVisible = (tile.type !== TILE_TYPE.FOREST) || isMyTile;
                    if (isArmyVisible) {
                        ctx.fillStyle = getCausalityColor(tile.causalityTag, activeGameState.gameStep);
                        ctx.font = `bold ${TILE_SIZE / 2}px sans-serif`;
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(tile.army, x + TILE_SIZE / 2, y + TILE_SIZE / 2);
                    }
                }
            }
        }
        
        // --- Render Unraveling Effect ---
        if (currentTimeline.isUnravelling && currentTimeline.unravelCenter) {
            ctx.fillStyle = 'rgba(255, 0, 255, 0.2)';
            ctx.beginPath();
            const centerX = currentTimeline.unravelCenter.col * TILE_SIZE + TILE_SIZE / 2;
            const centerY = currentTimeline.unravelCenter.row * TILE_SIZE + TILE_SIZE / 2;
            ctx.arc(centerX, centerY, currentTimeline.unravelRadius * TILE_SIZE, 0, Math.PI * 2);
            ctx.fill();
        }

        // --- Render Moving Armies with Interpolation ---
        const activeTimelinesCount = Object.keys(localGameState.multiverse).filter(id => !localGameState.multiverse[id].isFrozen).length || 1;
        const tickDurationMs = GAME_TICK_MS * activeTimelinesCount;
        const segmentDuration = tickDurationMs * MOVE_TICKS;
        for (const move of activeGameState.moves) {
            const currentPos = move.path[move.pathIndex];
            if (isFogOfWarEnabled && currentVisibility && !currentVisibility[currentPos.row]?.[currentPos.col]) {
                continue; // Don't render armies inside the fog.
            }

            const segmentStart = move.path[move.pathIndex];
            const segmentEnd = move.path[move.pathIndex + 1];
            if (!segmentStart || !segmentEnd) continue;

            const timeSinceUpdate = performance.now() - lastServerUpdate;
            const progressInSegment = (tickDurationMs * move.progress) + timeSinceUpdate;
            const totalFraction = Math.min(progressInSegment / segmentDuration, 1.0); // Clamp to 1.0

            const startX = (segmentStart.col * TILE_SIZE) + (TILE_SIZE / 2);
            const startY = (segmentStart.row * TILE_SIZE) + (TILE_SIZE / 2);
            const endX = (segmentEnd.col * TILE_SIZE) + (TILE_SIZE / 2);
            const endY = (segmentEnd.row * TILE_SIZE) + (TILE_SIZE / 2);
            const currentX = startX + (endX - startX) * totalFraction;
            const currentY = startY + (endY - startY) * totalFraction;

            ctx.beginPath();
            ctx.arc(currentX, currentY, TILE_SIZE / 2, 0, Math.PI * 2);
            ctx.fillStyle = PLAYER_COLORS[move.ownerId];
            ctx.fill();
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 1 / camera.zoom;
            ctx.stroke();

            if (camera.zoom > 0.5) {
                ctx.fillStyle = getCausalityColor(move.causalityTag, activeGameState.gameStep);
                ctx.font = `bold ${TILE_SIZE / 2}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(move.army, currentX, currentY);
            }
        }

        if (localGameState.paradoxEvents) {
            localGameState.paradoxEvents.forEach(event => {
                if (event.timelineId === activeTimelineId) {
                    const { row, col } = event.coords;
                    const x = col * TILE_SIZE, y = row * TILE_SIZE;
                    
                    // Check if the effect is within the visible culling area
                    if (row >= startRow && row < endRow && col >= startCol && col < endCol) {
                        const effectRadius = (event.duration / 30) * TILE_SIZE * 0.7;
                        const effectOpacity = (event.duration / 30);

                        ctx.fillStyle = `rgba(255, 0, 0, ${effectOpacity})`;
                        ctx.strokeStyle = `rgba(255, 100, 100, ${effectOpacity})`;
                        ctx.lineWidth = 2 / camera.zoom;

                        ctx.beginPath();
                        ctx.arc(x + TILE_SIZE / 2, y + TILE_SIZE / 2, effectRadius, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.stroke();
                    }
                }
            });
        }

        // --- Render Player Input (Path Drawing) ---
        if (inputState.isDragging && inputState.path.length > 0) {
            ctx.strokeStyle = '#FFFFFF';
            if (inputState.isSplitMove) { ctx.setLineDash([5, 10]); }
            ctx.lineWidth = 2 / camera.zoom;
            ctx.beginPath();
            const firstTile = inputState.path[0];
            ctx.moveTo((firstTile.col * TILE_SIZE) + (TILE_SIZE / 2), (firstTile.row * TILE_SIZE) + (TILE_SIZE / 2));
            for (let i = 1; i < inputState.path.length; i++) {
                const tile = inputState.path[i];
                ctx.lineTo((tile.col * TILE_SIZE) + (TILE_SIZE / 2), (tile.row * TILE_SIZE) + (TILE_SIZE / 2));
            }
            if (inputState.endTile) { ctx.lineTo((inputState.endTile.col * TILE_SIZE) + (TILE_SIZE / 2), (inputState.endTile.row * TILE_SIZE) + (TILE_SIZE / 2)); }
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // --- Render Selected Tile Highlight ---
        if (selectedTile) {
            const x = selectedTile.col * TILE_SIZE, y = selectedTile.row * TILE_SIZE;
            ctx.strokeStyle = '#FFFF00'; // Bright yellow for selection.
            ctx.lineWidth = 3 / camera.zoom;
            ctx.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
        }

        ctx.restore(); // Restore context to pre-camera state.

        // Render UI overlays.
        renderTimelineTree();
        renderHistoryPreview();
    }
    
    /**
     * Renders the interactive timeline tree structure on its dedicated canvas.
     */
    function renderTimelineTree() { const PADDING = 20; const X_SPACING = 50; const Y_SCALE = 0.5; treeCtx.clearRect(0, 0, treeCanvas.width, treeCanvas.height); treeCtx.save(); if (!localGameState.multiverse || Object.keys(localGameState.multiverse).length === 0) { treeCtx.restore(); return; } timelineTreeHitboxes = []; const t = {}; const l = {}; function a(id, L) { if (l[id] !== undefined) return; l[id] = L; Object.values(localGameState.multiverse).forEach(c => { if (c.parentId === id) a(c.id, L + 1); }); } a('timeline-alpha', 0); Object.keys(l).forEach(id => { const L = l[id]; t[id] = { x: PADDING + L * X_SPACING }; }); const A = localGameState.multiverse['timeline-alpha']; if (A) { const y = PADDING + A.currentState.gameStep * Y_SCALE; treeCamera.targetY = y - (treeCanvas.height / 2); } if (!isMouseOverTree) { treeCamera.y += (treeCamera.targetY - treeCamera.y) * 0.05; } treeCtx.translate(0, -treeCamera.y); treeCtx.fillStyle = '#FFFFFF'; treeCtx.strokeStyle = '#FFFFFF'; treeCtx.font = '12px "Courier New", monospace'; for (const id in localGameState.multiverse) { const m = localGameState.multiverse[id]; const p = t[id]; if (!p) continue; const sY = PADDING + m.splitStep * Y_SCALE; const eY = PADDING + m.currentState.gameStep * Y_SCALE; const top = Math.min(sY, eY); const bot = Math.max(sY, eY); if (bot < treeCamera.y - PADDING || top > treeCamera.y + treeCanvas.height + PADDING) continue; treeCtx.beginPath(); treeCtx.moveTo(p.x, sY); treeCtx.lineTo(p.x, eY); treeCtx.lineWidth = m.id === activeTimelineId ? 4 : 2; treeCtx.strokeStyle = m.isUnravelling ? '#FF00FF' : '#FFFFFF'; treeCtx.stroke(); if (m.parentId && t[m.parentId]) { const P = t[m.parentId]; treeCtx.beginPath(); treeCtx.moveTo(P.x, sY); treeCtx.lineTo(p.x, sY); treeCtx.lineWidth = 1; treeCtx.strokeStyle = '#888888'; treeCtx.stroke(); } treeCtx.beginPath(); treeCtx.arc(p.x, eY, 5, 0, Math.PI * 2); let nC = m.id === activeTimelineId ? '#007bff' : '#FFFFFF'; if (timelineAlerts[id]) { const S = Date.now() - timelineAlerts[id]; if (S > 5000) { delete timelineAlerts[id]; } else if (Math.floor(S / 250) % 2 === 0) { nC = '#FF0000'; } } treeCtx.fillStyle = nC; treeCtx.fill(); timelineTreeHitboxes.push({ id: id, x: p.x, y: eY, startY: sY, radius: 10 }); const d = id.split('-'); const D = d[1] || '???'; treeCtx.fillStyle = '#FFFFFF'; treeCtx.fillText(D, p.x + 10, eY + 4); } if (hoveredTimelineId && t[hoveredTimelineId]) { const T = localGameState.multiverse[hoveredTimelineId]; const p = t[hoveredTimelineId]; const eY = PADDING + T.currentState.gameStep * Y_SCALE; const txt = hoveredTimelineId; const m = treeCtx.measureText(txt); const w = m.width + 10; const h = 18; const bX = p.x + 15; const bY = eY - (h / 2); treeCtx.fillStyle = 'rgba(0, 0, 0, 0.8)'; treeCtx.fillRect(bX, bY, w, h); treeCtx.strokeStyle = '#007bff'; treeCtx.strokeRect(bX, bY, w, h); treeCtx.fillStyle = '#FFFFFF'; treeCtx.textAlign = 'left'; treeCtx.textBaseline = 'middle'; treeCtx.fillText(txt, bX + 5, bY + h / 2); } treeCtx.restore(); }
    
    /**
     * A client-side simulation of a single game tick. Used for reconstructing historical game states for the history preview feature.
     * This must stay in sync with the server's primary game logic.
     * @param {object} gameState - The game state object to advance by one step.
     */
    function client_runSingleTickLogic(gameState) { for (let i = gameState.moves.length - 1; i >= 0; i--) { const m = gameState.moves[i]; m.progress++; if (m.progress >= MOVE_TICKS) { m.progress = 0; const f = m.pathIndex >= m.path.length - 2; if (f) { const a = m.path[m.pathIndex + 1]; const t = gameState.board[a.row][a.col]; if (t.ownerId !== m.ownerId) { if (m.army > t.army) { t.ownerId = m.ownerId; t.army = m.army - t.army; } else { t.army -= m.army; } } else { t.army += m.army; } gameState.moves.splice(i, 1); } else { m.pathIndex++; } } } gameState.gameStep++; for (let r = 0; r < localGameState.boardDimensions.rows; r++) { for (let c = 0; c < localGameState.boardDimensions.cols; c++) { const t = gameState.board[r][c]; if (t.ownerId !== 0) { if ((t.type === TILE_TYPE.GENERAL || t.type === TILE_TYPE.CITY) && gameState.gameStep % 4 === 0) t.army++; else if ((t.type === TILE_TYPE.EMPTY || t.type === TILE_TYPE.FOREST) && gameState.gameStep % 20 === 0) t.army++; } } } }
    
    /**
     * Reconstructs a game state at a specific step in the past by starting from the nearest preceding keyframe and simulating forward.
     * @param {object} timeline - The timeline object containing the keyframes.
     * @param {number} targetStep - The desired game step to reconstruct.
     * @returns {object|null} The reconstructed game state, or null if it's not possible.
     */
    function reconstructGameState(timeline, targetStep) { const k = [...timeline.keyframes].reverse().find(kf => kf.step <= targetStep); if (!k) return null; let s = JSON.parse(JSON.stringify(k.gameState)); for (let i = k.step; i < targetStep; i++) { client_runSingleTickLogic(s); } s.gameStep = targetStep; return s; }
    
    /**
     * Calculates a visibility grid for a given historical game state, used for the history preview.
     * @param {object} gameState - The historical game state.
     * @param {number} playerId - The ID of the player to calculate visibility for.
     * @returns {Array<Array<boolean>>} A 2D boolean array representing the visibility grid.
     */
    function calculateHistoricalVisibility(gameState, playerId) { const { rows, cols } = localGameState.boardDimensions; const g = Array(rows).fill(null).map(() => Array(cols).fill(false)); const r = 2; for (let R = 0; R < rows; R++) { for (let c = 0; c < cols; c++) { if (gameState.board[R][c].ownerId === playerId) { for (let sR = R - r; sR <= R + r; sR++) { for (let sC = c - r; sC <= c + r; sC++) { if (sR >= 0 && sR < rows && sC >= 0 && sC < cols) { g[sR][sC] = true; } } } } } } return g; }
    
    /**
     * Renders the history preview mini-map if a historical state is currently selected via the timeline scrubber.
     */
    function renderHistoryPreview() { if (!historyPreviewState.gameState) { historyPreviewContainer.classList.add('hidden'); if (treeCanvas.height !== 600) { treeCanvas.height = 600; } return; } historyPreviewContainer.classList.remove('hidden'); if (treeCanvas.height !== 250) { treeCanvas.height = 250; } const { board, gameStep } = historyPreviewState.gameState; const { rows, cols } = localGameState.boardDimensions; const v = calculateHistoricalVisibility(historyPreviewState.gameState, myPlayerId); let gP = null; let gA = 'N/A'; for (let r = 0; r < rows; r++) { for (let c = 0; c < cols; c++) { if (board[r][c].type === TILE_TYPE.GENERAL && board[r][c].ownerId === myPlayerId) { gP = { row: r, col: c }; gA = board[r][c].army; break; } } if (gP) break; } if (!gP) { gP = { row: Math.floor(rows / 2), col: Math.floor(cols / 2) }; } const V = 17; const tW = historyPreviewCanvas.width / V; const tH = historyPreviewCanvas.height / V; const sR = gP.row - Math.floor(V / 2); const sC = gP.col - Math.floor(V / 2); historyPreviewCtx.clearRect(0, 0, historyPreviewCanvas.width, historyPreviewCanvas.height); for (let r = 0; r < V; r++) { for (let c = 0; c < V; c++) { const mR = sR + r; const mC = sC + c; if (mR < 0 || mR >= rows || mC < 0 || mC >= cols) continue; if (!v[mR][mC]) { historyPreviewCtx.fillStyle = '#111'; historyPreviewCtx.fillRect(c * tW, r * tH, tW, tH); continue; } const t = board[mR][mC]; historyPreviewCtx.fillStyle = PLAYER_COLORS[t.ownerId] || '#333'; if (t.type === TILE_TYPE.MOUNTAIN) historyPreviewCtx.fillStyle = '#555'; historyPreviewCtx.fillRect(c * tW, r * tH, tW, tH); } } historyPreviewInfo.innerHTML = `Preview: <span>${historyPreviewState.timelineId.split('-')[1]}</span><br/>Step: <span>${gameStep}</span><br/>Your General's Army: <span>${gA}</span>`; }
    
    // --- 4. INPUT EVENT LISTENERS ---

    function getTileFromMouseEvent(event) { const r = canvas.getBoundingClientRect(); const x = (event.clientX - r.left - camera.x) / camera.zoom; const y = (event.clientY - r.top - camera.y) / camera.zoom; const col = Math.floor(x / BASE_TILE_SIZE); const row = Math.floor(y / BASE_TILE_SIZE); if (row >= 0 && row < localGameState.boardDimensions.rows && col >= 0 && col < localGameState.boardDimensions.cols) return { row, col }; return null; }
    function handleMouseDown(event) { const t = getTileFromMouseEvent(event); if (!t) return; if (event.button === 0 || event.button === 2) { inputState.isDragging = true; inputState.startTile = t; inputState.path = [t]; inputState.endTile = t; inputState.isSplitMove = (event.button === 2); } else if (event.button === 1) { event.preventDefault(); panningState.isPanning = true; panningState.lastMouseX = event.clientX; panningState.lastMouseY = event.clientY; } }
    function handleMouseMove(event) { if (inputState.isDragging) { const c = getTileFromMouseEvent(event); if (c) { inputState.endTile = c; let l = inputState.path[inputState.path.length - 1]; while (c.row !== l.row || c.col !== l.col) { const dX = c.col - l.col; const dY = c.row - l.row; let n = { row: l.row, col: l.col }; if (Math.abs(dX) > Math.abs(dY)) { n.col += Math.sign(dX); } else { n.row += Math.sign(dY); } const t = localGameState.multiverse[activeTimelineId]; if (!t) break; const T = t.currentState.board[n.row]?.[n.col]; if (T && T.type !== TILE_TYPE.MOUNTAIN) { if (n.row !== l.row || n.col !== l.col) { inputState.path.push(n); l = n; } } else { break; } } } } else if (panningState.isPanning) { const dX = event.clientX - panningState.lastMouseX; const dY = event.clientY - panningState.lastMouseY; camera.x += dX; camera.y += dY; panningState.lastMouseX = event.clientX; panningState.lastMouseY = event.clientY; } }
    function handleMouseUp(event) { if (event.button === 0 || event.button === 2) { if (inputState.isDragging) { if (inputState.path.length > 1) { socket.emit('player-action', { type: 'MOVE', path: inputState.path, isSplit: inputState.isSplitMove, activeTimelineId: activeTimelineId }); selectedTile = null; } else { selectedTile = inputState.startTile; } inputState.isDragging = false; inputState.isSplitMove = false; inputState.startTile = null; inputState.endTile = null; inputState.path = []; } } else if (event.button === 1) { panningState.isPanning = false; } }
    function handleContextMenu(event) { event.preventDefault(); }
    function handleWheel(event) { event.preventDefault(); const r = canvas.getBoundingClientRect(); const mX = event.clientX - r.left; const mY = event.clientY - r.top; const wX = (mX - camera.x) / camera.zoom; const wY = (mY - camera.y) / camera.zoom; const z = event.deltaY > 0 ? 0.9 : 1.1; const nZ = Math.max(camera.minZoom, Math.min(camera.maxZoom, camera.zoom * z)); camera.x = mX - wX * nZ; camera.y = mY - wY * nZ; camera.zoom = nZ; }
    function handleReadyButtonClick() { isReady = !isReady; socket.emit('player-ready', isReady); if (isReady) { readyBtn.textContent = 'Unready'; readyBtn.classList.add('ready'); } else { readyBtn.textContent = 'Ready Up'; readyBtn.classList.remove('ready'); } }
    function handleKeyDown(event) { if (!modalOverlay.classList.contains('hidden')) return; const t = Object.keys(localGameState.multiverse); if (t.length > 1) { const c = t.indexOf(activeTimelineId); let n = c; if (event.key === 'e') n = (c + 1) % t.length; else if (event.key === 'q') n = (c - 1 + t.length) % t.length; if (n !== c) { activeTimelineId = t[n]; updatePlayerListView(); } } if (selectedTile) { let d = null; switch (event.key) { case 'w': case 'ArrowUp': d = { row: selectedTile.row - 1, col: selectedTile.col }; event.preventDefault(); break; case 'a': case 'ArrowLeft': d = { row: selectedTile.row, col: selectedTile.col - 1 }; event.preventDefault(); break; case 's': case 'ArrowDown': d = { row: selectedTile.row + 1, col: selectedTile.col }; event.preventDefault(); break; case 'd': case 'ArrowRight': d = { row: selectedTile.row, col: selectedTile.col + 1 }; event.preventDefault(); break; } if (d) { if (d.row >= 0 && d.row < localGameState.boardDimensions.rows && d.col >= 0 && d.col < localGameState.boardDimensions.cols) { const c = localGameState.multiverse[activeTimelineId]; if (c) { const T = c.currentState.board[d.row]?.[d.col]; if (T && T.type !== TILE_TYPE.MOUNTAIN) { const p = [selectedTile, d]; socket.emit('player-action', { type: 'MOVE', path: p, activeTimelineId: activeTimelineId }); selectedTile = d; } } } } } }
    function handleTimelineTreeClick(event) { const r = treeCanvas.getBoundingClientRect(); const x = event.clientX - r.left; const y = (event.clientY - r.top) + treeCamera.y; let c = false; for (const h of timelineTreeHitboxes) { const d = Math.sqrt(Math.pow(x - h.x, 2) + Math.pow(y - h.y, 2)); if (d < h.radius) { activeTimelineId = h.id; updatePlayerListView(); c = true; break; } } if (c) { historyPreviewState.gameState = null; timelineScrubber.classList.add('hidden'); } else { historyPreviewState.gameState = null; timelineScrubber.classList.add('hidden'); scrubberState.active = false; } }
    function handleTimelineTreeMouseDown(event) { const r = treeCanvas.getBoundingClientRect(); const x = event.clientX - r.left; const y = (event.clientY - r.top) + treeCamera.y; for (const h of timelineTreeHitboxes) { if (Math.abs(x - h.x) < 10 && y >= h.startY && y <= h.y) { scrubberState.active = true; scrubberState.timelineId = h.id; updateScrubberAndPreview(event); return; } } }
    function updateScrubberAndPreview(event) { if (!scrubberState.active) return; const t = localGameState.multiverse[scrubberState.timelineId]; if (!t) return; const r = treeCanvas.getBoundingClientRect(); const y = (event.clientY - r.top); const Y = 0.5; const P = 20; let s = Math.round((y + treeCamera.y - P) / Y); s = Math.max(t.anchorStep, Math.min(s, t.currentState.gameStep)); const R = reconstructGameState(t, s); if (R) { historyPreviewState.timelineId = scrubberState.timelineId; historyPreviewState.step = s; historyPreviewState.gameState = R; const x = timelineTreeHitboxes.find(h => h.id === scrubberState.timelineId).x; const sY = (P + s * Y) - treeCamera.y; const cR = timelineListContainer.getBoundingClientRect(); timelineScrubber.style.left = `${x + r.left - cR.left}px`; timelineScrubber.style.top = `${sY + r.top - cR.top}px`; timelineScrubber.classList.remove('hidden'); } }
    function handleGlobalMouseUp(event) { if (scrubberState.active) { scrubberState.active = false; } }
    function handleGlobalMouseMove(event) { if (scrubberState.active) { updateScrubberAndPreview(event); } }
    function handleTimelineTreeMouseMove(event) { const r = treeCanvas.getBoundingClientRect(); const x = event.clientX - r.left; const y = (event.clientY - r.top) + treeCamera.y; let c = null; let m = Infinity; for (const h of timelineTreeHitboxes) { const d = Math.sqrt(Math.pow(x - h.x, 2) + Math.pow(y - h.y, 2)); if (d < h.radius && d < m) { m = d; c = h.id; } } hoveredTimelineId = c; }
    function handleTimelineTreeMouseOver() { isMouseOverTree = true; }
    function handleTimelineTreeMouseOut() { isMouseOverTree = false; hoveredTimelineId = null; }
    function handleTimelineTreeWheel(event) { if (isMouseOverTree) { event.preventDefault(); treeCamera.y += event.deltaY * 0.5; } }
    function emitSettingsChange() { if (!isHost) return; const n = { fogOfWar: allCustomizationInputs[0].checked, staggeredStart: allCustomizationInputs[1].checked, fairGenerals: allCustomizationInputs[2].checked, mountainPercent: allCustomizationInputs[3].value, forestPercent: allCustomizationInputs[4].value, cityCount: allCustomizationInputs[5].value }; socket.emit('update-game-settings', n); }
    function handleSplitTimelineClick() { socket.emit('player-action', { type: 'SPLIT', activeTimelineId: activeTimelineId }); }
    function handleRollbackTimelineClick() { const c = localGameState.multiverse[activeTimelineId]?.currentState.gameStep; if (!c) return; socket.emit('get-rollback-info', { activeTimelineId }); }
    function handleAnchorTimelineClick() { socket.emit('player-action', { type: 'ANCHOR', activeTimelineId: activeTimelineId }); }
    function handleFreezeTimelineClick() { socket.emit('get-affordability-info', { actionType: 'FREEZE', activeTimelineId: activeTimelineId }); }
    function handleOverclockTimelineClick() { socket.emit('get-affordability-info', { actionType: 'OVERCLOCK', activeTimelineId: activeTimelineId }); }
    function handleHopTimelineClick() { if (!selectedTile) { showModal({ title: 'Error', message: 'You must select a tile before opening a portal.'}); return; } socket.emit('get-affordability-info', { actionType: 'HOP', activeTimelineId: activeTimelineId }); }
    
    // --- Assigning Event Handlers ---
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('contextmenu', handleContextMenu);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('mouseup', handleGlobalMouseUp);
    window.addEventListener('mousemove', handleGlobalMouseMove);
    readyBtn.addEventListener('click', handleReadyButtonClick);
    window.addEventListener('keydown', handleKeyDown);
    treeCanvas.addEventListener('click', handleTimelineTreeClick);
    treeCanvas.addEventListener('mousedown', handleTimelineTreeMouseDown);
    treeCanvas.addEventListener('mousemove', handleTimelineTreeMouseMove);
    treeCanvas.addEventListener('mouseover', handleTimelineTreeMouseOver);
    treeCanvas.addEventListener('mouseout', handleTimelineTreeMouseOut);
    treeCanvas.addEventListener('wheel', handleTimelineTreeWheel, { passive: false });
    allCustomizationInputs.forEach(i => i.addEventListener('change', emitSettingsChange));
    document.getElementById('split-timeline-btn').addEventListener('click', handleSplitTimelineClick);
    document.getElementById('rollback-timeline-btn').addEventListener('click', handleRollbackTimelineClick);
    document.getElementById('anchor-timeline-btn').addEventListener('click', handleAnchorTimelineClick);
    document.getElementById('freeze-timeline-btn').addEventListener('click', handleFreezeTimelineClick);
    document.getElementById('overclock-timeline-btn').addEventListener('click', handleOverclockTimelineClick);
    document.getElementById('hop-timeline-btn').addEventListener('click', handleHopTimelineClick);
    
    /**
     * The main animation loop. Requests a new frame and calls the main render function.
     */
    function animationLoop() {
        render();
        requestAnimationFrame(animationLoop);
    }
    animationLoop();
};