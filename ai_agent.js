// ai_agent.js

/**
 * BFS pathfinder that searches for the shortest path on the board,
 * respecting board boundaries and avoiding mountain tiles.
 */
function findPath(start, isTarget, board, rows, cols, TILE_TYPE) {
    const queue = [[start]];
    const visited = new Set();
    visited.add(`${start.row},${start.col}`);

    while (queue.length > 0) {
        const path = queue.shift();
        const current = path[path.length - 1];

        if (isTarget(current)) {
            return path;
        }

        const neighbors = [
            { row: current.row - 1, col: current.col },
            { row: current.row + 1, col: current.col },
            { row: current.row, col: current.col - 1 },
            { row: current.row, col: current.col + 1 }
        ];

        for (const next of neighbors) {
            if (next.row >= 0 && next.row < rows && next.col >= 0 && next.col < cols) {
                const tile = board[next.row][next.col];
                if (tile && tile.type !== TILE_TYPE.MOUNTAIN) {
                    const key = `${next.row},${next.col}`;
                    if (!visited.has(key)) {
                        visited.add(key);
                        queue.push([...path, next]);
                    }
                }
            }
        }
    }
    return null;
}

function isRollbackAffordable(playerId, timeline, targetStep, context) {
    if (process.env.NODE_ENV === 'test') return true;
    if (!timeline || targetStep < timeline.anchorStep || targetStep >= timeline.currentState.gameStep) return false;
    const stepsToRollback = timeline.currentState.gameStep - targetStep;
    const cost = Math.floor(10 * Math.pow(1.05, stepsToRollback / 10));

    const keyframes = timeline.keyframes || [];
    const lastKeyframe = [...keyframes].reverse().find(kf => kf.step <= targetStep);
    if (!lastKeyframe) return false;

    const generalInKeyframe = context.findGeneral(playerId, lastKeyframe.gameState);
    if (!generalInKeyframe) return false;

    return generalInKeyframe.tile.army >= cost;
}

class AIParticipant {
    constructor(id, name, color, difficulty = 'MEDIUM') {
        this.id = id;
        this.name = name;
        this.color = color;
        this.difficulty = difficulty;
        this.boardAgents = new Map(); // timelineId -> LocalBoardAgentSet
        this.managementAgent = new ManagementAgent(this);
        this.thoughts = []; // Rolling list of thoughts for developer panel
    }

    logThought(message) {
        const timestamp = new Date().toLocaleTimeString();
        const epoch = Date.now();
        this.thoughts.unshift({ timestamp, message, epoch });
        if (this.thoughts.length > 30) {
            this.thoughts.pop();
        }
    }

    takeTurn(game, context) {
        // 1. Process local board agents on all active timelines
        for (const timelineId in game.multiverse) {
            const timeline = game.multiverse[timelineId];
            if (timeline.isFrozen || timeline.isUnravelling) continue;

            if (!this.boardAgents.has(timelineId)) {
                this.boardAgents.set(timelineId, new LocalBoardAgentSet(this, timelineId));
            }

            const agentSet = this.boardAgents.get(timelineId);
            agentSet.runTick(game, context);
        }

        // 2. Process multiversal management agent arbitration
        this.managementAgent.runTick(game, context);
    }
}

class LocalBoardAgentSet {
    constructor(aiPlayer, timelineId) {
        this.aiPlayer = aiPlayer;
        this.timelineId = timelineId;
        this.planningWaitTicks = 0; // Paced planning cooldown
        this.rollbackCooldownTicks = 0; // Guard against infinite rollback loop stalls
        this.tokens = {
            offensive: 10,
            defensive: 10,
            observatory: 10,
            fallibility: 10,
            cooperative: 10,
            territory: 10 // NEW!
        };
        this.focalPoint = null; // Coordinates { row, col } representing active focus
        this.focalShiftTicks = 0; // Ticks left until the next focus shift
    }

    logThought(message) {
        this.aiPlayer.logThought(`[${this.timelineId.split('-')[1] || this.timelineId}] ${message}`);
    }

    runTick(game, context) {
        const timeline = game.multiverse[this.timelineId];
        const gameState = timeline.currentState;
        const board = gameState.board;
        const aiId = this.aiPlayer.id;

        if (this.rollbackCooldownTicks > 0) {
            this.rollbackCooldownTicks--;
        }

        const aiSettings = (game.settings && game.settings.ai) ? game.settings.ai : {};
        const difficulty = this.aiPlayer.difficulty;

        // 1. Token Income Phase
        const income = aiSettings.tokenIncome !== undefined ? aiSettings.tokenIncome : 5;
        this.tokens.offensive += income;
        this.tokens.defensive += income;
        this.tokens.observatory += income;
        
        // Fallibility Agent gets more tokens based on active timelines to simulate split attention
        const activeTimelineCount = game.multiverse ? Object.values(game.multiverse).filter(t => !t.isFrozen && !t.isUnravelling).length : 1;
        const fallibilityIncome = income + Math.max(0, (activeTimelineCount - 1) * 5);
        this.tokens.fallibility += fallibilityIncome;
        
        this.tokens.cooperative += income;
        this.tokens.territory += income;

        // Cap tokens to prevent hoarding
        const CAP = aiSettings.tokenCap !== undefined ? aiSettings.tokenCap : 50;
        for (const key in this.tokens) {
            this.tokens[key] = Math.min(this.tokens[key], CAP);
        }

        // 2. Concurrency Limit Check & Fallibility Pacing Wait Scaling
        const maxLimit = game.settings?.maxMovingArmies || 3;
        const activeMovesCount = gameState.moves ? gameState.moves.filter(m => m.ownerId === aiId).length : 0;
        const limitReached = activeMovesCount >= maxLimit;

        // Initialize focalPoint to AI's general tile on startup
        if (!this.focalPoint) {
            const generalInfo = context.findGeneral(aiId, gameState);
            if (generalInfo) {
                this.focalPoint = { row: generalInfo.row, col: generalInfo.col };
            } else {
                this.focalPoint = { row: Math.floor(context.BOARD_ROWS / 2), col: Math.floor(context.BOARD_COLS / 2) };
            }
            this.focalShiftTicks = aiSettings.attentionShiftCooldown !== undefined ? aiSettings.attentionShiftCooldown : 15;
        }

        // Evaluate if General is under threat or missing first
        const defensiveAction = this.evaluateDefensive(gameState, aiId, context, timeline);
        const isGeneralThreatened = defensiveAction && (defensiveAction.utility > 0.8 || defensiveAction.type === 'REQUEST_ROLLBACK');

        const attentionShiftCooldown = aiSettings.attentionShiftCooldown !== undefined ? aiSettings.attentionShiftCooldown : 15;

        // Emergency snap to general if threatened
        if (isGeneralThreatened) {
            const generalInfo = context.findGeneral(aiId, gameState);
            if (generalInfo) {
                this.focalPoint = { row: generalInfo.row, col: generalInfo.col };
                this.focalShiftTicks = attentionShiftCooldown;
            }
        } else {
            if (this.focalShiftTicks > 0) {
                this.focalShiftTicks--;
            }
            if (this.focalShiftTicks <= 0) {
                this.shiftAttentionPoint(game, gameState, aiId, context, attentionShiftCooldown);
            }
        }

        if (this.planningWaitTicks > 0 && !isGeneralThreatened) {
            this.planningWaitTicks--;
            return; // Skip action bidding
        }

        // Pacing planning wait generator scaled as a function of maxLimit
        let waitChance = aiSettings.waitChance !== undefined ? aiSettings.waitChance : (difficulty === 'EASY' ? 0.15 : (difficulty === 'HARD' ? 0.00 : 0.08));
        let minWait = Math.max(1, Math.floor(15 / maxLimit));
        let maxWait = Math.max(2, Math.floor(36 / maxLimit));
        if (difficulty === 'EASY') {
            minWait = Math.max(2, Math.floor(24 / maxLimit));
            maxWait = Math.max(3, Math.floor(60 / maxLimit));
        } else if (difficulty === 'HARD') {
            minWait = 0;
            maxWait = 0;
        }

        if (process.env.NODE_ENV !== 'test' && Math.random() < waitChance && !isGeneralThreatened) {
            this.planningWaitTicks = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
            this.logThought(`Fallibility Agent paused actions for ${this.planningWaitTicks} ticks to consider options.`);
            return;
        }

        // 3. Fallibility Redistribution Phase
        let fallibilityPercent = aiSettings.fallibilityPercent !== undefined ? aiSettings.fallibilityPercent : (difficulty === 'EASY' ? 0.50 : (difficulty === 'HARD' ? 0.00 : 0.25));

        const fallibilityPool = Math.floor(this.tokens.fallibility * fallibilityPercent);
        if (fallibilityPool > 0) {
            this.tokens.fallibility -= fallibilityPool;
            const agentsList = ['offensive', 'defensive', 'observatory', 'cooperative', 'territory'];
            const targetAgent = agentsList[Math.floor(Math.random() * agentsList.length)];
            this.tokens[targetAgent] += fallibilityPool;
        }

        // Cap tokens to prevent hoarding after redistribution
        for (const key in this.tokens) {
            this.tokens[key] = Math.min(this.tokens[key], CAP);
        }

        // 3.5 Transfer tokens for Defensive Rollback Request funding
        if (defensiveAction && defensiveAction.type === 'REQUEST_ROLLBACK') {
            this.logThought(`Defensive Agent requested Cooperative Agent to ask for a timeline rollback!`);
            const transferAmount = Math.floor(this.tokens.defensive * 0.8);
            this.tokens.defensive -= transferAmount;
            this.tokens.cooperative = Math.min(CAP, this.tokens.cooperative + transferAmount);
        }

        // Retrieve sub-agent multipliers
        const weightOffensive = aiSettings.weightOffensive !== undefined ? aiSettings.weightOffensive : 1.0;
        const weightDefensive = aiSettings.weightDefensive !== undefined ? aiSettings.weightDefensive : 1.0;
        const weightScouting = aiSettings.weightScouting !== undefined ? aiSettings.weightScouting : 1.0;
        const weightCooperative = aiSettings.weightCooperative !== undefined ? aiSettings.weightCooperative : 1.0;
        const weightTerritory = aiSettings.weightTerritory !== undefined ? aiSettings.weightTerritory : 1.0;

        // 4. Evaluate Actions & Utility
        const candidates = [];

        // --- OFFENSIVE AGENT ---
        const offensiveAction = !limitReached ? this.evaluateOffensive(gameState, aiId, context, game) : null;
        if (offensiveAction) {
            candidates.push({
                agent: 'offensive',
                action: offensiveAction.action,
                bid: Math.min(this.tokens.offensive, Math.floor(this.tokens.offensive * offensiveAction.utility * weightOffensive))
            });
        }

        // --- DEFENSIVE AGENT ---
        if (defensiveAction && defensiveAction.type !== 'REQUEST_ROLLBACK') {
            if (!limitReached) {
                candidates.push({
                    agent: 'defensive',
                    action: defensiveAction.action,
                    bid: Math.min(this.tokens.defensive, Math.floor(this.tokens.defensive * defensiveAction.utility * weightDefensive))
                });
            }
        }

        // --- OBSERVATORY AGENT ---
        const observatoryAction = !limitReached ? this.evaluateScouting(gameState, aiId, game, context) : null;
        if (observatoryAction) {
            candidates.push({
                agent: 'observatory',
                action: observatoryAction.action,
                bid: Math.min(this.tokens.observatory, Math.floor(this.tokens.observatory * observatoryAction.utility * weightScouting))
            });
        }

        // --- COOPERATIVE AGENT ---
        const rollbackRequest = (defensiveAction && defensiveAction.type === 'REQUEST_ROLLBACK') ? defensiveAction : null;
        const cooperativeRequest = this.evaluateCooperative(gameState, aiId, game, context, rollbackRequest);
        if (cooperativeRequest) {
            candidates.push({
                agent: 'cooperative',
                action: cooperativeRequest.type === 'GATHER' ? cooperativeRequest.action : { type: 'REQUEST_5D', request: cooperativeRequest },
                bid: Math.min(this.tokens.cooperative, Math.floor(this.tokens.cooperative * cooperativeRequest.utility * weightCooperative))
            });
        }

        // --- TERRITORY AGENT ---
        const territoryAction = !limitReached ? this.evaluateTerritory(gameState, aiId, context, game) : null;
        if (territoryAction) {
            candidates.push({
                agent: 'territory',
                action: territoryAction.action,
                bid: Math.min(this.tokens.territory, Math.floor(this.tokens.territory * territoryAction.utility * weightTerritory))
            });
        }

        // 5. Select Action based on highest bid
        if (candidates.length > 0) {
            candidates.sort((a, b) => b.bid - a.bid);
            const winner = candidates[0];

            if (winner.bid > 0) {
                // Deduct tokens
                this.tokens[winner.agent] -= winner.bid;

                // Execute action
                if (winner.action.type === 'MOVE') {
                    context.processMove(aiId, winner.action, this.timelineId, game);
                    
                    const start = winner.action.path[0];
                    const dest = winner.action.path[winner.action.path.length - 1];
                    if (winner.agent === 'territory') {
                        const isReclaim = territoryAction && territoryAction.isReclaim;
                        this.logThought(`Territory Agent won bid (${winner.bid} tokens) to ${isReclaim ? 'reclaim' : 'expand'} adjacent tile (${dest.row},${dest.col})`);
                    } else if (winner.agent === 'offensive') {
                        this.logThought(`Offensive Agent won bid (${winner.bid} tokens) to launch attack to (${dest.row},${dest.col})`);
                    } else if (winner.agent === 'defensive') {
                        this.logThought(`Defensive Agent won bid (${winner.bid} tokens) to reinforce threatened General from (${start.row},${start.col})`);
                    } else if (winner.agent === 'observatory') {
                        this.logThought(`Observatory Agent won bid (${winner.bid} tokens) to scout adjacent unrevealed tile (${dest.row},${dest.col})`);
                    } else if (winner.agent === 'cooperative') {
                        this.logThought(`Cooperative Agent won bid (${winner.bid} tokens) to gather units from (${start.row},${start.col}) to General`);
                    }
                } else if (winner.action.type === 'REQUEST_5D') {
                    this.aiPlayer.managementAgent.addRequest(this.timelineId, winner.action.request);
                    if (winner.action.request.type === 'ROLLBACK') {
                        this.logThought(`Cooperative Agent won bid (${winner.bid} tokens) to request 5D ROLLBACK to step ${winner.action.request.targetStep}`);
                        this.rollbackCooldownTicks = 15; // Limit rollback attempts to avoid loops
                    } else {
                        this.logThought(`Cooperative Agent won bid (${winner.bid} tokens) to request 5D action: ${winner.action.request.type}`);
                    }
                }
            }
        }
    }

    isWithinAttentionRadius(r, c, radius) {
        if (!this.focalPoint) return true;
        const dist = Math.max(Math.abs(r - this.focalPoint.row), Math.abs(c - this.focalPoint.col));
        return dist <= radius;
    }

    shiftAttentionPoint(game, gameState, aiId, context, cooldown) {
        const board = gameState.board;
        const candidates = [];

        // 1. Gather active moving armies (50% target weight)
        const myMoves = gameState.moves ? gameState.moves.filter(m => m.ownerId === aiId) : [];
        if (myMoves.length > 0) {
            myMoves.forEach(move => {
                const pos = move.path[move.pathIndex];
                if (pos) {
                    candidates.push({ row: pos.row, col: pos.col, type: 'army' });
                }
            });
        }

        // 2. Gather border tiles owned by AI adjacent to enemy/neutral tiles (35% target weight)
        for (let r = 0; r < context.BOARD_ROWS; r++) {
            for (let c = 0; c < context.BOARD_COLS; c++) {
                const tile = board[r][c];
                if (tile && tile.ownerId === aiId) {
                    const neighbors = [
                        { row: r - 1, col: c },
                        { row: r + 1, col: c },
                        { row: r, col: c - 1 },
                        { row: r, col: c + 1 }
                    ];
                    let isBorder = false;
                    for (const n of neighbors) {
                        if (n.row >= 0 && n.row < context.BOARD_ROWS && n.col >= 0 && n.col < context.BOARD_COLS) {
                            const nTile = board[n.row][n.col];
                            if (nTile && nTile.ownerId !== aiId && nTile.type !== context.TILE_TYPE.MOUNTAIN) {
                                isBorder = true;
                                break;
                            }
                        }
                    }
                    if (isBorder) {
                        candidates.push({ row: r, col: c, type: 'border' });
                    }
                }
            }
        }

        // 3. Fallback: general random owned tiles (15% target weight)
        for (let r = 0; r < context.BOARD_ROWS; r++) {
            for (let c = 0; c < context.BOARD_COLS; c++) {
                const tile = board[r][c];
                if (tile && tile.ownerId === aiId) {
                    candidates.push({ row: r, col: c, type: 'owned' });
                }
            }
        }

        // Select a point based on weights
        if (candidates.length > 0) {
            const roll = Math.random();
            let targetType = 'owned';
            if (roll < 0.50 && candidates.some(c => c.type === 'army')) {
                targetType = 'army';
            } else if (roll < 0.85 && candidates.some(c => c.type === 'border')) {
                targetType = 'border';
            }
            
            let filtered = candidates.filter(c => c.type === targetType);
            if (filtered.length === 0) filtered = candidates;

            const selected = filtered[Math.floor(Math.random() * filtered.length)];
            this.focalPoint = { row: selected.row, col: selected.col };
            
            const typeLabel = selected.type === 'army' ? 'active troops' : (selected.type === 'border' ? 'contested borders' : 'territory overview');
            this.logThought(`Shifted focus to (${selected.row}, ${selected.col}) to monitor ${typeLabel}.`);
        }
        
        this.focalShiftTicks = cooldown;
    }

    evaluateOffensive(gameState, aiId, context, game) {
        const board = gameState.board;
        const visibilityGrid = (game.visibility && game.visibility[aiId]) ? game.visibility[aiId][this.timelineId] : null;
        const isFogEnabled = game.settings && game.settings.fogOfWar && process.env.NODE_ENV !== 'test';

        let visibleEnemyGeneral = null;
        for (let r = 0; r < context.BOARD_ROWS; r++) {
            for (let c = 0; c < context.BOARD_COLS; c++) {
                const isTileVisible = !isFogEnabled || (visibilityGrid && visibilityGrid[r][c]);
                if (isTileVisible) {
                    const tile = board[r][c];
                    if (tile && tile.type === context.TILE_TYPE.GENERAL && tile.ownerId !== 0 && tile.ownerId !== aiId) {
                        visibleEnemyGeneral = { row: r, col: c, tile: tile };
                        break;
                    }
                }
            }
            if (visibleEnemyGeneral) break;
        }

        let myTotalArmy = 0;
        let enemyTotalArmy = 0;
        for (let r = 0; r < context.BOARD_ROWS; r++) {
            for (let c = 0; c < context.BOARD_COLS; c++) {
                const tile = board[r][c];
                if (tile) {
                    if (tile.ownerId === aiId) {
                        myTotalArmy += tile.army;
                    } else if (tile.ownerId !== 0) {
                        enemyTotalArmy += tile.army;
                    }
                }
            }
        }
        if (gameState.moves) {
            gameState.moves.forEach(m => {
                if (m.ownerId === aiId) myTotalArmy += m.army;
                else if (m.ownerId !== 0) enemyTotalArmy += m.army;
            });
        }
        
        // Fallback to playerStats if no visible enemies
        if (enemyTotalArmy === 0 && game && game.playerStats && game.playerStats[this.timelineId]) {
            for (const pId in game.playerStats[this.timelineId]) {
                if (parseInt(pId) !== 0 && parseInt(pId) !== aiId) {
                    enemyTotalArmy += game.playerStats[this.timelineId][pId].army || 0;
                }
            }
        }

        const aiSettings = (game && game.settings && game.settings.ai) ? game.settings.ai : {};
        const alphaStrikeRatio = aiSettings.alphaStrikeRatio !== undefined ? aiSettings.alphaStrikeRatio : 1.25;
        const alphaStrikeThreshold = aiSettings.alphaStrikeThreshold !== undefined ? aiSettings.alphaStrikeThreshold : 150;
        const attentionRadius = aiSettings.attentionRadius !== undefined ? aiSettings.attentionRadius : 6;
        const attentionShiftCooldown = aiSettings.attentionShiftCooldown !== undefined ? aiSettings.attentionShiftCooldown : 15;

        const isAlphaStrikeEligible = visibleEnemyGeneral && myTotalArmy >= alphaStrikeThreshold && myTotalArmy > alphaStrikeRatio * enemyTotalArmy;

        if (isAlphaStrikeEligible) {
            let largestArmyTile = null;
            let maxArmy = 0;
            for (let r = 0; r < context.BOARD_ROWS; r++) {
                for (let c = 0; c < context.BOARD_COLS; c++) {
                    const tile = board[r][c];
                    if (tile && tile.ownerId === aiId && tile.army > maxArmy) {
                        maxArmy = tile.army;
                        largestArmyTile = { row: r, col: c };
                    }
                }
            }
            
            if (largestArmyTile) {
                const alphaPath = findPath(largestArmyTile, (curr) => curr.row === visibleEnemyGeneral.row && curr.col === visibleEnemyGeneral.col, board, context.BOARD_ROWS, context.BOARD_COLS, context.TILE_TYPE);
                if (alphaPath && alphaPath.length > 1) {
                    // Lock active focus point onto the coordinated alpha strike march
                    const nextStep = alphaPath[1];
                    this.focalPoint = { row: nextStep.row, col: nextStep.col };
                    this.focalShiftTicks = attentionShiftCooldown;
                    
                    this.logThought(`[Alpha Strike] Preplanned coordinated march initiated from (${largestArmyTile.row},${largestArmyTile.col}) to capture enemy General at (${visibleEnemyGeneral.row},${visibleEnemyGeneral.col})!`);
                    
                    return {
                        action: { type: 'MOVE', path: alphaPath, isSplit: false },
                        utility: 0.98
                    };
                }
            }
        }

        // Find all player-owned tiles or neutral cities (respecting Fog of War)
        const isTarget = (tileCoords) => {
            const isTileVisible = !isFogEnabled || (visibilityGrid && visibilityGrid[tileCoords.row][tileCoords.col]);
            if (!isTileVisible) return false;
            const tile = board[tileCoords.row][tileCoords.col];
            return tile && ((tile.ownerId !== 0 && tile.ownerId !== aiId) || (tile.ownerId === 0 && tile.type === context.TILE_TYPE.CITY));
        };

        let bestPath = null;
        let bestUtility = 0;

        // Search from AI tiles with army >= 10 (or General tile) for offense aggregation
        for (let r = 0; r < context.BOARD_ROWS; r++) {
            for (let c = 0; c < context.BOARD_COLS; c++) {
                if (!this.isWithinAttentionRadius(r, c, attentionRadius)) continue;
                const tile = board[r][c];
                if (tile && tile.ownerId === aiId && (tile.army >= 10 || tile.type === context.TILE_TYPE.GENERAL)) {
                    const start = { row: r, col: c };
                    const path = findPath(start, isTarget, board, context.BOARD_ROWS, context.BOARD_COLS, context.TILE_TYPE);
                    if (path && path.length > 1) {
                        const targetTile = board[path[path.length - 1].row][path[path.length - 1].col];
                        let baseUtil = 1.0 / path.length;
                        if (targetTile.type === context.TILE_TYPE.GENERAL) baseUtil *= 2.0;
                        else if (targetTile.type === context.TILE_TYPE.CITY) baseUtil *= 1.5;

                        if (baseUtil > bestUtility) {
                            bestUtility = baseUtil;
                            bestPath = path;
                        }
                    }
                }
            }
        }

        if (bestPath) {
            return {
                action: { type: 'MOVE', path: bestPath, isSplit: false },
                utility: Math.min(bestUtility, 1.0)
            };
        }
        return null;
    }

    evaluateDefensive(gameState, aiId, context, timeline) {
        const board = gameState.board;
        const generalInfo = context.findGeneral(aiId, gameState);
        
        if (!generalInfo) {
            // General is lost! Request Cooperative Agent to ask for a rollback if affordable and not cooling down.
            if (this.rollbackCooldownTicks > 0) return null;
            if (timeline && timeline.keyframes && timeline.keyframes.length > 1) {
                const targetStep = timeline.anchorStep;
                if (isRollbackAffordable(aiId, timeline, targetStep, context)) {
                    return {
                        type: 'REQUEST_ROLLBACK',
                        targetStep: targetStep,
                        utility: 0.99
                    };
                }
            }
            return null;
        }

        const genRow = generalInfo.row;
        const genCol = generalInfo.col;

        // Check if enemy is adjacent to general
        const neighbors = [
            { row: genRow - 1, col: genCol },
            { row: genRow + 1, col: genCol },
            { row: genRow, col: genCol - 1 },
            { row: genRow, col: genCol + 1 }
        ];

        let threatened = false;
        for (const n of neighbors) {
            if (n.row >= 0 && n.row < context.BOARD_ROWS && n.col >= 0 && n.col < context.BOARD_COLS) {
                const tile = board[n.row][n.col];
                if (tile && tile.ownerId !== 0 && tile.ownerId !== aiId && tile.army > 1) {
                    threatened = true;
                    break;
                }
            }
        }

        if (threatened) {
            // High utility threat! Reinforce General from adjacent high army tile
            let bestReinforceTile = null;
            let maxArmy = 1;
            for (const n of neighbors) {
                if (n.row >= 0 && n.row < context.BOARD_ROWS && n.col >= 0 && n.col < context.BOARD_COLS) {
                    const tile = board[n.row][n.col];
                    if (tile && tile.ownerId === aiId && tile.army > maxArmy) {
                        maxArmy = tile.army;
                        bestReinforceTile = n;
                    }
                }
            }

            if (bestReinforceTile) {
                return {
                    action: {
                        type: 'MOVE',
                        path: [bestReinforceTile, { row: genRow, col: genCol }],
                        isSplit: false
                    },
                    utility: 0.95
                };
            }
        }
        return null;
    }

    evaluateScouting(gameState, aiId, game, context) {
        // If fog of war is off or settings are missing, scouting has 0 utility
        if (!game.settings || !game.settings.fogOfWar) return null;

        const board = gameState.board;
        const visibilityGrid = (game.visibility && game.visibility[aiId]) ? game.visibility[aiId][this.timelineId] : null;
        if (!visibilityGrid) return null;
        const isFogEnabled = game.settings.fogOfWar && process.env.NODE_ENV !== 'test';

        const aiSettings = (game.settings && game.settings.ai) ? game.settings.ai : {};
        const attentionRadius = aiSettings.attentionRadius !== undefined ? aiSettings.attentionRadius : 6;

        let visibleEnemyGeneral = null;
        for (let r = 0; r < context.BOARD_ROWS; r++) {
            for (let c = 0; c < context.BOARD_COLS; c++) {
                const isTileVisible = !isFogEnabled || (visibilityGrid && visibilityGrid[r][c]);
                if (isTileVisible) {
                    const tile = board[r][c];
                    if (tile && tile.type === context.TILE_TYPE.GENERAL && tile.ownerId !== 0 && tile.ownerId !== aiId) {
                        visibleEnemyGeneral = { row: r, col: c, tile: tile };
                        break;
                    }
                }
            }
            if (visibleEnemyGeneral) break;
        }

        let suspectedLocation = null;
        if (!visibleEnemyGeneral) {
            // Find suspected enemy general coordinates (respecting Fog of War)
            let enemySumRow = 0, enemySumCol = 0, enemyCount = 0;
            for (let r = 0; r < context.BOARD_ROWS; r++) {
                for (let c = 0; c < context.BOARD_COLS; c++) {
                    const isTileVisible = !isFogEnabled || (visibilityGrid && visibilityGrid[r][c]);
                    if (isTileVisible) {
                        const tile = board[r][c];
                        if (tile && tile.ownerId !== 0 && tile.ownerId !== aiId) {
                            enemySumRow += r;
                            enemySumCol += c;
                            enemyCount++;
                        }
                    }
                }
            }
            if (enemyCount > 0) {
                suspectedLocation = { row: Math.round(enemySumRow / enemyCount), col: Math.round(enemySumCol / enemyCount) };
            } else {
                const myGeneral = context.findGeneral(aiId, gameState);
                if (myGeneral) {
                    suspectedLocation = {
                        row: myGeneral.row < context.BOARD_ROWS / 2 ? context.BOARD_ROWS - 2 : 1,
                        col: myGeneral.col < context.BOARD_COLS / 2 ? context.BOARD_COLS - 2 : 1
                    };
                }
            }
        }

        // Find AI tiles adjacent to unrevealed tiles
        let bestStart = null;
        let bestTarget = null;
        let maxArmy = 2;
        let bestDistance = Infinity;

        for (let r = 0; r < context.BOARD_ROWS; r++) {
            for (let c = 0; c < context.BOARD_COLS; c++) {
                if (!this.isWithinAttentionRadius(r, c, attentionRadius)) continue;
                const tile = board[r][c];
                if (tile && tile.ownerId === aiId && tile.army > maxArmy) {
                    // Check if adjacent is unrevealed
                    const neighbors = [
                        { row: r - 1, col: c },
                        { row: r + 1, col: c },
                        { row: r, col: c - 1 },
                        { row: r, col: c + 1 }
                    ];
                    for (const n of neighbors) {
                        if (n.row >= 0 && n.row < context.BOARD_ROWS && n.col >= 0 && n.col < context.BOARD_COLS) {
                            if (!visibilityGrid[n.row][n.col]) {
                                const neighborTile = board[n.row][n.col];
                                if (neighborTile && neighborTile.type !== context.TILE_TYPE.MOUNTAIN) {
                                    let dist = 1000;
                                    if (suspectedLocation) {
                                        dist = Math.abs(n.row - suspectedLocation.row) + Math.abs(n.col - suspectedLocation.col);
                                    }
                                    if (dist < bestDistance || (dist === bestDistance && tile.army > maxArmy)) {
                                        bestDistance = dist;
                                        maxArmy = tile.army;
                                        bestStart = { row: r, col: c };
                                        bestTarget = n;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if (bestStart && bestTarget) {
            const inSeekMode = !visibleEnemyGeneral;
            const utility = inSeekMode ? 0.70 : 0.45;
            
            if (inSeekMode && suspectedLocation) {
                this.logThought(`[Seek General] Scouting towards suspected coordinates (${suspectedLocation.row}, ${suspectedLocation.col}) to find enemy General!`);
            }
            
            return {
                action: {
                    type: 'MOVE',
                    path: [bestStart, bestTarget],
                    isSplit: true
                },
                utility: utility
            };
        }
        return null;
    }

    evaluateCooperative(gameState, aiId, game, context, rollbackRequest) {
        if (rollbackRequest) {
            return {
                type: 'ROLLBACK',
                targetStep: rollbackRequest.targetStep,
                utility: rollbackRequest.utility
            };
        }

        const generalInfo = context.findGeneral(aiId, gameState);
        if (!generalInfo) return null;

        const board = gameState.board;
        const visibilityGrid = (game.visibility && game.visibility[aiId]) ? game.visibility[aiId][this.timelineId] : null;
        const isFogEnabled = game.settings && game.settings.fogOfWar && process.env.NODE_ENV !== 'test';
        const aiSettings = (game.settings && game.settings.ai) ? game.settings.ai : {};
        const generalThreatThreshold = aiSettings.generalThreatThreshold !== undefined ? aiSettings.generalThreatThreshold : 300;

        // Calculate total enemy army visibility/stats dynamically to scale threat threshold (respecting Fog of War)
        let enemyTotalArmy = 0;
        for (let r = 0; r < context.BOARD_ROWS; r++) {
            for (let c = 0; c < context.BOARD_COLS; c++) {
                const isTileVisible = !isFogEnabled || (visibilityGrid && visibilityGrid[r][c]);
                if (isTileVisible) {
                    const tile = board[r][c];
                    if (tile && tile.ownerId !== 0 && tile.ownerId !== aiId) {
                        enemyTotalArmy += tile.army;
                    }
                }
            }
        }
        if (gameState.moves) {
            gameState.moves.forEach(m => {
                if (m.ownerId !== 0 && m.ownerId !== aiId) {
                    enemyTotalArmy += m.army;
                }
            });
        }
        if (enemyTotalArmy === 0 && game && game.playerStats && game.playerStats[this.timelineId]) {
            for (const pId in game.playerStats[this.timelineId]) {
                if (parseInt(pId) !== 0 && parseInt(pId) !== aiId) {
                    enemyTotalArmy += game.playerStats[this.timelineId][pId].army || 0;
                }
            }
        }

        const effectiveThreshold = Math.min(generalThreatThreshold, Math.max(100, enemyTotalArmy * 1.5));
        const genRow = generalInfo.row;
        const genCol = generalInfo.col;

        const hasActiveGather = gameState.moves && gameState.moves.some(m =>
            m.ownerId === aiId &&
            m.path[m.path.length - 1].row === genRow &&
            m.path[m.path.length - 1].col === genCol
        );

        // --- NEW: Gather units if General reserves are below the scaled threat threshold ---
        if (generalInfo.tile.army < effectiveThreshold) {
            if (hasActiveGather) {
                return null; // A gather move is already in progress, avoid spamming or other requests
            }

            let bestSource = null;
            let maxArmy = 19; // Enforce leaves-behind reserves: only gather from tiles with >= 20 army
            
            for (let r = 0; r < context.BOARD_ROWS; r++) {
                for (let c = 0; c < context.BOARD_COLS; c++) {
                    const tile = board[r][c];
                    if (tile && tile.ownerId === aiId && tile.army > maxArmy && (r !== genRow || c !== genCol)) {
                        // Avoid gathering from tiles under immediate threat
                        const neighbors = [
                            { row: r - 1, col: c },
                            { row: r + 1, col: c },
                            { row: r, col: c - 1 },
                            { row: r, col: c + 1 }
                        ];
                        let isThreatened = false;
                        for (const n of neighbors) {
                            if (n.row >= 0 && n.row < context.BOARD_ROWS && n.col >= 0 && n.col < context.BOARD_COLS) {
                                const nTile = board[n.row][n.col];
                                if (nTile && nTile.ownerId !== 0 && nTile.ownerId !== aiId && nTile.army > 1) {
                                    isThreatened = true;
                                    break;
                                }
                            }
                        }
                        if (!isThreatened && tile.army > maxArmy) {
                            maxArmy = tile.army;
                            bestSource = { row: r, col: c };
                        }
                    }
                }
            }

            // Fallback: if no unthreatened tile has >=20 army, search again allowing threatened tiles (desperate general)
            if (!bestSource && generalInfo.tile.army < effectiveThreshold * 0.5) {
                maxArmy = 19;
                for (let r = 0; r < context.BOARD_ROWS; r++) {
                    for (let c = 0; c < context.BOARD_COLS; c++) {
                        const tile = board[r][c];
                        if (tile && tile.ownerId === aiId && tile.army > maxArmy && (r !== genRow || c !== genCol)) {
                            maxArmy = tile.army;
                            bestSource = { row: r, col: c };
                        }
                    }
                }
            }

            if (bestSource) {
                const path = findPath(bestSource, (curr) => curr.row === genRow && curr.col === genCol, board, context.BOARD_ROWS, context.BOARD_COLS, context.TILE_TYPE);
                if (path && path.length > 1) {
                    const utility = Math.max(0.1, Math.min(0.85, (effectiveThreshold - generalInfo.tile.army) / effectiveThreshold));
                    return {
                        type: 'GATHER',
                        action: { type: 'MOVE', path: path, isSplit: true }, // Split keeps 50% defense on the base
                        utility: utility
                    };
                }
            }
            return null; // Don't execute other cooperative requests if General is under threat and gather fails
        }

        // If only 1 timeline exists, split has high utility
        const numTimelines = Object.keys(game.multiverse).length;
        if (numTimelines === 1) {
            return {
                type: 'SPLIT',
                utility: 0.75
            };
        }

        // If player is winning/overclocking another timeline, freeze has utility
        let enemyOverclocked = false;
        for (const tId in game.multiverse) {
            const t = game.multiverse[tId];
            if (t.speedMultiplier > 1.0) {
                enemyOverclocked = true;
                break;
            }
        }

        if (enemyOverclocked) {
            return {
                type: 'FREEZE',
                duration: 10,
                utility: 0.65
            };
        }

        return null;
    }
    evaluateTerritory(gameState, aiId, context, game) {
        const board = gameState.board;
        let bestPath = null;
        let bestUtility = 0;
        let isReclaim = false;

        const aiSettings = (game && game.settings && game.settings.ai) ? game.settings.ai : {};
        const attentionRadius = aiSettings.attentionRadius !== undefined ? aiSettings.attentionRadius : 6;

        for (let r = 0; r < context.BOARD_ROWS; r++) {
            for (let c = 0; c < context.BOARD_COLS; c++) {
                if (!this.isWithinAttentionRadius(r, c, attentionRadius)) continue;
                const tile = board[r][c];
                if (tile && tile.ownerId === aiId && tile.army > 1) {
                    const neighbors = [
                        { row: r - 1, col: c },
                        { row: r + 1, col: c },
                        { row: r, col: c - 1 },
                        { row: r, col: c + 1 }
                    ];

                    for (const n of neighbors) {
                        if (n.row >= 0 && n.row < context.BOARD_ROWS && n.col >= 0 && n.col < context.BOARD_COLS) {
                            const neighborTile = board[n.row][n.col];
                            if (neighborTile && neighborTile.type !== context.TILE_TYPE.MOUNTAIN) {
                                // Expansion: empty neutral tile
                                if (neighborTile.ownerId === 0 && neighborTile.type === context.TILE_TYPE.EMPTY) {
                                    const utility = 0.5;
                                    if (utility > bestUtility) {
                                        bestUtility = utility;
                                        bestPath = [{ row: r, col: c }, n];
                                        isReclaim = false;
                                    }
                                }
                                // Reclaim: adjacent enemy-owned tile
                                else if (neighborTile.ownerId !== 0 && neighborTile.ownerId !== aiId) {
                                    const utility = 0.75;
                                    if (utility > bestUtility) {
                                        bestUtility = utility;
                                        bestPath = [{ row: r, col: c }, n];
                                        isReclaim = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if (bestPath) {
            return {
                action: { type: 'MOVE', path: bestPath, isSplit: false },
                utility: bestUtility,
                isReclaim
            };
        }
        return null;
    }
}

class ManagementAgent {
    constructor(aiPlayer) {
        this.aiPlayer = aiPlayer;
        this.requests = [];
    }

    addRequest(timelineId, request) {
        this.requests.push({ timelineId, request });
    }

    runTick(game, context) {
        const aiId = this.aiPlayer.id;

        // 1. Process 5D requests
        this.requests.sort((a, b) => b.request.utility - a.request.utility);

        for (const { timelineId, request } of this.requests) {
            const timeline = game.multiverse[timelineId];
            if (!timeline) continue;

            const generalInfo = context.findGeneral(aiId, timeline.currentState);
            if (!generalInfo && request.type !== 'ROLLBACK') continue;

            const timelineName = timelineId.split('-')[1] || timelineId;

            if (request.type === 'SPLIT') {
                const numTimelines = Object.keys(game.multiverse).length;
                const cost = Math.floor(250 * Math.pow(1.25, numTimelines - 1));
                if (generalInfo && generalInfo.tile.army > cost + 10) {
                    context.splitTimeline(aiId, timelineId, game);
                    this.aiPlayer.logThought(`[Global] Management Agent approved SPLIT on timeline-${timelineName} (Cost: ${cost} army)`);
                    break; 
                }
            } else if (request.type === 'FREEZE') {
                const cost = Math.floor(15 * Math.pow(1.07, request.duration / 5));
                if (generalInfo && generalInfo.tile.army > cost + 10) {
                    context.freezeTimeline(aiId, timelineId, game, request.duration, cost);
                    this.aiPlayer.logThought(`[Global] Management Agent approved FREEZE on timeline-${timelineName} for ${request.duration} steps (Cost: ${cost} army)`);
                    break;
                }
            } else if (request.type === 'ROLLBACK') {
                context.rollbackTimeline(aiId, timelineId, request.targetStep, game);
                this.aiPlayer.logThought(`[Global] Management Agent approved and executed ROLLBACK on timeline-${timelineName} to step ${request.targetStep}`);
                break;
            }
        }

        // Clear requests
        this.requests = [];
    }
}

module.exports = {
    AIParticipant,
    findPath
};
