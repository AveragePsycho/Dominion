// public/client.js

window.onload = function() {
    console.log("Client script loaded!");
    const socket = io();

    // --- 1. LOCAL STATE & CONSTANTS ---
    const BASE_TILE_SIZE = 20;
    let PLAYER_COLORS = { 0: '#333333' };
    const TILE_TYPE = { EMPTY: 0, MOUNTAIN: 1, CITY: 2, GENERAL: 3, FOREST: 4 };

    let localGameState = {
        multiverse: {}, portals: [], paradoxEvents: [], visibilityGrid: [],
        boardDimensions: { cols: 40, rows: 30 },
    };
    let myPlayerId = null, myColor = '#FFFFFF', activeTimelineId = 'timeline-alpha';
    let inputState = { isDragging: false, startTile: null, path: [], endTile: null };
    let selectedTile = null, isFogOfWarEnabled = true;
    let isReady = false;

    const camera = { x: 0, y: 0, zoom: 1.0, minZoom: 0.3, maxZoom: 3.0 };
    let panningState = { isPanning: false, lastMouseX: 0, lastMouseY: 0 };

    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 1280;
    canvas.height = 720;

    const readyBtn = document.getElementById('ready-btn');

    // --- 2. SOCKET.IO EVENT HANDLERS ---
    socket.on('player-assignment', (data) => {
        myPlayerId = data.playerId; myColor = data.color;
        const playerIdDisplay = document.getElementById('player-id-display');
        if (playerIdDisplay) { playerIdDisplay.textContent = `You are Player ${myPlayerId}`; playerIdDisplay.style.color = myColor; }
    });

    socket.on('game-state-update', (newState) => {
        if (!localGameState.multiverse[activeTimelineId]) {
            activeTimelineId = 'timeline-alpha';
        }
        localGameState = newState;
    });

    socket.on('player-list-update', (players) => {
        const playerListElement = document.getElementById('player-list');
        PLAYER_COLORS = { 0: '#333333' }; players.forEach(p => { PLAYER_COLORS[p.id] = p.color; });
        if (playerListElement) {
            playerListElement.innerHTML = '<h3>Connected Players</h3>';
            players.forEach(player => {
                const playerEl = document.createElement('div');
                const readyStatus = player.isReady ? '✔️ Ready' : '❌ Not Ready';
                playerEl.textContent = `${player.name} - ${readyStatus}`;
                playerEl.style.color = player.color; playerEl.style.fontWeight = 'bold';
                playerListElement.appendChild(playerEl);
            });
        }
    });

    socket.on('game-start', () => {
        document.getElementById('game-status').innerText = "";
        readyBtn.style.display = 'none';
    });

    socket.on('game-over', (data) => {
        const statusDiv = document.getElementById('game-status');
        if (data.winnerId === myPlayerId) { statusDiv.innerText = "You are victorious!"; }
        else { statusDiv.innerText = `Game Over! Player ${data.winnerId} is the winner.`; }
        readyBtn.style.display = 'block';
        isReady = false; readyBtn.classList.remove('ready'); readyBtn.textContent = 'Ready Up';
    });

    socket.on('game-in-progress', () => { document.body.innerHTML = '<h1>Game in progress. Please wait for the next round.</h1>'; });

    // --- 3. RENDERING ---
    function render() {
        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.translate(camera.x, camera.y);
        ctx.scale(camera.zoom, camera.zoom);

        const currentTimeline = localGameState.multiverse[activeTimelineId];
        if (!currentTimeline) {
            ctx.restore();
            ctx.fillStyle = 'white'; ctx.font = '24px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('Waiting for players to ready up...', canvas.width / 2, canvas.height / 2);
            renderTimelineList();
            return;
        }

        const activeGameState = currentTimeline.currentState;
        const TILE_SIZE = BASE_TILE_SIZE;

        const view = {
            x: -camera.x / camera.zoom, y: -camera.y / camera.zoom,
            width: canvas.width / camera.zoom, height: canvas.height / camera.zoom
        };
        const startCol = Math.floor(view.x / TILE_SIZE);
        const endCol = Math.ceil((view.x + view.width) / TILE_SIZE);
        const startRow = Math.floor(view.y / TILE_SIZE);
        const endRow = Math.ceil((view.y + view.height) / TILE_SIZE);

        for (let row = startRow; row < endRow; row++) {
            for (let col = startCol; col < endCol; col++) {
                if (row < 0 || row >= localGameState.boardDimensions.rows || col < 0 || col >= localGameState.boardDimensions.cols) continue;

                const x = col * TILE_SIZE, y = row * TILE_SIZE;
                if (isFogOfWarEnabled && localGameState.visibilityGrid && !localGameState.visibilityGrid[row]?.[col]) {
                    ctx.fillStyle = '#111111'; ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE); continue;
                }
                const tile = activeGameState.board[row]?.[col];
                if (!tile) continue;

                ctx.fillStyle = PLAYER_COLORS[tile.ownerId] || '#FFFFFF';
                if (tile.type === TILE_TYPE.MOUNTAIN) { ctx.fillStyle = '#555555'; }
                else if (tile.type === TILE_TYPE.FOREST) { ctx.fillStyle = '#006400'; }
                ctx.fillRect(x, y, TILE_SIZE - 1, TILE_SIZE - 1);

                const isPortal = localGameState.portals.some(p => p.fromTimelineId === activeTimelineId && p.coords.row === row && p.coords.col === col);
                if (isPortal) { ctx.fillStyle = '#8A2BE2'; ctx.beginPath(); ctx.arc(x + TILE_SIZE * 0.75, y + TILE_SIZE * 0.25, TILE_SIZE / 5, 0, Math.PI * 2); ctx.fill(); }
                if (tile.type === TILE_TYPE.GENERAL) { ctx.fillStyle = '#490c3aff'; ctx.beginPath(); ctx.arc(x + TILE_SIZE / 2, y + TILE_SIZE / 2, TILE_SIZE / 4, 0, Math.PI * 2); ctx.fill(); }
                else if (tile.type === TILE_TYPE.CITY) { ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2 / camera.zoom; ctx.strokeRect(x + 1, y + 1, TILE_SIZE - 3, TILE_SIZE - 3); }

                if (tile.army > 0 && tile.type !== TILE_TYPE.MOUNTAIN && camera.zoom > 0.5) {
                    const isMyTile = tile.ownerId === myPlayerId;
                    const isArmyVisible = (tile.type !== TILE_TYPE.FOREST) || isMyTile;
                    if (isArmyVisible) {
                        ctx.fillStyle = '#FFFFFF'; ctx.font = `bold ${TILE_SIZE / 2}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                        ctx.fillText(tile.army, x + TILE_SIZE / 2, y + TILE_SIZE / 2);
                    }
                }
            }
        }
        
        for (const move of activeGameState.moves) {
            const currentPos = move.path[move.pathIndex];
            // --- BUG FIX: Check if the moving army is in the fog of war ---
            if (isFogOfWarEnabled && localGameState.visibilityGrid && !localGameState.visibilityGrid[currentPos.row]?.[currentPos.col]) {
                continue;
            }

            const segmentStart = move.path[move.pathIndex], segmentEnd = move.path[move.pathIndex + 1];
            if(!segmentStart || !segmentEnd) continue;
            const startX = (segmentStart.col * TILE_SIZE) + (TILE_SIZE / 2), startY = (segmentStart.row * TILE_SIZE) + (TILE_SIZE / 2);
            const endX = (segmentEnd.col * TILE_SIZE) + (TILE_SIZE / 2), endY = (segmentEnd.row * TILE_SIZE) + (TILE_SIZE / 2);
            const fraction = Math.min(move.progress / 2, 1);
            const currentX = startX + (endX - startX) * fraction, currentY = startY + (endY - startY) * fraction;
            ctx.beginPath(); ctx.arc(currentX, currentY, TILE_SIZE / 2, 0, Math.PI * 2); ctx.fillStyle = PLAYER_COLORS[move.ownerId]; ctx.fill(); ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 1 / camera.zoom; ctx.stroke();
            if (camera.zoom > 0.5) {
                ctx.fillStyle = '#FFFFFF'; ctx.font = `bold ${TILE_SIZE / 2}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(move.army, currentX, currentY);
            }
        }

        if (inputState.isDragging && inputState.path.length > 0) {
            ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2 / camera.zoom; ctx.beginPath();
            const firstTile = inputState.path[0];
            ctx.moveTo((firstTile.col * TILE_SIZE) + (TILE_SIZE / 2), (firstTile.row * TILE_SIZE) + (TILE_SIZE / 2));
            for (let i = 1; i < inputState.path.length; i++) {
                const tile = inputState.path[i]; ctx.lineTo((tile.col * TILE_SIZE) + (TILE_SIZE / 2), (tile.row * TILE_SIZE) + (TILE_SIZE / 2));
            }
            if (inputState.endTile) { ctx.lineTo((inputState.endTile.col * TILE_SIZE) + (TILE_SIZE / 2), (inputState.endTile.row * TILE_SIZE) + (TILE_SIZE / 2)); }
            ctx.stroke();
        }

        if (selectedTile) {
            const x = selectedTile.col * TILE_SIZE, y = selectedTile.row * TILE_SIZE;
            ctx.strokeStyle = '#FFFF00'; ctx.lineWidth = 3 / camera.zoom; ctx.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
        }
        
        ctx.restore();
        renderTimelineList();
    }

    function renderTimelineList() {
        const listElement = document.getElementById('timeline-list');
        listElement.innerHTML = '';
        for (const timelineId in localGameState.multiverse) {
            const timeline = localGameState.multiverse[timelineId];
            const li = document.createElement('li');
            let statusText = `(Step: ${timeline.currentState.gameStep})`;
            if (timeline.isFrozen) { statusText = `(FROZEN until ${timeline.freezeUntilStep})`; } else if (timeline.speedMultiplier > 1.0) { statusText = `(OVERCLOCKED until ${timeline.overclockUntilStep})`; }
            if (timeline.anchorStep > 0) { statusText += ` (Anchored: ${timeline.anchorStep})`; }
            li.textContent = `ID: ${timeline.id.split('-')[1]} ${statusText}`;
            li.style.padding = '5px'; li.style.border = '1px solid #555'; li.style.marginBottom = '5px'; li.style.cursor = 'pointer';
            li.dataset.timelineId = timeline.id;
            if (timeline.id === activeTimelineId) { li.style.backgroundColor = '#007bff'; }
            listElement.appendChild(li);
        }
    }
    
    // --- 4. INPUT EVENT LISTENERS ---
    function getTileFromMouseEvent(event) {
        const rect = canvas.getBoundingClientRect();
        const x = (event.clientX - rect.left - camera.x) / camera.zoom;
        const y = (event.clientY - rect.top - camera.y) / camera.zoom;
        const col = Math.floor(x / BASE_TILE_SIZE);
        const row = Math.floor(y / BASE_TILE_SIZE);
        if (row >= 0 && row < localGameState.boardDimensions.rows && col >= 0 && col < localGameState.boardDimensions.cols) return { row, col };
        return null;
    }

    canvas.addEventListener('mousedown', (event) => {
        if (event.button === 0) {
            const tileCoords = getTileFromMouseEvent(event);
            if (tileCoords) { inputState.isDragging = true; inputState.startTile = tileCoords; inputState.path = [tileCoords]; inputState.endTile = tileCoords; }
        } else if (event.button === 1) {
            event.preventDefault();
            panningState.isPanning = true; panningState.lastMouseX = event.clientX; panningState.lastMouseY = event.clientY;
        }
    });

    canvas.addEventListener('mousemove', (event) => {
        if (inputState.isDragging) {
            const currentTileCoords = getTileFromMouseEvent(event);
            if (currentTileCoords) {
                inputState.endTile = currentTileCoords;
                const lastTileInPath = inputState.path[inputState.path.length - 1];
                if (currentTileCoords.row !== lastTileInPath.row || currentTileCoords.col !== lastTileInPath.col) {
                    const currentTimeline = localGameState.multiverse[activeTimelineId];
                    if (currentTimeline) {
                        const targetTile = currentTimeline.currentState.board[currentTileCoords.row]?.[currentTileCoords.col];
                        if (targetTile && targetTile.type !== TILE_TYPE.MOUNTAIN) {
                            inputState.path.push(currentTileCoords);
                        }
                    }
                }
            }
        } else if (panningState.isPanning) {
            const dx = event.clientX - panningState.lastMouseX;
            const dy = event.clientY - panningState.lastMouseY;
            camera.x += dx; camera.y += dy;
            panningState.lastMouseX = event.clientX; panningState.lastMouseY = event.clientY;
        }
    });

    canvas.addEventListener('mouseup', (event) => {
        if (event.button === 0) {
            if (inputState.isDragging) {
                if (inputState.path.length > 1) {
                    socket.emit('player-action', { type: 'MOVE', path: inputState.path, activeTimelineId: activeTimelineId });
                    selectedTile = null;
                } else {
                    selectedTile = inputState.startTile;
                }
                inputState.isDragging = false;
                inputState.startTile = null;
                inputState.endTile = null;
                inputState.path = [];
            }
        } else if (event.button === 1) {
            panningState.isPanning = false;
        }
    });
    
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const worldX = (mouseX - camera.x) / camera.zoom;
        const worldY = (mouseY - camera.y) / camera.zoom;

        const zoomFactor = event.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, camera.zoom * zoomFactor));
        
        camera.x = mouseX - worldX * newZoom;
        camera.y = mouseY - worldY * newZoom;
        camera.zoom = newZoom;
    }, { passive: false });
    
    readyBtn.addEventListener('click', () => {
        isReady = !isReady;
        socket.emit('player-ready', isReady);
        if (isReady) {
            readyBtn.textContent = 'Unready';
            readyBtn.classList.add('ready');
        } else {
            readyBtn.textContent = 'Ready Up';
            readyBtn.classList.remove('ready');
        }
    });
    
    document.getElementById('fogToggle').addEventListener('change', (event) => { isFogOfWarEnabled = event.target.checked; });
    document.getElementById('split-timeline-btn').addEventListener('click', () => { socket.emit('player-action', { type: 'SPLIT', activeTimelineId: activeTimelineId }); });
    document.getElementById('freeze-timeline-btn').addEventListener('click', () => { socket.emit('player-action', { type: 'FREEZE', activeTimelineId: activeTimelineId }); });
    document.getElementById('overclock-timeline-btn').addEventListener('click', () => { socket.emit('player-action', { type: 'OVERCLOCK', activeTimelineId: activeTimelineId }); });
    document.getElementById('rollback-timeline-btn').addEventListener('click', () => {
    const currentStep = localGameState.multiverse[activeTimelineId]?.currentState.gameStep;
    if (!currentStep) return;

    const targetStepInput = prompt(`Rollback to which step? (Current is ${currentStep})`, currentStep - 10);
    const targetStep = parseInt(targetStepInput);

    if (!isNaN(targetStep) && targetStep > 0 && targetStep < currentStep) {
        socket.emit('player-action', {
            type: 'ROLLBACK',
            activeTimelineId: activeTimelineId,
            targetStep: targetStep
        });
    } else {
        alert("Invalid step number.");
    }
    });
    document.getElementById('anchor-timeline-btn').addEventListener('click', () => { socket.emit('player-action', { type: 'ANCHOR', activeTimelineId: activeTimelineId }); });
    document.getElementById('hop-timeline-btn').addEventListener('click', () => { if (selectedTile) { socket.emit('player-action', { type: 'HOP', activeTimelineId: activeTimelineId, selectedTile: selectedTile }); } else { console.log("Client: Select a tile before opening a portal."); } });
    document.getElementById('timeline-list').addEventListener('click', (event) => { if (event.target && event.target.nodeName === "LI") { const newActiveId = event.target.dataset.timelineId; if (newActiveId && newActiveId !== activeTimelineId) { activeTimelineId = newActiveId; renderTimelineList(); } } });

    // --- 5. GAME LOOPS ---
    function animationLoop() {
        render();
        requestAnimationFrame(animationLoop);
    }
    requestAnimationFrame(animationLoop);
};