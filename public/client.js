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
    function calculateFreezeCost(duration) {
        const base = (localGameState.settings && localGameState.settings.costFreezeBase) ? localGameState.settings.costFreezeBase : 15;
        return Math.floor(base * Math.pow(1.07, duration / 5));
    }
    function calculateOverclockCost(duration) {
        const base = (localGameState.settings && localGameState.settings.costOverclockBase) ? localGameState.settings.costOverclockBase : 20;
        return Math.floor(base * Math.pow(1.08, duration / 5));
    }
    function calculatePortalCost(duration) {
        const base = (localGameState.settings && localGameState.settings.costPortalBase) ? localGameState.settings.costPortalBase : 40;
        return Math.floor(base * Math.pow(1.06, duration / 5));
    }
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
    let currentHostPlayerId = null;
    
    // --- UI and Interaction State ---
    let lastServerUpdate = performance.now();
    let inputState = { isDragging: false, startTile: null, path: [], endTile: null, isSplitMove: false };
    let keyboardInputState = { path: [], timer: null };
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
    let devMode = false;
    let hasRetired = false;
    
    // Konami Code Gateway for Developer Features
    const KONAMI_CODE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    let konamiIndex = 0;

    // --- 5D Visual Effects State ---
    let lastTimelineSteps = {};
    let rollbackEffectTimer = 0;
    const temporalParticles = [];

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
    const allCustomizationInputs = [
        document.getElementById('fogToggle'),
        document.getElementById('staggeredStartToggle'),
        document.getElementById('fairGeneralsToggle'),
        document.getElementById('mountainPercent'),
        document.getElementById('forestPercent'),
        document.getElementById('cityCount'),
        document.getElementById('maxMovingArmies'),
        document.getElementById('gameTickMs'),
        document.getElementById('sightRadius'),
        document.getElementById('costSplitBase'),
        document.getElementById('costFreezeBase'),
        document.getElementById('costOverclockBase'),
        document.getElementById('costPortalBase'),
        document.getElementById('costAnchorBase'),
        document.getElementById('aiWaitChance'),
        document.getElementById('aiTokenIncome'),
        document.getElementById('aiTokenCap'),
        document.getElementById('aiFallibilityPercent'),
        document.getElementById('aiGeneralThreatThreshold'),
        document.getElementById('aiAttentionRadius'),
        document.getElementById('aiAttentionShiftCooldown'),
        document.getElementById('aiAlphaStrikeRatio'),
        document.getElementById('aiAlphaStrikeThreshold'),
        document.getElementById('aiWeightOffensive'),
        document.getElementById('aiWeightDefensive'),
        document.getElementById('aiWeightScouting'),
        document.getElementById('aiWeightCooperative'),
        document.getElementById('aiWeightTerritory')
    ];
    
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
    const modalTextarea = document.getElementById('modal-textarea');

    function showModal(config) {
        modalTitle.textContent = config.title;
        modalMessage.textContent = config.message;
        modalInput.classList.toggle('hidden', !config.showInput);
        if (config.showInput) {
            modalInput.value = config.defaultValue || '';
            setTimeout(() => modalInput.focus(), 10);
        }
        if (modalTextarea) {
            modalTextarea.classList.toggle('hidden', !config.showTextarea);
            if (config.showTextarea) {
                modalTextarea.value = config.defaultTextareaValue || '';
                modalTextarea.readOnly = !!config.textareaReadOnly;
                setTimeout(() => modalTextarea.focus(), 10);
            }
        }
        modalCostDisplay.textContent = config.costText || '';
        modalCostDisplay.classList.toggle('hidden', !config.costText);
        modalConfirmBtn.textContent = config.confirmText || 'Confirm';
        modalCancelBtn.textContent = config.cancelText || 'Cancel';
        modalOverlay.classList.remove('hidden');
        return new Promise((resolve, reject) => {
            const onConfirm = () => {
                cleanup();
                if (config.showInput) {
                    resolve(modalInput.value);
                } else if (config.showTextarea) {
                    resolve(modalTextarea.value);
                } else {
                    resolve(true);
                }
            };
            const onCancel = () => {
                cleanup();
                reject();
            };
            const onKeyup = (e) => {
                if(e.key === 'Enter' && !modalConfirmBtn.disabled && !config.showTextarea) onConfirm();
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
        if (currentHostPlayerId !== null) {
            isHost = myPlayerId === currentHostPlayerId;
        }
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
        if (hostPlayerId !== undefined && hostPlayerId !== null) {
            currentHostPlayerId = hostPlayerId;
        }
        isHost = myPlayerId === currentHostPlayerId;
        updatePlayerListView(currentHostPlayerId);
        updateLobbyUI(settings);

        const addAiBtn = document.getElementById('add-ai-btn');
        if (addAiBtn) {
            addAiBtn.classList.toggle('hidden', !isHost);
        }

        // Cleanly clear active game board and reset UI to pregame lobby
        localGameState = {
            multiverse: {},
            portals: [],
            paradoxEvents: [],
            visibility: {},
            boardDimensions: { cols: 40, rows: 30 },
            playerStats: {},
            settings: settings || {}
        };

        const statusDiv = document.getElementById('game-status');
        if (statusDiv) statusDiv.innerText = "";
        
        readyBtn.style.display = 'block';
        if (customizationContainer) customizationContainer.classList.remove('hidden');
        if (timelineControls) timelineControls.classList.add('hidden');
        if (timelineListContainer) timelineListContainer.classList.add('hidden');

        const returnLobbyBtn = document.getElementById('return-lobby-btn');
        if (returnLobbyBtn) returnLobbyBtn.classList.add('hidden');

        const aiDebugContainer = document.getElementById('ai-debug-container');
        if (aiDebugContainer) aiDebugContainer.classList.add('hidden');

        isReady = false;
        readyBtn.classList.remove('ready');
        readyBtn.textContent = 'Ready Up';
        hasRetired = false;
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
    
        // Track gameStep reversals for Rollback visual rewind trigger
        if (newState.multiverse) {
            for (const timelineId in newState.multiverse) {
                const timeline = newState.multiverse[timelineId];
                const currentStep = timeline.currentState.gameStep;
                const prevStep = lastTimelineSteps[timelineId];
                if (prevStep !== undefined && currentStep < prevStep) {
                    if (timelineId === activeTimelineId) {
                        rollbackEffectTimer = 180; // Trigger scanline ripple (3 seconds)
                    }
                }
                lastTimelineSteps[timelineId] = currentStep;
            }
        }

        // Immediately update the local game state. All subsequent logic MUST operate on this new state.
        localGameState = newState;

        // Disallow slider adjustments by locking customization inputs while game is active
        const isGameActive = localGameState.multiverse && Object.keys(localGameState.multiverse).length > 0;
        if (isGameActive) {
            allCustomizationInputs.forEach(input => {
                if (input) input.disabled = true;
            });
            const importBtn = document.getElementById('import-config-btn');
            if (importBtn) importBtn.disabled = true;
        }
    
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
            const splitBase = (localGameState.settings && localGameState.settings.costSplitBase !== undefined) ? localGameState.settings.costSplitBase : 250;
            splitBtn.textContent = `Split Timeline (Cost: ${Math.floor(splitBase * Math.pow(1.25, numTimelines - 1))})`;
        }

        const anchorBtn = document.getElementById('anchor-timeline-btn');
        if (anchorBtn && localGameState.settings) {
            const anchorBase = localGameState.settings.costAnchorBase !== undefined ? localGameState.settings.costAnchorBase : 200;
            anchorBtn.textContent = `Anchor Timeline (Cost: ${anchorBase})`;
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

        // Render AI thoughts if present in the state
        const aiDebugContainer = document.getElementById('ai-debug-container');
        const aiThoughtsList = document.getElementById('ai-thoughts-list');
        if (aiDebugContainer && aiThoughtsList) {
            if (devMode && newState.aiThoughts && newState.aiThoughts.length > 0) {
                aiDebugContainer.classList.remove('hidden');
                aiThoughtsList.innerHTML = newState.aiThoughts.map(t => `
                    <div class="thought-item">
                        <span class="thought-time">[${t.timestamp}]</span>
                        <span class="thought-msg">${t.message}</span>
                    </div>
                `).join('');
            } else {
                aiDebugContainer.classList.add('hidden');
            }
        }

        // Render Return to Lobby button for host if game is active or finished
        const returnLobbyBtn = document.getElementById('return-lobby-btn');
        if (returnLobbyBtn) {
            const isGameActive = Object.keys(localGameState.multiverse).length > 0;
            returnLobbyBtn.classList.toggle('hidden', !(isGameActive && isHost));
        }

        const retireAiBtn = document.getElementById('retire-ai-btn');
        if (retireAiBtn) {
            const isGameActive = Object.keys(localGameState.multiverse).length > 0;
            retireAiBtn.classList.toggle('hidden', !(devMode && isGameActive && !hasRetired));
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

        const addAiBtn = document.getElementById('add-ai-btn');
        if (addAiBtn) addAiBtn.classList.add('hidden');

        // Lock customization inputs while the game is active
        allCustomizationInputs.forEach(input => {
            if (input) input.disabled = true;
        });
        const importBtn = document.getElementById('import-config-btn');
        if (importBtn) importBtn.disabled = true;
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

        const returnLobbyBtn = document.getElementById('return-lobby-btn');
        if (returnLobbyBtn) returnLobbyBtn.classList.add('hidden');
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
        if (hostPlayerId !== undefined && hostPlayerId !== null) {
            currentHostPlayerId = hostPlayerId;
        }
        const effectiveHostId = (hostPlayerId !== undefined && hostPlayerId !== null) ? hostPlayerId : currentHostPlayerId;

        const playerListElement = document.getElementById('player-list');
        if (!playerListElement) return;

        playerListElement.innerHTML = '<h3>Connected Players</h3>';
        
        // Check if game is in lobby or running state
        const isGameRunning = Object.keys(localGameState.multiverse).length > 0;

        players.forEach(player => {
            const playerEl = document.createElement('div');
            playerEl.className = 'player-item-row';
            playerEl.style.color = player.color;
            playerEl.style.fontWeight = 'bold';

            const playerInfoEl = document.createElement('span');
            playerInfoEl.className = 'player-info';

            const hostLabel = player.id === effectiveHostId ? ' (Host)' : '';
            let armyDisplay = '';
            if (isGameRunning) {
                const armyCount = localGameState.playerStats?.[activeTimelineId]?.[player.id]?.army || 0;
                armyDisplay = `(Army: ${armyCount})`;
            }

            if (player.isAI && !isGameRunning) {
                // Lobby rendering for AI players
                playerInfoEl.textContent = `${player.name}`;
                playerEl.appendChild(playerInfoEl);

                // Add controls container
                const controlsEl = document.createElement('div');
                controlsEl.className = 'ai-controls';

                // Difficulty selector
                const selectEl = document.createElement('select');
                selectEl.className = 'ai-difficulty-select';
                selectEl.disabled = !isHost;
                
                ['EASY', 'MEDIUM', 'HARD'].forEach(level => {
                    const opt = document.createElement('option');
                    opt.value = level;
                    opt.textContent = level;
                    if (player.difficulty === level) opt.selected = true;
                    selectEl.appendChild(opt);
                });

                selectEl.addEventListener('change', () => {
                    socket.emit('change-ai-difficulty', { aiSocketId: player.socketId, difficulty: selectEl.value });
                });
                controlsEl.appendChild(selectEl);

                // Remove button
                if (isHost) {
                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'remove-ai-btn';
                    removeBtn.textContent = 'Remove';
                    removeBtn.addEventListener('click', () => {
                        socket.emit('remove-ai-player', { aiSocketId: player.socketId });
                    });
                    controlsEl.appendChild(removeBtn);
                }

                playerEl.appendChild(controlsEl);
            } else {
                // Human player or running game rendering
                const readyStatus = player.isReady ? '✔️ Ready' : '❌ Not Ready';
                playerInfoEl.textContent = `${player.name}${hostLabel} ${armyDisplay} - ${readyStatus}`;
                playerEl.appendChild(playerInfoEl);
            }

            playerListElement.appendChild(playerEl);
        });
    }

    /**
     * Updates the game customization UI based on the current settings received from the server.
     * Also disables the inputs if the current player is not the host.
     * @param {object} settings - The current game settings object.
     */
    function updateLobbyUI(settings) {
        const isGameActive = localGameState.multiverse && Object.keys(localGameState.multiverse).length > 0;
        allCustomizationInputs.forEach(input => {
            if (input) input.disabled = !isHost || isGameActive;
        });
        const importBtn = document.getElementById('import-config-btn');
        if (importBtn) {
            importBtn.disabled = !isHost || isGameActive;
        }
        setSettingsToUI(settings);
    }

    function getSettingsFromUI() {
        return {
            fogOfWar: document.getElementById('fogToggle').checked,
            staggeredStart: document.getElementById('staggeredStartToggle').checked,
            fairGenerals: document.getElementById('fairGeneralsToggle').checked,
            mountainPercent: parseInt(document.getElementById('mountainPercent').value) || 0,
            forestPercent: parseInt(document.getElementById('forestPercent').value) || 0,
            cityCount: parseInt(document.getElementById('cityCount').value) || 0,
            maxMovingArmies: parseInt(document.getElementById('maxMovingArmies').value) || 3,
            gameTickMs: parseInt(document.getElementById('gameTickMs').value) || 125,
            sightRadius: parseInt(document.getElementById('sightRadius').value) || 2,
            costSplitBase: parseInt(document.getElementById('costSplitBase').value) || 250,
            costFreezeBase: parseInt(document.getElementById('costFreezeBase').value) || 15,
            costOverclockBase: parseInt(document.getElementById('costOverclockBase').value) || 20,
            costPortalBase: parseInt(document.getElementById('costPortalBase').value) || 40,
            costAnchorBase: parseInt(document.getElementById('costAnchorBase').value) || 200,
            ai: {
                waitChance: parseFloat(document.getElementById('aiWaitChance').value) !== undefined ? parseFloat(document.getElementById('aiWaitChance').value) : 0.08,
                tokenIncome: parseInt(document.getElementById('aiTokenIncome').value) || 5,
                tokenCap: parseInt(document.getElementById('aiTokenCap').value) || 50,
                fallibilityPercent: parseFloat(document.getElementById('aiFallibilityPercent').value) !== undefined ? parseFloat(document.getElementById('aiFallibilityPercent').value) : 0.25,
                generalThreatThreshold: parseInt(document.getElementById('aiGeneralThreatThreshold').value) || 300,
                attentionRadius: parseInt(document.getElementById('aiAttentionRadius').value) || 6,
                attentionShiftCooldown: parseInt(document.getElementById('aiAttentionShiftCooldown').value) || 15,
                alphaStrikeRatio: parseFloat(document.getElementById('aiAlphaStrikeRatio').value) !== undefined ? parseFloat(document.getElementById('aiAlphaStrikeRatio').value) : 1.25,
                alphaStrikeThreshold: parseInt(document.getElementById('aiAlphaStrikeThreshold').value) || 150,
                weightOffensive: parseFloat(document.getElementById('aiWeightOffensive').value) !== undefined ? parseFloat(document.getElementById('aiWeightOffensive').value) : 1.0,
                weightDefensive: parseFloat(document.getElementById('aiWeightDefensive').value) !== undefined ? parseFloat(document.getElementById('aiWeightDefensive').value) : 1.0,
                weightScouting: parseFloat(document.getElementById('aiWeightScouting').value) !== undefined ? parseFloat(document.getElementById('aiWeightScouting').value) : 1.0,
                weightCooperative: parseFloat(document.getElementById('aiWeightCooperative').value) !== undefined ? parseFloat(document.getElementById('aiWeightCooperative').value) : 1.0,
                weightTerritory: parseFloat(document.getElementById('aiWeightTerritory').value) !== undefined ? parseFloat(document.getElementById('aiWeightTerritory').value) : 1.0
            }
        };
    }

    function setSettingsToUI(settings) {
        if (!settings) return;
        
        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) {
                if (el.type === 'checkbox') {
                    el.checked = !!val;
                } else {
                    el.value = val;
                }
                const valEl = document.getElementById(id + 'Val');
                if (valEl) {
                    if (id === 'aiFallibilityPercent') {
                        valEl.textContent = Math.round(val * 100);
                    } else {
                        valEl.textContent = val;
                    }
                }
            }
        };

        setVal('fogToggle', settings.fogOfWar);
        setVal('staggeredStartToggle', settings.staggeredStart);
        setVal('fairGeneralsToggle', settings.fairGenerals);
        setVal('mountainPercent', settings.mountainPercent !== undefined ? settings.mountainPercent : 10);
        setVal('forestPercent', settings.forestPercent !== undefined ? settings.forestPercent : 15);
        setVal('cityCount', settings.cityCount !== undefined ? settings.cityCount : 8);
        setVal('maxMovingArmies', settings.maxMovingArmies !== undefined ? settings.maxMovingArmies : 3);
        setVal('gameTickMs', settings.gameTickMs !== undefined ? settings.gameTickMs : 125);
        setVal('sightRadius', settings.sightRadius !== undefined ? settings.sightRadius : 2);
        setVal('costSplitBase', settings.costSplitBase !== undefined ? settings.costSplitBase : 250);
        setVal('costFreezeBase', settings.costFreezeBase !== undefined ? settings.costFreezeBase : 15);
        setVal('costOverclockBase', settings.costOverclockBase !== undefined ? settings.costOverclockBase : 20);
        setVal('costPortalBase', settings.costPortalBase !== undefined ? settings.costPortalBase : 40);
        setVal('costAnchorBase', settings.costAnchorBase !== undefined ? settings.costAnchorBase : 200);

        if (settings.ai) {
            setVal('aiWaitChance', settings.ai.waitChance !== undefined ? settings.ai.waitChance : 0.08);
            setVal('aiTokenIncome', settings.ai.tokenIncome !== undefined ? settings.ai.tokenIncome : 5);
            setVal('aiTokenCap', settings.ai.tokenCap !== undefined ? settings.ai.tokenCap : 50);
            setVal('aiFallibilityPercent', settings.ai.fallibilityPercent !== undefined ? settings.ai.fallibilityPercent : 0.25);
            setVal('aiGeneralThreatThreshold', settings.ai.generalThreatThreshold !== undefined ? settings.ai.generalThreatThreshold : 300);
            setVal('aiAttentionRadius', settings.ai.attentionRadius !== undefined ? settings.ai.attentionRadius : 6);
            setVal('aiAttentionShiftCooldown', settings.ai.attentionShiftCooldown !== undefined ? settings.ai.attentionShiftCooldown : 15);
            setVal('aiAlphaStrikeRatio', settings.ai.alphaStrikeRatio !== undefined ? settings.ai.alphaStrikeRatio : 1.25);
            setVal('aiAlphaStrikeThreshold', settings.ai.alphaStrikeThreshold !== undefined ? settings.ai.alphaStrikeThreshold : 150);
            setVal('aiWeightOffensive', settings.ai.weightOffensive !== undefined ? settings.ai.weightOffensive : 1.0);
            setVal('aiWeightDefensive', settings.ai.weightDefensive !== undefined ? settings.ai.weightDefensive : 1.0);
            setVal('aiWeightScouting', settings.ai.weightScouting !== undefined ? settings.ai.weightScouting : 1.0);
            setVal('aiWeightCooperative', settings.ai.weightCooperative !== undefined ? settings.ai.weightCooperative : 1.0);
            setVal('aiWeightTerritory', settings.ai.weightTerritory !== undefined ? settings.ai.weightTerritory : 1.0);
        }
    }
    
    /**
     * Determines whether dark or light text should be used against a given background color for maximum readability.
     * Handles HSL, Hex, and RGB color formats.
     * @param {string} colorStr - The background color string.
     * @returns {string} High-contrast text color ('#111111' or '#FFFFFF').
     */
    function getContrastTextColor(colorStr) {
        if (!colorStr) return '#FFFFFF';
        if (colorStr.startsWith('hsl')) {
            const match = colorStr.match(/hsla?\(\s*\d+\s*,\s*\d+%\s*,\s*(\d+)%\s*(?:,\s*[\d.]+\s*)?\)/i) ||
                          colorStr.match(/hsla?\(\s*\d+\s*,\s*(\d+)%\s*,\s*(\d+)%\s*(?:,\s*[\d.]+\s*)?\)/i);
            if (match) {
                const lightness = parseInt(match[match.length - 1]);
                return lightness > 50 ? '#111111' : '#FFFFFF';
            }
        }
        if (colorStr.startsWith('#')) {
            let hex = colorStr.slice(1);
            if (hex.length === 3) {
                hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
            }
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
            return yiq >= 128 ? '#111111' : '#FFFFFF';
        }
        if (colorStr.startsWith('rgb')) {
            const match = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)/i);
            if (match) {
                const r = parseInt(match[1]);
                const g = parseInt(match[2]);
                const b = parseInt(match[3]);
                const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
                return yiq >= 128 ? '#111111' : '#FFFFFF';
            }
        }
        return '#FFFFFF';
    }

    function updateAndDrawTemporalParticles(effectType) {
        if (temporalParticles.length === 0) {
            for (let i = 0; i < 20; i++) {
                temporalParticles.push({
                    x: Math.random() * canvas.width,
                    y: Math.random() * canvas.height,
                    speed: 0.5 + Math.random() * 1.5,
                    size: 1 + Math.random() * 2,
                    angle: Math.random() * Math.PI * 2
                });
            }
        }
        
        ctx.fillStyle = effectType === 'FREEZE' ? 'rgba(0, 229, 255, 0.4)' : 'rgba(255, 85, 0, 0.4)';
        for (const p of temporalParticles) {
            if (effectType === 'FREEZE') {
                p.y += p.speed;
                p.x += Math.sin(p.angle) * 0.2;
                p.angle += 0.02;
                if (p.y > canvas.height) { p.y = 0; p.x = Math.random() * canvas.width; }
            } else {
                p.y -= p.speed;
                p.x += Math.sin(p.angle) * 0.3;
                p.angle += 0.03;
                if (p.y < 0) { p.y = canvas.height; p.x = Math.random() * canvas.width; }
            }
            
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
        }
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
                if (tile.type === TILE_TYPE.GENERAL) {
                    ctx.save();
                    ctx.fillStyle = '#FFD700'; // Premium Bright Gold
                    ctx.strokeStyle = '#000000'; // Dark outline
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(x + TILE_SIZE * 0.2, y + TILE_SIZE * 0.8);
                    ctx.lineTo(x + TILE_SIZE * 0.8, y + TILE_SIZE * 0.8);
                    ctx.lineTo(x + TILE_SIZE * 0.8, y + TILE_SIZE * 0.35);
                    ctx.lineTo(x + TILE_SIZE * 0.65, y + TILE_SIZE * 0.55);
                    ctx.lineTo(x + TILE_SIZE * 0.5, y + TILE_SIZE * 0.25);
                    ctx.lineTo(x + TILE_SIZE * 0.35, y + TILE_SIZE * 0.55);
                    ctx.lineTo(x + TILE_SIZE * 0.2, y + TILE_SIZE * 0.35);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                    ctx.restore();
                }
                else if (tile.type === TILE_TYPE.CITY) { ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2 / camera.zoom; ctx.strokeRect(x + 1, y + 1, TILE_SIZE - 3, TILE_SIZE - 3); }
                
                // --- Render Army Counts ---
                if (tile.army > 0 && tile.type !== TILE_TYPE.MOUNTAIN && camera.zoom > 0.5) {
                    const isMyTile = tile.ownerId === myPlayerId;
                    const isArmyVisible = (tile.type !== TILE_TYPE.FOREST) || isMyTile;
                    if (isArmyVisible) {
                        if (tile.type === TILE_TYPE.GENERAL) {
                            ctx.fillStyle = '#FFFFFF'; // Crisp white text to display clearly over the crown
                            ctx.strokeStyle = '#000000'; // Thin black outline
                            ctx.lineWidth = 2.5;
                        } else if (tile.causalityTag) {
                            ctx.fillStyle = getCausalityColor(tile.causalityTag, activeGameState.gameStep);
                        } else {
                            const bgColor = PLAYER_COLORS[tile.ownerId] || '#FFFFFF';
                            ctx.fillStyle = getContrastTextColor(bgColor);
                        }
                        ctx.font = `bold ${TILE_SIZE / 2}px sans-serif`;
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        if (tile.type === TILE_TYPE.GENERAL) {
                            ctx.strokeText(tile.army, x + TILE_SIZE / 2, y + TILE_SIZE / 2);
                        }
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
                if (move.causalityTag) {
                    ctx.fillStyle = getCausalityColor(move.causalityTag, activeGameState.gameStep);
                } else {
                    const bgColor = PLAYER_COLORS[move.ownerId] || '#FFFFFF';
                    ctx.fillStyle = getContrastTextColor(bgColor);
                }
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

        // --- Render Keyboard Input (Preplanning Path Drawing) ---
        if (keyboardInputState.path.length > 0) {
            ctx.strokeStyle = '#00FFCC'; // Neon cyan for keyboard planning path
            ctx.lineWidth = 3 / camera.zoom;
            ctx.beginPath();
            const firstTile = keyboardInputState.path[0];
            ctx.moveTo((firstTile.col * TILE_SIZE) + (TILE_SIZE / 2), (firstTile.row * TILE_SIZE) + (TILE_SIZE / 2));
            for (let i = 1; i < keyboardInputState.path.length; i++) {
                const tile = keyboardInputState.path[i];
                ctx.lineTo((tile.col * TILE_SIZE) + (TILE_SIZE / 2), (tile.row * TILE_SIZE) + (TILE_SIZE / 2));
            }
            ctx.stroke();
        }

        // --- Render Selected Tile Highlight ---
        if (selectedTile) {
            const x = selectedTile.col * TILE_SIZE, y = selectedTile.row * TILE_SIZE;
            ctx.strokeStyle = '#FFFF00'; // Bright yellow for selection.
            ctx.lineWidth = 3 / camera.zoom;
            ctx.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
        }

        // --- Render Developer Mode AI Attention Focus Circles ---
        if (devMode && localGameState.aiFocusPoints) {
            const aiSettings = (localGameState.settings && localGameState.settings.ai) ? localGameState.settings.ai : {};
            const attentionRadius = aiSettings.attentionRadius !== undefined ? aiSettings.attentionRadius : 6;
            
            for (const aiPlayerId in localGameState.aiFocusPoints) {
                const playerFocus = localGameState.aiFocusPoints[aiPlayerId];
                const focalPoint = playerFocus[activeTimelineId];
                if (focalPoint) {
                    const centerX = focalPoint.col * TILE_SIZE + TILE_SIZE / 2;
                    const centerY = focalPoint.row * TILE_SIZE + TILE_SIZE / 2;
                    
                    const color = PLAYER_COLORS[aiPlayerId] || '#FFC107';
                    const radiusPx = (attentionRadius + 0.5) * TILE_SIZE;
                    
                    ctx.save();
                    
                    // Subtle radial backdrop overlay
                    ctx.fillStyle = color;
                    ctx.globalAlpha = 0.05;
                    ctx.beginPath();
                    ctx.arc(centerX, centerY, radiusPx, 0, Math.PI * 2);
                    ctx.fill();
                    
                    // Dotted visual focus circle
                    ctx.globalAlpha = 0.6;
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2 / camera.zoom;
                    ctx.setLineDash([4, 4]);
                    ctx.beginPath();
                    ctx.arc(centerX, centerY, radiusPx, 0, Math.PI * 2);
                    ctx.stroke();
                    
                    // Small central target dot
                    ctx.globalAlpha = 0.8;
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(centerX, centerY, 3, 0, Math.PI * 2);
                    ctx.fill();
                    
                    ctx.restore();
                }
            }
        }

        ctx.restore(); // Restore context to pre-camera state.

        // Draw screenspace 5D overlays
        if (currentTimeline) {
            if (currentTimeline.isFrozen) {
                // Freeze Overlay: Cyan edge vignette
                const grad = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, canvas.width / 4, canvas.width / 2, canvas.height / 2, canvas.width / 2 * 1.3);
                grad.addColorStop(0, 'rgba(0,0,0,0)');
                grad.addColorStop(1, 'rgba(0, 229, 255, 0.15)');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                updateAndDrawTemporalParticles('FREEZE');
            } else if (currentTimeline.speedMultiplier > 1.0) {
                // Overclock Overlay: Orange edge vignette
                const grad = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, canvas.width / 4, canvas.width / 2, canvas.height / 2, canvas.width / 2 * 1.3);
                grad.addColorStop(0, 'rgba(0,0,0,0)');
                grad.addColorStop(1, 'rgba(255, 85, 0, 0.15)');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                updateAndDrawTemporalParticles('OVERCLOCK');
            }
        }

        if (rollbackEffectTimer > 0) {
            rollbackEffectTimer--;
            
            const alphaRatio = rollbackEffectTimer / 180.0;
            
            // VHS rewind scanline sweeps
            ctx.strokeStyle = `rgba(255, 255, 255, ${(0.08 + Math.random() * 0.12) * alphaRatio})`;
            ctx.lineWidth = 1 + Math.random() * 2;
            const numLines = 2 + Math.floor(Math.random() * 3);
            for (let i = 0; i < numLines; i++) {
                const lineY = Math.random() * canvas.height;
                ctx.beginPath();
                ctx.moveTo(0, lineY);
                ctx.lineTo(canvas.width, lineY);
                ctx.stroke();
            }
            
            // Chromatic magenta noise overlay
            ctx.fillStyle = `rgba(255, 0, 100, ${0.05 * alphaRatio})`;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Retro temporal HUD rewinding marker
            ctx.fillStyle = `rgba(0, 255, 204, ${0.8 * alphaRatio})`;
            ctx.font = 'bold 20px "Courier New", monospace';
            ctx.textAlign = 'center';
            ctx.fillText('◄◄ TEMPORAL REWIND ◄◄', canvas.width / 2, 45);
        }

        // Render UI overlays.
        renderTimelineTree();
        renderHistoryPreview();
    }
    
    /**
     * Renders the interactive timeline tree structure on its dedicated canvas.
     */
    function renderTimelineTree() { const PADDING = 20; const X_SPACING = 50; const Y_SCALE = 0.5; treeCtx.clearRect(0, 0, treeCanvas.width, treeCanvas.height); treeCtx.save(); if (!localGameState.multiverse || Object.keys(localGameState.multiverse).length === 0) { treeCtx.restore(); return; } timelineTreeHitboxes = []; const t = {}; const l = {}; function a(id, L) { if (l[id] !== undefined) return; l[id] = L; Object.values(localGameState.multiverse).forEach(c => { if (c.parentId === id) a(c.id, L + 1); }); } a('timeline-alpha', 0); Object.keys(l).forEach(id => { const L = l[id]; t[id] = { x: PADDING + L * X_SPACING }; }); const A = localGameState.multiverse['timeline-alpha']; if (A) { const y = PADDING + A.currentState.gameStep * Y_SCALE; treeCamera.targetY = y - (treeCanvas.height / 2); } if (!isMouseOverTree) { treeCamera.y += (treeCamera.targetY - treeCamera.y) * 0.05; } treeCtx.translate(0, -treeCamera.y); treeCtx.fillStyle = '#FFFFFF'; treeCtx.strokeStyle = '#FFFFFF'; treeCtx.font = '12px "Courier New", monospace'; for (const id in localGameState.multiverse) { const m = localGameState.multiverse[id]; const p = t[id]; if (!p) continue; const sY = PADDING + m.splitStep * Y_SCALE; const eY = PADDING + m.currentState.gameStep * Y_SCALE; const top = Math.min(sY, eY); const bot = Math.max(sY, eY); if (bot < treeCamera.y - PADDING || top > treeCamera.y + treeCanvas.height + PADDING) continue; treeCtx.beginPath(); treeCtx.moveTo(p.x, sY); treeCtx.lineTo(p.x, eY); treeCtx.lineWidth = m.id === activeTimelineId ? 4 : 2; let strokeColor = '#FFFFFF'; if (m.isUnravelling) { strokeColor = '#FF00FF'; } else if (m.isFrozen) { strokeColor = '#00E5FF'; } else if (m.speedMultiplier > 1.0) { const pulse = Math.floor(Date.now() / 250) % 2 === 0; strokeColor = pulse ? '#FF9100' : '#FFD600'; } treeCtx.strokeStyle = strokeColor; treeCtx.stroke(); if (m.parentId && t[m.parentId]) { const P = t[m.parentId]; treeCtx.beginPath(); treeCtx.moveTo(P.x, sY); treeCtx.lineTo(p.x, sY); treeCtx.lineWidth = 1; treeCtx.strokeStyle = '#888888'; treeCtx.stroke(); } treeCtx.beginPath(); treeCtx.arc(p.x, eY, 5, 0, Math.PI * 2); let nC = m.id === activeTimelineId ? '#007bff' : '#FFFFFF'; if (timelineAlerts[id]) { const S = Date.now() - timelineAlerts[id]; if (S > 5000) { delete timelineAlerts[id]; } else if (Math.floor(S / 250) % 2 === 0) { nC = '#FF0000'; } } treeCtx.fillStyle = nC; treeCtx.fill(); timelineTreeHitboxes.push({ id: id, x: p.x, y: eY, startY: sY, radius: 10 }); const d = id.split('-'); const D = d[1] || '???'; treeCtx.fillStyle = '#FFFFFF'; treeCtx.fillText(D, p.x + 10, eY + 4); } if (hoveredTimelineId && t[hoveredTimelineId]) { const T = localGameState.multiverse[hoveredTimelineId]; const p = t[hoveredTimelineId]; const eY = PADDING + T.currentState.gameStep * Y_SCALE; const txt = hoveredTimelineId; const m = treeCtx.measureText(txt); const w = m.width + 10; const h = 18; const bX = p.x + 15; const bY = eY - (h / 2); treeCtx.fillStyle = 'rgba(0, 0, 0, 0.8)'; treeCtx.fillRect(bX, bY, w, h); treeCtx.strokeStyle = '#007bff'; treeCtx.strokeRect(bX, bY, w, h); treeCtx.fillStyle = '#FFFFFF'; treeCtx.textAlign = 'left'; treeCtx.textBaseline = 'middle'; treeCtx.fillText(txt, bX + 5, bY + h / 2); } treeCtx.restore(); }
    
    /**
     * A client-side simulation of a single game tick. Used for reconstructing historical game states for the history preview feature.
     * This must stay in sync with the server's primary game logic.
     * @param {object} gameState - The game state object to advance by one step.
     */
    function client_runSingleTickLogic(gameState) {
        for (let i = gameState.moves.length - 1; i >= 0; i--) {
            const m = gameState.moves[i];
            m.progress++;
            if (m.progress >= MOVE_TICKS) {
                m.progress = 0;
                
                const currentPos = m.path[m.pathIndex];
                const nextPos = m.path[m.pathIndex + 1];
                if (!nextPos) {
                    gameState.moves.splice(i, 1);
                    continue;
                }
                
                // Head-on Collision Check
                let moveDestroyed = false;
                for (let j = 0; j < gameState.moves.length; j++) {
                    const other = gameState.moves[j];
                    if (other === m || other.ownerId === m.ownerId) continue;
                    
                    const otherCurrentPos = other.path[other.pathIndex];
                    const otherNextPos = other.path[other.pathIndex + 1];
                    
                    if (otherCurrentPos && otherNextPos &&
                        otherCurrentPos.row === nextPos.row &&
                        otherCurrentPos.col === nextPos.col &&
                        otherNextPos.row === currentPos.row &&
                        otherNextPos.col === currentPos.col) {
                        
                        if (m.army > other.army) {
                            m.army -= other.army;
                            gameState.moves.splice(j, 1);
                            if (j < i) i--;
                        } else if (other.army > m.army) {
                            other.army -= m.army;
                            gameState.moves.splice(i, 1);
                            moveDestroyed = true;
                            break;
                        } else {
                            gameState.moves.splice(Math.max(i, j), 1);
                            gameState.moves.splice(Math.min(i, j), 1);
                            if (Math.min(i, j) < i) i--;
                            moveDestroyed = true;
                            break;
                        }
                    }
                }
                if (moveDestroyed) continue;
                
                const f = m.pathIndex >= m.path.length - 2;
                if (f) {
                    const t = gameState.board[nextPos.row][nextPos.col];
                    if (t.ownerId !== m.ownerId) {
                        if (m.army > t.army) {
                            t.ownerId = m.ownerId;
                            t.army = m.army - t.army;
                        } else {
                            t.army -= m.army;
                        }
                    } else {
                        t.army += m.army;
                    }
                    gameState.moves.splice(i, 1);
                } else {
                    m.pathIndex++;
                }
            }
        }
        gameState.gameStep++;
        for (let r = 0; r < localGameState.boardDimensions.rows; r++) {
            for (let c = 0; c < localGameState.boardDimensions.cols; c++) {
                const t = gameState.board[r][c];
                if (t.ownerId !== 0) {
                    if ((t.type === TILE_TYPE.GENERAL || t.type === TILE_TYPE.CITY) && gameState.gameStep % 4 === 0) {
                        t.army++;
                    } else if ((t.type === TILE_TYPE.EMPTY || t.type === TILE_TYPE.FOREST) && gameState.gameStep % 20 === 0) {
                        t.army++;
                    }
                }
            }
        }
    }
    
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
    function handleMouseDown(event) {
        // Clear keyboard preplanning on manual mouse interaction
        if (keyboardInputState.timer) clearTimeout(keyboardInputState.timer);
        keyboardInputState.path = [];

        const t = getTileFromMouseEvent(event);
        if (!t) return;
        if (event.button === 0 || event.button === 2) {
            inputState.isDragging = true;
            inputState.startTile = t;
            inputState.path = [t];
            inputState.endTile = t;
            inputState.isSplitMove = (event.button === 2);
        } else if (event.button === 1) {
            event.preventDefault();
            panningState.isPanning = true;
            panningState.lastMouseX = event.clientX;
            panningState.lastMouseY = event.clientY;
        }
    }
    function handleMouseMove(event) { if (inputState.isDragging) { const c = getTileFromMouseEvent(event); if (c) { inputState.endTile = c; let l = inputState.path[inputState.path.length - 1]; while (c.row !== l.row || c.col !== l.col) { const dX = c.col - l.col; const dY = c.row - l.row; let n = { row: l.row, col: l.col }; if (Math.abs(dX) > Math.abs(dY)) { n.col += Math.sign(dX); } else { n.row += Math.sign(dY); } const t = localGameState.multiverse[activeTimelineId]; if (!t) break; const T = t.currentState.board[n.row]?.[n.col]; if (T && T.type !== TILE_TYPE.MOUNTAIN) { if (n.row !== l.row || n.col !== l.col) { inputState.path.push(n); l = n; } } else { break; } } } } else if (panningState.isPanning) { const dX = event.clientX - panningState.lastMouseX; const dY = event.clientY - panningState.lastMouseY; camera.x += dX; camera.y += dY; panningState.lastMouseX = event.clientX; panningState.lastMouseY = event.clientY; } }
    function handleMouseUp(event) { if (event.button === 0 || event.button === 2) { if (inputState.isDragging) { if (inputState.path.length > 1) { socket.emit('player-action', { type: 'MOVE', path: inputState.path, isSplit: inputState.isSplitMove, activeTimelineId: activeTimelineId }); selectedTile = null; } else { selectedTile = inputState.startTile; } inputState.isDragging = false; inputState.isSplitMove = false; inputState.startTile = null; inputState.endTile = null; inputState.path = []; } } else if (event.button === 1) { panningState.isPanning = false; } }
    function handleContextMenu(event) { event.preventDefault(); }
    function handleWheel(event) { event.preventDefault(); const r = canvas.getBoundingClientRect(); const mX = event.clientX - r.left; const mY = event.clientY - r.top; const wX = (mX - camera.x) / camera.zoom; const wY = (mY - camera.y) / camera.zoom; const z = event.deltaY > 0 ? 0.9 : 1.1; const nZ = Math.max(camera.minZoom, Math.min(camera.maxZoom, camera.zoom * z)); camera.x = mX - wX * nZ; camera.y = mY - wY * nZ; camera.zoom = nZ; }
    function handleReadyButtonClick() { isReady = !isReady; socket.emit('player-ready', isReady); if (isReady) { readyBtn.textContent = 'Unready'; readyBtn.classList.add('ready'); } else { readyBtn.textContent = 'Ready Up'; readyBtn.classList.remove('ready'); } }
    function handleKeyDown(event) {
        // Check for Konami Code key match
        const expectedKey = KONAMI_CODE[konamiIndex];
        const pressedKey = event.key.toLowerCase() === 'b' || event.key.toLowerCase() === 'a' ? event.key.toLowerCase() : event.key;
        
        if (pressedKey === expectedKey) {
            konamiIndex++;
            if (konamiIndex === KONAMI_CODE.length) {
                konamiIndex = 0;
                // Reveal the developer panel!
                const devPanel = document.querySelector('.developer-panel');
                if (devPanel) {
                    devPanel.classList.remove('hidden');
                    // Automatically toggle it on!
                    const devModeToggle = document.getElementById('devModeToggle');
                    if (devModeToggle) {
                        devModeToggle.checked = true;
                        devModeToggle.dispatchEvent(new Event('change'));
                    }
                    showModal({
                        title: 'Developer Mode Unlocked!',
                        message: 'Cheat Code Activated: Developer Mode features have been unlocked and enabled.'
                    }).catch(() => {});
                }
            }
        } else {
            // Reset sequence if a wrong key is pressed, but allow restarting from the first key
            konamiIndex = pressedKey === KONAMI_CODE[0] ? 1 : 0;
        }

        if (!modalOverlay.classList.contains('hidden')) return;

        // Cycle timelines with Q and E
        const t = Object.keys(localGameState.multiverse);
        if (t.length > 1) {
            const c = t.indexOf(activeTimelineId);
            let n = c;
            if (event.key === 'e' || event.key === 'E') n = (c + 1) % t.length;
            else if (event.key === 'q' || event.key === 'Q') n = (c - 1 + t.length) % t.length;
            if (n !== c) {
                activeTimelineId = t[n];
                updatePlayerListView();
                // Clear active preplanned keyboard path on timeline cycle
                if (keyboardInputState.timer) clearTimeout(keyboardInputState.timer);
                keyboardInputState.path = [];
            }
        }

        // Handle WASD / Arrow movement preplanning
        if (selectedTile) {
            let d = null;
            const refTile = keyboardInputState.path.length > 0 
                ? keyboardInputState.path[keyboardInputState.path.length - 1] 
                : selectedTile;

            switch (event.key) {
                case 'w':
                case 'W':
                case 'ArrowUp':
                    d = { row: refTile.row - 1, col: refTile.col };
                    event.preventDefault();
                    break;
                case 'a':
                case 'A':
                case 'ArrowLeft':
                    d = { row: refTile.row, col: refTile.col - 1 };
                    event.preventDefault();
                    break;
                case 's':
                case 'S':
                case 'ArrowDown':
                    d = { row: refTile.row + 1, col: refTile.col };
                    event.preventDefault();
                    break;
                case 'd':
                case 'D':
                case 'ArrowRight':
                    d = { row: refTile.row, col: refTile.col + 1 };
                    event.preventDefault();
                    break;
                case 'Escape':
                    // Press Escape to cancel preplanning path
                    if (keyboardInputState.timer) clearTimeout(keyboardInputState.timer);
                    keyboardInputState.path = [];
                    break;
            }

            if (d) {
                if (d.row >= 0 && d.row < localGameState.boardDimensions.rows && d.col >= 0 && d.col < localGameState.boardDimensions.cols) {
                    const c = localGameState.multiverse[activeTimelineId];
                    if (c) {
                        const T = c.currentState.board[d.row]?.[d.col];
                        if (T && T.type !== TILE_TYPE.MOUNTAIN) {
                            // If this is the start of preplanning
                            if (keyboardInputState.path.length === 0) {
                                keyboardInputState.path = [selectedTile, d];
                            } else {
                                // Prevent simple immediate backtrack loops in the planning path
                                const prevTile = keyboardInputState.path[keyboardInputState.path.length - 2];
                                if (prevTile && prevTile.row === d.row && prevTile.col === d.col) {
                                    keyboardInputState.path.pop();
                                } else {
                                    keyboardInputState.path.push(d);
                                }
                            }

                            // Update selection instantly
                            selectedTile = d;

                            // Emit MOVE instantly
                            if (keyboardInputState.path.length > 1) {
                                socket.emit('player-action', {
                                    type: 'MOVE',
                                    path: [...keyboardInputState.path],
                                    activeTimelineId: activeTimelineId
                                });
                            }

                            // Clear active path after 300ms of inactivity to remove neon-cyan highlight
                            if (keyboardInputState.timer) clearTimeout(keyboardInputState.timer);
                            keyboardInputState.timer = setTimeout(() => {
                                keyboardInputState.path = [];
                                keyboardInputState.timer = null;
                            }, 300);
                        }
                    }
                }
            }
        }
    }
    function handleTimelineTreeClick(event) { const r = treeCanvas.getBoundingClientRect(); const x = event.clientX - r.left; const y = (event.clientY - r.top) + treeCamera.y; let c = false; for (const h of timelineTreeHitboxes) { const d = Math.sqrt(Math.pow(x - h.x, 2) + Math.pow(y - h.y, 2)); if (d < h.radius) { activeTimelineId = h.id; updatePlayerListView(); c = true; break; } } if (c) { historyPreviewState.gameState = null; timelineScrubber.classList.add('hidden'); } else { historyPreviewState.gameState = null; timelineScrubber.classList.add('hidden'); scrubberState.active = false; } }
    function handleTimelineTreeMouseDown(event) { const r = treeCanvas.getBoundingClientRect(); const x = event.clientX - r.left; const y = (event.clientY - r.top) + treeCamera.y; for (const h of timelineTreeHitboxes) { if (Math.abs(x - h.x) < 10 && y >= h.startY && y <= h.y) { scrubberState.active = true; scrubberState.timelineId = h.id; updateScrubberAndPreview(event); return; } } }
    function updateScrubberAndPreview(event) { if (!scrubberState.active) return; const t = localGameState.multiverse[scrubberState.timelineId]; if (!t) return; const r = treeCanvas.getBoundingClientRect(); const y = (event.clientY - r.top); const Y = 0.5; const P = 20; let s = Math.round((y + treeCamera.y - P) / Y); s = Math.max(t.anchorStep, Math.min(s, t.currentState.gameStep)); const R = reconstructGameState(t, s); if (R) { historyPreviewState.timelineId = scrubberState.timelineId; historyPreviewState.step = s; historyPreviewState.gameState = R; const x = timelineTreeHitboxes.find(h => h.id === scrubberState.timelineId).x; const sY = (P + s * Y) - treeCamera.y; const cR = timelineListContainer.getBoundingClientRect(); timelineScrubber.style.left = `${x + r.left - cR.left}px`; timelineScrubber.style.top = `${sY + r.top - cR.top}px`; timelineScrubber.classList.remove('hidden'); } }
    function handleGlobalMouseUp(event) { if (scrubberState.active) { scrubberState.active = false; } }
    function handleGlobalMouseMove(event) { if (scrubberState.active) { updateScrubberAndPreview(event); } }
    function handleTimelineTreeMouseMove(event) { const r = treeCanvas.getBoundingClientRect(); const x = event.clientX - r.left; const y = (event.clientY - r.top) + treeCamera.y; let c = null; let m = Infinity; for (const h of timelineTreeHitboxes) { const d = Math.sqrt(Math.pow(x - h.x, 2) + Math.pow(y - h.y, 2)); if (d < h.radius && d < m) { m = d; c = h.id; } } hoveredTimelineId = c; }
    function handleTimelineTreeMouseOver() { isMouseOverTree = true; }
    function handleTimelineTreeMouseOut() { isMouseOverTree = false; hoveredTimelineId = null; }
    function handleTimelineTreeWheel(event) { if (isMouseOverTree) { event.preventDefault(); treeCamera.y += event.deltaY * 0.5; } }
    function emitSettingsChange() {
        if (!isHost) return;
        socket.emit('update-game-settings', getSettingsFromUI());
    }
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
    const rangeInputIds = ['mountainPercent', 'forestPercent', 'cityCount', 'maxMovingArmies', 'gameTickMs', 'sightRadius', 'costSplitBase', 'costFreezeBase', 'costOverclockBase', 'costPortalBase', 'costAnchorBase', 'aiWaitChance', 'aiTokenIncome', 'aiTokenCap', 'aiFallibilityPercent', 'aiGeneralThreatThreshold', 'aiAttentionRadius', 'aiAttentionShiftCooldown', 'aiAlphaStrikeRatio', 'aiAlphaStrikeThreshold', 'aiWeightOffensive', 'aiWeightDefensive', 'aiWeightScouting', 'aiWeightCooperative', 'aiWeightTerritory'];
    
    rangeInputIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', () => {
                const valEl = document.getElementById(id + 'Val');
                if (valEl) {
                    if (id === 'aiFallibilityPercent') {
                        valEl.textContent = Math.round(parseFloat(el.value) * 100);
                    } else {
                        valEl.textContent = el.value;
                    }
                }
            });
        }
    });

    ['fogToggle', 'staggeredStartToggle', 'fairGeneralsToggle'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', () => {
                if (isHost && localGameState.multiverse && Object.keys(localGameState.multiverse).length === 0) {
                    emitSettingsChange();
                }
            });
        }
    });

    const importConfigBtn = document.getElementById('import-config-btn');
    const exportConfigBtn = document.getElementById('export-config-btn');
    const configFileFileInput = document.getElementById('config-file-input');

    if (exportConfigBtn) {
        exportConfigBtn.addEventListener('click', () => {
            const settingsStr = JSON.stringify(localGameState.settings || getSettingsFromUI(), null, 4);
            
            const downloadConfig = () => {
                const blob = new Blob([settingsStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'dominion-config.json';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            };

            showModal({
                title: 'Export Configuration',
                message: 'Copy the JSON string below or download the config file directly:',
                showTextarea: true,
                defaultTextareaValue: settingsStr,
                textareaReadOnly: true,
                confirmText: 'Copy to Clipboard',
                cancelText: 'Download File'
            }).then(() => {
                navigator.clipboard.writeText(settingsStr)
                    .then(() => {
                        showModal({ title: 'Success', message: 'Configuration copied to clipboard successfully!' });
                    })
                    .catch(() => {
                        showModal({ title: 'Error', message: 'Failed to copy to clipboard.' });
                    });
            }).catch(() => {
                downloadConfig();
            });
        });
    }

    if (importConfigBtn) {
        importConfigBtn.addEventListener('click', () => {
            if (!isHost) {
                showModal({ title: 'Permission Denied', message: 'Only the host player can import configurations.' });
                return;
            }
            const isGameActive = localGameState.multiverse && Object.keys(localGameState.multiverse).length > 0;
            if (isGameActive) {
                showModal({ title: 'Forbidden', message: 'Configurations cannot be imported while a game is active.' });
                return;
            }
            
            showModal({
                title: 'Import Configuration',
                message: 'Paste your serialized configuration JSON string below, or cancel to select a configuration file from your computer:',
                showTextarea: true,
                defaultTextareaValue: '',
                confirmText: 'Import String',
                cancelText: 'Upload File'
            }).then((pastedValue) => {
                if (!pastedValue || pastedValue.trim() === '') {
                    showModal({ title: 'Error', message: 'Empty configuration string.' });
                    return;
                }
                try {
                    const parsed = JSON.parse(pastedValue);
                    applyImportedSettings(parsed);
                } catch (e) {
                    showModal({ title: 'Invalid JSON', message: 'The pasted text is not a valid JSON structure.' });
                }
            }).catch(() => {
                if (configFileFileInput) {
                    configFileFileInput.value = '';
                    configFileFileInput.click();
                }
            });
        });
    }

    if (configFileFileInput) {
        configFileFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const parsed = JSON.parse(event.target.result);
                    applyImportedSettings(parsed);
                } catch (err) {
                    showModal({ title: 'Invalid File', message: 'The selected file is not a valid JSON structure.' });
                }
            };
            reader.readAsText(file);
        });
    }

    function applyImportedSettings(settings) {
        if (!settings) return;
        const requiredKeys = ['fogOfWar', 'mountainPercent', 'forestPercent', 'cityCount'];
        const hasRequired = requiredKeys.every(k => k in settings);
        
        if (!hasRequired) {
            showModal({ title: 'Import Failed', message: 'The uploaded JSON is missing core configuration keys.' });
            return;
        }

        setSettingsToUI(settings);
        emitSettingsChange();
        showModal({ title: 'Success', message: 'Configuration successfully imported and applied!' });
    }

    allCustomizationInputs.forEach(i => {
        if (i) i.addEventListener('change', emitSettingsChange);
    });
    document.getElementById('split-timeline-btn').addEventListener('click', handleSplitTimelineClick);
    document.getElementById('rollback-timeline-btn').addEventListener('click', handleRollbackTimelineClick);
    document.getElementById('anchor-timeline-btn').addEventListener('click', handleAnchorTimelineClick);
    document.getElementById('freeze-timeline-btn').addEventListener('click', handleFreezeTimelineClick);
    document.getElementById('overclock-timeline-btn').addEventListener('click', handleOverclockTimelineClick);
    document.getElementById('hop-timeline-btn').addEventListener('click', handleHopTimelineClick);
    document.getElementById('add-ai-btn').addEventListener('click', () => {
        socket.emit('add-ai-player');
    });
    document.getElementById('return-lobby-btn').addEventListener('click', () => {
        socket.emit('return-to-lobby');
    });

    const devModeToggle = document.getElementById('devModeToggle');
    if (devModeToggle) {
        devModeToggle.addEventListener('change', (e) => {
            devMode = e.target.checked;
            const aiDebugContainer = document.getElementById('ai-debug-container');
            if (aiDebugContainer) {
                if (!devMode) {
                    aiDebugContainer.classList.add('hidden');
                } else if (localGameState && localGameState.aiThoughts && localGameState.aiThoughts.length > 0) {
                    devModeToggle.checked && aiDebugContainer.classList.remove('hidden');
                }
            }
            const retireAiBtn = document.getElementById('retire-ai-btn');
            if (retireAiBtn) {
                const isGameActive = localGameState.multiverse && Object.keys(localGameState.multiverse).length > 0;
                retireAiBtn.classList.toggle('hidden', !(devMode && isGameActive && !hasRetired));
            }
        });
    }

    const retireAiBtn = document.getElementById('retire-ai-btn');
    if (retireAiBtn) {
        retireAiBtn.addEventListener('click', () => {
            showModal({
                title: 'Retire to AI Control',
                message: 'Are you sure you want to hand control of your General and armies over to the AI agent? You will become a spectator and can watch the game unfold.',
                confirmText: 'Retire to AI',
                cancelText: 'Cancel'
            }).then(() => {
                hasRetired = true;
                retireAiBtn.classList.add('hidden');
                socket.emit('player-retire-to-ai');
            }).catch(() => {});
        });
    }
    
    /**
     * The main animation loop. Requests a new frame and calls the main render function.
     */
    function animationLoop() {
        render();
        requestAnimationFrame(animationLoop);
    }
    animationLoop();
};