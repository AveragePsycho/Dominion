// public/client.js

window.onload = function() {
    console.log("Client script loaded!");
    const socket = io();

    // --- 1. LOCAL STATE & CONSTANTS ---
    const BASE_TILE_SIZE = 20;
    let PLAYER_COLORS = { 0: '#333333' };
    const TILE_TYPE = { EMPTY: 0, MOUNTAIN: 1, CITY: 2, GENERAL: 3, FOREST: 4, ERASED: 5 };
    const MOVE_TICKS = 2; // Must match server
    const GAME_TICK_MS = 500; // Must match server

    // --- Dynamic Cost Formulas (Client-side for UI) ---
    function calculateFreezeCost(duration) { return Math.floor(15 * Math.pow(1.07, duration / 5)); }
    function calculateOverclockCost(duration) { return Math.floor(20 * Math.pow(1.08, duration / 5)); }
    function calculatePortalCost(duration) { return Math.floor(40 * Math.pow(1.06, duration / 5)); }
    const COST_CALCULATORS = {
        FREEZE: calculateFreezeCost,
        OVERCLOCK: calculateOverclockCost,
        HOP: calculatePortalCost,
    };

    let localGameState = {
        multiverse: {}, portals: [], paradoxEvents: [], visibilityGrid: [],
        boardDimensions: { cols: 40, rows: 30 },
        playerStats: {},
        settings: {}
    };
    let myPlayerId = null, myColor = '#FFFFFF', activeTimelineId = 'timeline-alpha';
    let inputState = { isDragging: false, startTile: null, path: [], endTile: null };
    let selectedTile = null, isFogOfWarEnabled = true;
    let isReady = false;
    let isHost = false;
    let players = [];
    
    // --- Client-side animation state ---
    let lastServerUpdate = performance.now();


    const camera = { x: 0, y: 0, zoom: 1.0, minZoom: 0.3, maxZoom: 3.0 };
    let panningState = { isPanning: false, lastMouseX: 0, lastMouseY: 0 };

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

    // --- Customization UI Elements (FIXED) ---
    const fogToggle = document.getElementById('fogToggle');
    const staggeredStartToggle = document.getElementById('staggeredStartToggle');
    const fairGeneralsToggle = document.getElementById('fairGeneralsToggle');
    const mountainPercent = document.getElementById('mountainPercent');
    const forestPercent = document.getElementById('forestPercent');
    const cityCount = document.getElementById('cityCount');
    const allCustomizationInputs = [fogToggle, staggeredStartToggle, fairGeneralsToggle, mountainPercent, forestPercent, cityCount];


    // --- Custom Modal Elements and Logic ---
    const modalOverlay = document.getElementById('custom-modal-overlay');
    const modalTitle = document.getElementById('modal-title');
    const modalMessage = document.getElementById('modal-message');
    const modalInput = document.getElementById('modal-input');
    const modalCostDisplay = document.getElementById('modal-cost-display');
    const modalConfirmBtn = document.getElementById('modal-confirm-btn');
    const modalCancelBtn = document.getElementById('modal-cancel-btn');

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
    socket.on('player-assignment', (data) => {
        myPlayerId = data.playerId; myColor = data.color;
        const playerIdDisplay = document.getElementById('player-id-display');
        if (playerIdDisplay) { playerIdDisplay.textContent = `You are Player ${myPlayerId}`; playerIdDisplay.style.color = myColor; }
    });

    socket.on('lobby-update', ({ players: playerList, settings, hostPlayerId }) => {
        players = playerList;
        PLAYER_COLORS = { 0: '#333333' }; 
        players.forEach(p => { PLAYER_COLORS[p.id] = p.color; });

        isHost = myPlayerId === hostPlayerId;
        updatePlayerListView(hostPlayerId);
        updateLobbyUI(settings);
    });

    socket.on('game-state-update', (newState) => {
        if (!localGameState.multiverse[activeTimelineId] && Object.keys(newState.multiverse).length > 0) {
            activeTimelineId = Object.keys(newState.multiverse)[0] || 'timeline-alpha';
        }
        if (newState.multiverse && !newState.multiverse[activeTimelineId]) {
            const oldTimeline = localGameState.multiverse[activeTimelineId];
            activeTimelineId = (oldTimeline && newState.multiverse[oldTimeline.parentId]) ? oldTimeline.parentId : 'timeline-alpha';
        }
        localGameState = newState;
        lastServerUpdate = performance.now();
        updatePlayerListView(null);

        // Update dynamic cost button
        const splitBtn = document.getElementById('split-timeline-btn');
        if (splitBtn && localGameState.multiverse) {
            const numTimelines = Object.keys(localGameState.multiverse).length;
            const splitCost = Math.floor(250 * Math.pow(1.25, numTimelines - 1));
            splitBtn.textContent = `Split Timeline (Cost: ${splitCost})`;
        }

        // Gated time travel UI check
        if (localGameState.settings && localGameState.settings.staggeredStart) {
            const stats = localGameState.playerStats;
            const totalArmy = stats?.global?.[myPlayerId]?.army || 0;
            if (totalArmy >= 1000) {
                timelineControls.classList.remove('hidden');
                timelineListContainer.classList.remove('hidden');
            } else {
                timelineControls.classList.add('hidden');
                timelineListContainer.classList.add('hidden');
            }
        }
    });
    
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
    
    function updateLobbyUI(settings) {
        allCustomizationInputs.forEach(input => input.disabled = !isHost);
        fogToggle.checked = settings.fogOfWar;
        staggeredStartToggle.checked = settings.staggeredStart;
        fairGeneralsToggle.checked = settings.fairGenerals;
        mountainPercent.value = settings.mountainPercent;
        forestPercent.value = settings.forestPercent;
        cityCount.value = settings.cityCount;
    }

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

    socket.on('game-in-progress', () => { document.body.innerHTML = '<h1>Game in progress. Please wait for the next round.</h1>'; });

    // ... render, renderTimelineTree, and other functions remain unchanged ...
    function getCausalityColor(tag, currentStep) { if (!tag) return '#FFFFFF'; const age = currentStep - tag.originStep; const normalizedAge = Math.min(Math.max(age, 0), 100); const r = Math.floor(139 + (255 - 139) * (normalizedAge / 100)); const g = Math.floor(0 + (182 - 0) * (normalizedAge / 100)); const b = Math.floor(0 + (193 - 0) * (normalizedAge / 100)); return `rgb(${r},${g},${b})`; }
    function render() { ctx.save(); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.translate(camera.x, camera.y); ctx.scale(camera.zoom, camera.zoom); const currentTimeline = localGameState.multiverse[activeTimelineId]; if (!currentTimeline) { ctx.restore(); ctx.fillStyle = 'white'; ctx.font = '24px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Waiting for players to ready up...', canvas.width / 2, canvas.height / 2); renderTimelineTree(); return; } const activeGameState = currentTimeline.currentState; const TILE_SIZE = BASE_TILE_SIZE; const view = { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, width: canvas.width / camera.zoom, height: canvas.height / camera.zoom }; const startCol = Math.floor(view.x / TILE_SIZE); const endCol = Math.ceil((view.x + view.width) / TILE_SIZE); const startRow = Math.floor(view.y / TILE_SIZE); const endRow = Math.ceil((view.y + view.height) / TILE_SIZE); for (let row = startRow; row < endRow; row++) { for (let col = startCol; col < endCol; col++) { if (row < 0 || row >= localGameState.boardDimensions.rows || col < 0 || col >= localGameState.boardDimensions.cols) continue; const x = col * TILE_SIZE, y = row * TILE_SIZE; if (isFogOfWarEnabled && localGameState.visibilityGrid && !localGameState.visibilityGrid[row]?.[col]) { ctx.fillStyle = '#111111'; ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE); continue; } const tile = activeGameState.board[row]?.[col]; if (!tile) continue; if(tile.type === TILE_TYPE.ERASED) { ctx.fillStyle = '#000000'; ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE); continue; } ctx.fillStyle = PLAYER_COLORS[tile.ownerId] || '#FFFFFF'; if (tile.type === TILE_TYPE.MOUNTAIN) { ctx.fillStyle = '#555555'; } else if (tile.type === TILE_TYPE.FOREST) { ctx.fillStyle = '#006400'; } ctx.fillRect(x, y, TILE_SIZE - 1, TILE_SIZE - 1); const isPortal = localGameState.portals.some(p => p.fromTimelineId === activeTimelineId && p.coords.row === row && p.coords.col === col); if (isPortal) { ctx.fillStyle = '#8A2BE2'; ctx.beginPath(); ctx.arc(x + TILE_SIZE * 0.75, y + TILE_SIZE * 0.25, TILE_SIZE / 5, 0, Math.PI * 2); ctx.fill(); } if (tile.type === TILE_TYPE.GENERAL) { ctx.fillStyle = '#490c3aff'; ctx.beginPath(); ctx.arc(x + TILE_SIZE / 2, y + TILE_SIZE / 2, TILE_SIZE / 4, 0, Math.PI * 2); ctx.fill(); } else if (tile.type === TILE_TYPE.CITY) { ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2 / camera.zoom; ctx.strokeRect(x + 1, y + 1, TILE_SIZE - 3, TILE_SIZE - 3); } if (tile.army > 0 && tile.type !== TILE_TYPE.MOUNTAIN && camera.zoom > 0.5) { const isMyTile = tile.ownerId === myPlayerId; const isArmyVisible = (tile.type !== TILE_TYPE.FOREST) || isMyTile; if (isArmyVisible) { ctx.fillStyle = getCausalityColor(tile.causalityTag, activeGameState.gameStep); ctx.font = `bold ${TILE_SIZE / 2}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(tile.army, x + TILE_SIZE / 2, y + TILE_SIZE / 2); } } } } if (currentTimeline.isUnravelling && currentTimeline.unravelCenter) { ctx.fillStyle = 'rgba(255, 0, 255, 0.2)'; ctx.beginPath(); const centerX = currentTimeline.unravelCenter.col * TILE_SIZE + TILE_SIZE / 2; const centerY = currentTimeline.unravelCenter.row * TILE_SIZE + TILE_SIZE / 2; ctx.arc(centerX, centerY, currentTimeline.unravelRadius * TILE_SIZE, 0, Math.PI * 2); ctx.fill(); } const activeTimelinesCount = Object.keys(localGameState.multiverse).filter(id => !localGameState.multiverse[id].isFrozen).length || 1; const tickDurationMs = GAME_TICK_MS * activeTimelinesCount; const segmentDuration = tickDurationMs * MOVE_TICKS; for (const move of activeGameState.moves) { const currentPos = move.path[move.pathIndex]; if (isFogOfWarEnabled && localGameState.visibilityGrid && !localGameState.visibilityGrid[currentPos.row]?.[currentPos.col]) { continue; } const segmentStart = move.path[move.pathIndex]; const segmentEnd = move.path[move.pathIndex + 1]; if(!segmentStart || !segmentEnd) continue; const timeSinceUpdate = performance.now() - lastServerUpdate; const progressInSegment = (tickDurationMs * move.progress) + timeSinceUpdate; const totalFraction = Math.min(progressInSegment / segmentDuration, 1.0); const startX = (segmentStart.col * TILE_SIZE) + (TILE_SIZE / 2); const startY = (segmentStart.row * TILE_SIZE) + (TILE_SIZE / 2); const endX = (segmentEnd.col * TILE_SIZE) + (TILE_SIZE / 2); const endY = (segmentEnd.row * TILE_SIZE) + (TILE_SIZE / 2); const currentX = startX + (endX - startX) * totalFraction; const currentY = startY + (endY - startY) * totalFraction; ctx.beginPath(); ctx.arc(currentX, currentY, TILE_SIZE / 2, 0, Math.PI * 2); ctx.fillStyle = PLAYER_COLORS[move.ownerId]; ctx.fill(); ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 1 / camera.zoom; ctx.stroke(); if (camera.zoom > 0.5) { ctx.fillStyle = getCausalityColor(move.causalityTag, activeGameState.gameStep); ctx.font = `bold ${TILE_SIZE / 2}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(move.army, currentX, currentY); } } if (inputState.isDragging && inputState.path.length > 0) { ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2 / camera.zoom; ctx.beginPath(); const firstTile = inputState.path[0]; ctx.moveTo((firstTile.col * TILE_SIZE) + (TILE_SIZE / 2), (firstTile.row * TILE_SIZE) + (TILE_SIZE / 2)); for (let i = 1; i < inputState.path.length; i++) { const tile = inputState.path[i]; ctx.lineTo((tile.col * TILE_SIZE) + (TILE_SIZE / 2), (tile.row * TILE_SIZE) + (TILE_SIZE / 2)); } if (inputState.endTile) { ctx.lineTo((inputState.endTile.col * TILE_SIZE) + (TILE_SIZE / 2), (inputState.endTile.row * TILE_SIZE) + (TILE_SIZE / 2)); } ctx.stroke(); } if (selectedTile) { const x = selectedTile.col * TILE_SIZE, y = selectedTile.row * TILE_SIZE; ctx.strokeStyle = '#FFFF00'; ctx.lineWidth = 3 / camera.zoom; ctx.strokeRect(x, y, TILE_SIZE, TILE_SIZE); } ctx.restore(); renderTimelineTree(); }
    function renderTimelineTree() { const PADDING = 20; const X_SPACING = 50; const Y_SCALE = 0.5; treeCtx.clearRect(0, 0, treeCanvas.width, treeCanvas.height); treeCtx.fillStyle = '#FFFFFF'; treeCtx.strokeStyle = '#FFFFFF'; treeCtx.font = '12px sans-serif'; if (!localGameState.multiverse || Object.keys(localGameState.multiverse).length === 0) return; let maxStep = 0; for (const id in localGameState.multiverse) { if (localGameState.multiverse[id].currentState.gameStep > maxStep) { maxStep = localGameState.multiverse[id].currentState.gameStep; } } maxStep = Math.max(maxStep, 1); const timelinePositions = {}; const timelineLevels = {}; function assignLevels(timelineId, level) { if(timelineLevels[timelineId] !== undefined) return; timelineLevels[timelineId] = level; Object.values(localGameState.multiverse).forEach(child => { if (child.parentId === timelineId) { assignLevels(child.id, level + 1); } }); } assignLevels('timeline-alpha', 0); Object.keys(timelineLevels).forEach(id => { const level = timelineLevels[id]; timelinePositions[id] = { x: PADDING + level * X_SPACING }; }); for (const id in localGameState.multiverse) { const timeline = localGameState.multiverse[id]; const pos = timelinePositions[id]; if (!pos) continue; const startY = PADDING + timeline.splitStep * Y_SCALE; const endY = PADDING + timeline.currentState.gameStep * Y_SCALE; treeCtx.beginPath(); treeCtx.moveTo(pos.x, startY); treeCtx.lineTo(pos.x, endY); treeCtx.lineWidth = timeline.id === activeTimelineId ? 4 : 2; treeCtx.strokeStyle = timeline.isUnravelling ? '#FF00FF' : '#FFFFFF'; treeCtx.stroke(); if (timeline.parentId && timelinePositions[timeline.parentId]) { const parentPos = timelinePositions[timeline.parentId]; treeCtx.beginPath(); treeCtx.moveTo(parentPos.x, startY); treeCtx.lineTo(pos.x, startY); treeCtx.lineWidth = 1; treeCtx.strokeStyle = '#888888'; treeCtx.stroke(); } treeCtx.beginPath(); treeCtx.arc(pos.x, endY, 5, 0, Math.PI * 2); treeCtx.fillStyle = timeline.id === activeTimelineId ? '#007bff' : '#FFFFFF'; treeCtx.fill(); treeCtx.fillText(id.split('-')[1], pos.x + 10, endY + 4); } }
    function getTileFromMouseEvent(event) { const rect = canvas.getBoundingClientRect(); const x = (event.clientX - rect.left - camera.x) / camera.zoom; const y = (event.clientY - rect.top - camera.y) / camera.zoom; const col = Math.floor(x / BASE_TILE_SIZE); const row = Math.floor(y / BASE_TILE_SIZE); if (row >= 0 && row < localGameState.boardDimensions.rows && col >= 0 && col < localGameState.boardDimensions.cols) return { row, col }; return null; } canvas.addEventListener('mousedown', (event) => { if (event.button === 0) { const tileCoords = getTileFromMouseEvent(event); if (tileCoords) { inputState.isDragging = true; inputState.startTile = tileCoords; inputState.path = [tileCoords]; inputState.endTile = tileCoords; } } else if (event.button === 1) { event.preventDefault(); panningState.isPanning = true; panningState.lastMouseX = event.clientX; panningState.lastMouseY = event.clientY; } }); canvas.addEventListener('mousemove', (event) => { if (inputState.isDragging) { const currentTileCoords = getTileFromMouseEvent(event); if (currentTileCoords) { inputState.endTile = currentTileCoords; const lastTileInPath = inputState.path[inputState.path.length - 1]; if (currentTileCoords.row !== lastTileInPath.row || currentTileCoords.col !== lastTileInPath.col) { const currentTimeline = localGameState.multiverse[activeTimelineId]; if (currentTimeline) { const targetTile = currentTimeline.currentState.board[currentTileCoords.row]?.[currentTileCoords.col]; if (targetTile && targetTile.type !== TILE_TYPE.MOUNTAIN) { inputState.path.push(currentTileCoords); } } } } } else if (panningState.isPanning) { const dx = event.clientX - panningState.lastMouseX; const dy = event.clientY - panningState.lastMouseY; camera.x += dx; camera.y += dy; panningState.lastMouseX = event.clientX; panningState.lastMouseY = event.clientY; } }); canvas.addEventListener('mouseup', (event) => { if (event.button === 0) { if (inputState.isDragging) { if (inputState.path.length > 1) { socket.emit('player-action', { type: 'MOVE', path: inputState.path, activeTimelineId: activeTimelineId }); selectedTile = null; } else { selectedTile = inputState.startTile; } inputState.isDragging = false; inputState.startTile = null; inputState.endTile = null; inputState.path = []; } } else if (event.button === 1) { panningState.isPanning = false; } }); canvas.addEventListener('contextmenu', e => e.preventDefault()); canvas.addEventListener('wheel', (event) => { event.preventDefault(); const rect = canvas.getBoundingClientRect(); const mouseX = event.clientX - rect.left; const mouseY = event.clientY - rect.top; const worldX = (mouseX - camera.x) / camera.zoom; const worldY = (mouseY - camera.y) / camera.zoom; const zoomFactor = event.deltaY > 0 ? 0.9 : 1.1; const newZoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, camera.zoom * zoomFactor)); camera.x = mouseX - worldX * newZoom; camera.y = mouseY - worldY * newZoom; camera.zoom = newZoom; }, { passive: false });
    readyBtn.addEventListener('click', () => { isReady = !isReady; socket.emit('player-ready', isReady); if (isReady) { readyBtn.textContent = 'Unready'; readyBtn.classList.add('ready'); } else { readyBtn.textContent = 'Ready Up'; readyBtn.classList.remove('ready'); } });
    window.addEventListener('keydown', (event) => { if (!modalOverlay.classList.contains('hidden')) return; const timelineIds = Object.keys(localGameState.multiverse); if (timelineIds.length > 1) { const currentIndex = timelineIds.indexOf(activeTimelineId); let newIndex = currentIndex; if (event.key === 'e') { newIndex = (currentIndex + 1) % timelineIds.length; } else if (event.key === 'q') { newIndex = (currentIndex - 1 + timelineIds.length) % timelineIds.length; } if (newIndex !== currentIndex) { activeTimelineId = timelineIds[newIndex]; updatePlayerListView(); } } if (selectedTile) { let dest = null; switch (event.key) { case 'w': case 'ArrowUp': dest = { row: selectedTile.row - 1, col: selectedTile.col }; event.preventDefault(); break; case 'a': case 'ArrowLeft': dest = { row: selectedTile.row, col: selectedTile.col - 1 }; event.preventDefault(); break; case 's': case 'ArrowDown': dest = { row: selectedTile.row + 1, col: selectedTile.col }; event.preventDefault(); break; case 'd': case 'ArrowRight': dest = { row: selectedTile.row, col: selectedTile.col + 1 }; event.preventDefault(); break; } if (dest) { if (dest.row >= 0 && dest.row < localGameState.boardDimensions.rows && dest.col >= 0 && dest.col < localGameState.boardDimensions.cols) { const currentTimeline = localGameState.multiverse[activeTimelineId]; if (currentTimeline) { const targetTile = currentTimeline.currentState.board[dest.row]?.[dest.col]; if (targetTile && targetTile.type !== TILE_TYPE.MOUNTAIN) { const path = [selectedTile, dest]; socket.emit('player-action', { type: 'MOVE', path: path, activeTimelineId: activeTimelineId }); selectedTile = dest; } } } } } });
    document.getElementById('split-timeline-btn').addEventListener('click', () => { socket.emit('player-action', { type: 'SPLIT', activeTimelineId: activeTimelineId }); });
    document.getElementById('rollback-timeline-btn').addEventListener('click', () => { const currentStep = localGameState.multiverse[activeTimelineId]?.currentState.gameStep; if (!currentStep) return; socket.emit('get-rollback-info', { activeTimelineId }); });
    socket.on('rollback-info-response', ({ oldestAffordableStep }) => { const currentStep = localGameState.multiverse[activeTimelineId]?.currentState.gameStep; if (!currentStep) return; showModal({ title: 'Timeline Rollback', message: `Select a step to roll back to. Current step: ${currentStep}. Oldest affordable step: ${oldestAffordableStep}.`, showInput: true, defaultValue: oldestAffordableStep }).then(targetStepInput => { const targetStep = parseInt(targetStepInput); if (!Number.isInteger(targetStep) || targetStep < oldestAffordableStep || targetStep >= currentStep) { showModal({ title: 'Error', message: 'Invalid or unaffordable step number.' }); return; } const stepsToRollback = currentStep - targetStep; const cost = Math.floor(10 * Math.pow(1.05, stepsToRollback / 10)); return showModal({ title: 'Confirm Rollback', message: `This will roll back ${stepsToRollback} steps to step ${targetStep}.`, costText: `Estimated Cost: ${cost} army`, }).then(() => { socket.emit('player-action', { type: 'ROLLBACK', activeTimelineId: activeTimelineId, targetStep: targetStep }); }); }).catch(() => {}); });
    socket.on('affordability-info-response', ({ actionType, maxDuration }) => { if (maxDuration <= 0) { showModal({ title: 'Unaffordable', message: 'You do not have enough army on your General to perform this action.'}); return; } showModal({ title: `Set ${actionType} Duration`, message: `Enter duration for ${actionType} (in steps). Maximum affordable is ${maxDuration} steps.`, showInput: true, defaultValue: maxDuration }).then(durationInput => { const duration = parseInt(durationInput); if (!Number.isInteger(duration) || duration <= 0 || duration > maxDuration) { showModal({ title: 'Error', message: 'Invalid or unaffordable duration.'}); return; } const costCalculator = COST_CALCULATORS[actionType]; if(!costCalculator) return; const cost = costCalculator(duration); return showModal({ title: `Confirm ${actionType}`, message: `This action will last for ${duration} steps.`, costText: `Cost: ${cost} army`, }).then(() => { const action = { type: actionType, activeTimelineId: activeTimelineId, duration: duration, cost: cost, }; if(actionType === 'HOP') { if(selectedTile) { action.selectedTile = selectedTile; } else { showModal({ title: 'Error', message: 'You must select a tile to open a portal.'}); return; } } socket.emit('player-action', action); }); }).catch(() => {}); });
    document.getElementById('anchor-timeline-btn').addEventListener('click', () => { socket.emit('player-action', { type: 'ANCHOR', activeTimelineId: activeTimelineId }); });
    document.getElementById('freeze-timeline-btn').addEventListener('click', () => { socket.emit('get-affordability-info', { actionType: 'FREEZE', activeTimelineId: activeTimelineId }); });
    document.getElementById('overclock-timeline-btn').addEventListener('click', () => { socket.emit('get-affordability-info', { actionType: 'OVERCLOCK', activeTimelineId: activeTimelineId }); });
    document.getElementById('hop-timeline-btn').addEventListener('click', () => { if (!selectedTile) { showModal({ title: 'Error', message: 'You must select a tile before opening a portal.'}); return; } socket.emit('get-affordability-info', { actionType: 'HOP', activeTimelineId: activeTimelineId }); });
    treeCanvas.addEventListener('click', (event) => { const timelineIds = Object.keys(localGameState.multiverse); const currentIndex = timelineIds.indexOf(activeTimelineId); const newIndex = (currentIndex + 1) % timelineIds.length; activeTimelineId = timelineIds[newIndex]; updatePlayerListView(); });
    function animationLoop() { render(); requestAnimationFrame(animationLoop); }
    requestAnimationFrame(animationLoop);
};