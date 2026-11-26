// tests/ai.test.js

const { AIParticipant, findPath } = require('../ai_agent');

describe('Dominion Multi-Agent AI Suite', () => {
    let TILE_TYPE, BOARD_ROWS, BOARD_COLS;

    beforeAll(() => {
        TILE_TYPE = { EMPTY: 0, MOUNTAIN: 1, CITY: 2, GENERAL: 3, FOREST: 4, ERASED: 5 };
        BOARD_ROWS = 6;
        BOARD_COLS = 6;
    });

    describe('1. BFS Pathfinding Mechanics', () => {
        test('findPath finds the shortest contiguous path avoiding mountains', () => {
            const board = Array(BOARD_ROWS).fill(null).map(() =>
                Array(BOARD_COLS).fill(null).map(() => ({ type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 }))
            );

            // Place a mountain wall at col 1
            board[0][1].type = TILE_TYPE.MOUNTAIN;
            board[1][1].type = TILE_TYPE.MOUNTAIN;
            board[2][1].type = TILE_TYPE.MOUNTAIN;
            // board[3][1] is empty, leaving a pass
            board[4][1].type = TILE_TYPE.MOUNTAIN;
            board[5][1].type = TILE_TYPE.MOUNTAIN;

            const start = { row: 0, col: 0 };
            const isTarget = (c) => c.row === 0 && c.col === 2;

            const path = findPath(start, isTarget, board, BOARD_ROWS, BOARD_COLS, TILE_TYPE);
            expect(path).toBeDefined();
            expect(path).not.toBeNull();

            // The path must route down to the pass at row 3 and back up
            expect(path[1]).toEqual({ row: 1, col: 0 });
            expect(path[2]).toEqual({ row: 2, col: 0 });
            expect(path[3]).toEqual({ row: 3, col: 0 }); // pass row
            expect(path[4]).toEqual({ row: 3, col: 1 }); // through the pass
            expect(path[5]).toEqual({ row: 3, col: 2 });
            expect(path[6]).toEqual({ row: 2, col: 2 });
            expect(path[7]).toEqual({ row: 1, col: 2 });
            expect(path[8]).toEqual({ row: 0, col: 2 }); // target
        });

        test('findPath returns null if the target is completely blocked off', () => {
            const board = Array(BOARD_ROWS).fill(null).map(() =>
                Array(BOARD_COLS).fill(null).map(() => ({ type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 }))
            );

            // Block col 1 completely
            for (let r = 0; r < BOARD_ROWS; r++) {
                board[r][1].type = TILE_TYPE.MOUNTAIN;
            }

            const start = { row: 0, col: 0 };
            const isTarget = (c) => c.row === 0 && c.col === 2;

            const path = findPath(start, isTarget, board, BOARD_ROWS, BOARD_COLS, TILE_TYPE);
            expect(path).toBeNull();
        });
    });

    describe('2. AI Token Economy & Difficulty Scaling', () => {
        test('income adds tokens and is capped to prevent hoarding', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'MEDIUM');
            const game = {
                multiverse: {
                    'timeline-alpha': {
                        currentState: {
                            board: Array(BOARD_ROWS).fill(null).map(() =>
                                Array(BOARD_COLS).fill(null).map(() => ({ type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 }))
                            )
                        }
                    }
                }
            };
            const context = { TILE_TYPE, BOARD_ROWS, BOARD_COLS, findGeneral: () => null };

            // Take 10 turns to let token income accumulate towards the cap
            for (let i = 0; i < 15; i++) {
                ai.takeTurn(game, context);
            }

            const agentSet = ai.boardAgents.get('timeline-alpha');
            expect(agentSet).toBeDefined();
            // Tokens should be capped at 50
            expect(agentSet.tokens.offensive).toBeLessThanOrEqual(50);
            expect(agentSet.tokens.defensive).toBeLessThanOrEqual(50);
        });

        test('EASY difficulty reallocates more fallibility tokens than HARD difficulty', () => {
            const aiEasy = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'EASY');
            const aiHard = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');

            const game = {
                multiverse: {
                    'timeline-alpha': {
                        currentState: {
                            board: Array(BOARD_ROWS).fill(null).map(() =>
                                Array(BOARD_COLS).fill(null).map(() => ({ type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 }))
                            )
                        }
                    }
                }
            };
            const context = { TILE_TYPE, BOARD_ROWS, BOARD_COLS, findGeneral: () => null };

            aiEasy.takeTurn(game, context);
            aiHard.takeTurn(game, context);

            const easySet = aiEasy.boardAgents.get('timeline-alpha');
            const hardSet = aiHard.boardAgents.get('timeline-alpha');

            // Easy reallocates 50% of its fallibility tokens (15 -> 15 - 7 = 8)
            expect(easySet.tokens.fallibility).toBe(8);
            // Hard reallocates 0% of its fallibility tokens (15 -> 15)
            expect(hardSet.tokens.fallibility).toBe(15);
        });
    });

    describe('3. Local Agent Action Bidding & Execution', () => {
        let game, context, processMoveCalled, splitTimelineCalled, rollbackTimelineCalled;

        beforeEach(() => {
            processMoveCalled = false;
            splitTimelineCalled = false;
            rollbackTimelineCalled = false;

            const board = Array(BOARD_ROWS).fill(null).map(() =>
                Array(BOARD_COLS).fill(null).map(() => ({ type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 }))
            );

            game = {
                multiverse: {
                    'timeline-alpha': {
                        currentState: { board, gameStep: 0, moves: [] },
                        keyframes: [{ step: 0, gameState: { board } }],
                        anchorStep: 0
                    }
                },
                settings: { fogOfWar: false }
            };

            context = {
                TILE_TYPE,
                BOARD_ROWS,
                BOARD_COLS,
                findGeneral: (playerId, state) => {
                    for (let r = 0; r < BOARD_ROWS; r++) {
                        for (let c = 0; c < BOARD_COLS; c++) {
                            if (state.board[r][c].type === TILE_TYPE.GENERAL && state.board[r][c].ownerId === playerId) {
                                return { row: r, col: c, tile: state.board[r][c] };
                            }
                        }
                    }
                    return null;
                },
                processMove: () => { processMoveCalled = true; },
                splitTimeline: () => { splitTimelineCalled = true; },
                rollbackTimeline: () => { rollbackTimelineCalled = true; }
            };
        });

        test('Offensive Agent successfully bids and triggers moves to capture enemy target', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');

            // Set up AI General at [0][0] with troops, and a Player tile adjacent at [0][1]
            game.multiverse['timeline-alpha'].currentState.board[0][0] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 50 };
            game.multiverse['timeline-alpha'].currentState.board[0][1] = { type: TILE_TYPE.EMPTY, ownerId: 1, army: 5 };

            ai.takeTurn(game, context);

            // Offensive Agent should outbid and call processMove!
            expect(processMoveCalled).toBe(true);
        });

        test('Defensive Agent outbids Offensive Agent when AI General is under immediate threat', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');

            // Set up AI General at [0][0] with 50 troops, an adjacent high army AI tile at [1][0] with 100 troops,
            // and an adjacent enemy player tile at [0][1] with 200 troops (immediate high threat!).
            game.multiverse['timeline-alpha'].currentState.board[0][0] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 50 };
            game.multiverse['timeline-alpha'].currentState.board[1][0] = { type: TILE_TYPE.EMPTY, ownerId: 2, army: 100 };
            game.multiverse['timeline-alpha'].currentState.board[0][1] = { type: TILE_TYPE.EMPTY, ownerId: 1, army: 200 };

            ai.takeTurn(game, context);

            // Defensive Agent should trigger processMove to reinforce General from [1][0]
            expect(processMoveCalled).toBe(true);
        });

        test('Cooperative Agent requests SPLIT and Management Agent executes it when General has excess army', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');

            // AI General has 500 troops (excess safe reserve > 300)
            game.multiverse['timeline-alpha'].currentState.board[0][0] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 500 };

            ai.takeTurn(game, context);

            // Management Agent arbitrates and triggers splitTimeline
            expect(splitTimelineCalled).toBe(true);
        });

        test('Management Agent automatically rolls back a timeline if the AI General is lost', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');

            // Set up keyframe list so a rollback is possible, but do not place the AI General (meaning General is lost)
            game.multiverse['timeline-alpha'].keyframes.push({ step: 10, gameState: game.multiverse['timeline-alpha'].currentState });

            ai.takeTurn(game, context);

            // Management Agent triggers rollbackTimeline to save the General
            expect(rollbackTimelineCalled).toBe(true);
        });

        test('Offensive Agent does not bid from small non-General tiles under aggregation threshold (army < 10)', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');

            // Set up AI non-General at [0][0] with 5 troops (under 10 threshold), a neutral City adjacent at [0][1], and blocker mountain at [1][0]
            game.multiverse['timeline-alpha'].currentState.board[0][0] = { type: TILE_TYPE.EMPTY, ownerId: 2, army: 5 };
            game.multiverse['timeline-alpha'].currentState.board[0][1] = { type: TILE_TYPE.CITY, ownerId: 0, army: 1 };
            game.multiverse['timeline-alpha'].currentState.board[1][0] = { type: TILE_TYPE.MOUNTAIN, ownerId: 0, army: 0 };

            ai.takeTurn(game, context);

            // Offensive Agent should NOT call processMove because the tile is under the aggregation threshold!
            expect(processMoveCalled).toBe(false);
        });

        test('Territory Agent successfully expands into adjacent empty neutral tiles', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');

            // Set up AI tile at [0][0] with 5 troops, and empty neutral tile at [0][1]
            game.multiverse['timeline-alpha'].currentState.board[0][0] = { type: TILE_TYPE.EMPTY, ownerId: 2, army: 5 };
            game.multiverse['timeline-alpha'].currentState.board[0][1] = { type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 };

            ai.takeTurn(game, context);

            // Territory Agent should trigger processMove to expand
            expect(processMoveCalled).toBe(true);
        });

        test('Fallibility pacing wait blocks non-defensive actions but allows defensive reinforcements', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');

            // Set up AI tile at [0][0] with 5 troops, and empty neutral tile at [0][1]
            game.multiverse['timeline-alpha'].currentState.board[0][0] = { type: TILE_TYPE.EMPTY, ownerId: 2, army: 5 };
            game.multiverse['timeline-alpha'].currentState.board[0][1] = { type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 };

            ai.takeTurn(game, context);
            const agentSet = ai.boardAgents.get('timeline-alpha');
            agentSet.planningWaitTicks = 5;

            // Run a tick - the expansion move should be blocked!
            processMoveCalled = false;
            ai.takeTurn(game, context);
            expect(processMoveCalled).toBe(false);
            expect(agentSet.planningWaitTicks).toBe(4);

            // Now, simulate a threatened General adjacent to an enemy
            game.multiverse['timeline-alpha'].currentState.board[0][0] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 50 };
            game.multiverse['timeline-alpha'].currentState.board[1][0] = { type: TILE_TYPE.EMPTY, ownerId: 2, army: 100 };
            game.multiverse['timeline-alpha'].currentState.board[0][1] = { type: TILE_TYPE.EMPTY, ownerId: 1, army: 200 };

            // Run a tick - defensive reinforcement should STILL be triggered despite the planning wait!
            ai.takeTurn(game, context);
            expect(processMoveCalled).toBe(true);
        });

        test('AI obeys maxMovingArmies limit and skips offensive/observatory/territory move evaluations when limit is reached', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');

            // Set up AI tile at [0][0] and adjacent empty neutral tile at [0][1] for expansion
            game.multiverse['timeline-alpha'].currentState.board[0][0] = { type: TILE_TYPE.EMPTY, ownerId: 2, army: 5 };
            game.multiverse['timeline-alpha'].currentState.board[0][1] = { type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 };

            // Simulate active moves meeting the limit of 3
            game.settings = { maxMovingArmies: 3 };
            game.multiverse['timeline-alpha'].currentState.moves = [
                { ownerId: 2, path: [] },
                { ownerId: 2, path: [] },
                { ownerId: 2, path: [] }
            ];

            ai.takeTurn(game, context);

            // Territory Agent expansion should be blocked/skipped because limit is reached
            expect(processMoveCalled).toBe(false);
        });
    });

    describe('4. Server Multi-AI & Lobby Reset Mechanics', () => {
        let server;
        beforeAll(() => {
            server = require('../server');
        });

        test('AI Opponent constructor correctly registers difficulty and golden ratio color sequence', () => {
            const ai = new AIParticipant(3, 'AI Opponent (Easy)', '#00FF00', 'EASY');
            expect(ai.id).toBe(3);
            expect(ai.difficulty).toBe('EASY');
            expect(ai.name).toBe('AI Opponent (Easy)');
            expect(ai.color).toBe('#00FF00');
        });

        test('resetGameToLobby resets the game state while retaining human sockets and configurations', () => {
            const game = server.createNewGame();
            game.gameState = 'RUNNING';
            game.settings.fogOfWar = false;
            game.players['socket-1'] = { id: 1, name: 'Player 1', color: '#FFF', isReady: true };

            server.setGame(game);
            // Call resetGameToLobby directly
            const resetGame = server.getGame();
            expect(resetGame.gameState).toBe('RUNNING'); // starts running

            server.resetGameToLobby(resetGame);
            expect(resetGame.gameState).toBe('LOBBY');
            // Settings should be retained
            expect(resetGame.settings.fogOfWar).toBe(false);
        });
    });

    describe('5. Attention Span & Focal Point Mechanics', () => {
        let game, context;

        beforeEach(() => {
            const board = Array(BOARD_ROWS).fill(null).map(() =>
                Array(BOARD_COLS).fill(null).map(() => ({ type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 }))
            );
            game = {
                multiverse: {
                    'timeline-alpha': {
                        currentState: { board, gameStep: 0, moves: [] }
                    }
                },
                settings: {
                    ai: {
                        attentionRadius: 3,
                        attentionShiftCooldown: 5
                    }
                }
            };
            context = {
                TILE_TYPE,
                BOARD_ROWS,
                BOARD_COLS,
                findGeneral: (playerId, state) => {
                    for (let r = 0; r < BOARD_ROWS; r++) {
                        for (let c = 0; c < BOARD_COLS; c++) {
                            if (state.board[r][c].type === TILE_TYPE.GENERAL && state.board[r][c].ownerId === playerId) {
                                return { row: r, col: c, tile: state.board[r][c] };
                            }
                        }
                    }
                    return null;
                },
                processMove: () => {},
                splitTimeline: () => {},
                rollbackTimeline: () => {}
            };
        });

        test('focalPoint initializes locked to AI General on startup', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');
            game.multiverse['timeline-alpha'].currentState.board[2][2] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 10 };

            ai.takeTurn(game, context);

            const agentSet = ai.boardAgents.get('timeline-alpha');
            expect(agentSet.focalPoint).toEqual({ row: 2, col: 2 });
            expect(agentSet.focalShiftTicks).toBe(4);
        });

        test('isWithinAttentionRadius filters out tiles outside the Chebyshev distance', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');
            game.multiverse['timeline-alpha'].currentState.board[2][2] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 10 };

            ai.takeTurn(game, context);
            const agentSet = ai.boardAgents.get('timeline-alpha');

            // Chebyshev distance within 3
            expect(agentSet.isWithinAttentionRadius(2, 2, 3)).toBe(true);
            expect(agentSet.isWithinAttentionRadius(5, 5, 3)).toBe(true); // Chebyshev distance: Math.max(3, 3) = 3
            expect(agentSet.isWithinAttentionRadius(2, 5, 3)).toBe(true); // Chebyshev distance: Math.max(0, 3) = 3
            expect(agentSet.isWithinAttentionRadius(0, 0, 3)).toBe(true); // Chebyshev distance: Math.max(2, 2) = 2

            // Chebyshev distance outside 3
            expect(agentSet.isWithinAttentionRadius(2, 6, 3)).toBe(false); // dx=0, dy=4 -> 4 > 3
            expect(agentSet.isWithinAttentionRadius(6, 2, 3)).toBe(false); // dx=4, dy=0 -> 4 > 3
        });

        test('evaluateOffensive filters out starting locations outside the attention radius', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');
            // AI General at 1,1
            game.multiverse['timeline-alpha'].currentState.board[1][1] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 50 };
            
            // A high-army tile at 0,5 (which is outside radius 3 from 1,1 - Chebyshev dist: Max(1, 4) = 4)
            game.multiverse['timeline-alpha'].currentState.board[0][5] = { type: TILE_TYPE.EMPTY, ownerId: 2, army: 50 };
            // Adjacent enemy tile at 0,4
            game.multiverse['timeline-alpha'].currentState.board[0][4] = { type: TILE_TYPE.EMPTY, ownerId: 1, army: 5 };

            ai.takeTurn(game, context);
            const agentSet = ai.boardAgents.get('timeline-alpha');

            // Evaluate offensive directly
            const offensiveAction = agentSet.evaluateOffensive(game.multiverse['timeline-alpha'].currentState, 2, context, game);
            
            // Starting tile of offensive action should not be [0][5] even though it is very strong, because it is outside the attention radius!
            if (offensiveAction) {
                expect(offensiveAction.action.path[0]).not.toEqual({ row: 0, col: 5 });
            }
        });

        test('shiftAttentionPoint shifts to active army or border tile when cooldown timer ticks to 0', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');
            // General at 1,1
            game.multiverse['timeline-alpha'].currentState.board[1][1] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 10 };
            // Border AI tile at 4,4 adjacent to enemy
            game.multiverse['timeline-alpha'].currentState.board[4][4] = { type: TILE_TYPE.EMPTY, ownerId: 2, army: 10 };
            game.multiverse['timeline-alpha'].currentState.board[4][5] = { type: TILE_TYPE.EMPTY, ownerId: 1, army: 10 };

            ai.takeTurn(game, context);
            const agentSet = ai.boardAgents.get('timeline-alpha');

            expect(agentSet.focalPoint).toEqual({ row: 1, col: 1 });
            expect(agentSet.focalShiftTicks).toBe(4);

            // Tick down the shift ticks
            for (let i = 0; i < 4; i++) {
                agentSet.runTick(game, context);
            }

            // Focal point should shift since focalShiftTicks reaches 0
            expect(agentSet.focalShiftTicks).toBe(5);
            // It should have shifted either to the General (1,1) or the border tile (4,4)
            expect(agentSet.focalPoint).toBeDefined();
            expect(agentSet.focalPoint).not.toBeNull();
        });

        test('player conversion to AI is driven by AIParticipant turns successfully', () => {
            const player = { id: 1, name: 'Player 1', color: '#FFF', isReady: true, isAI: false };
            
            // Simulating retirement on the player object
            player.isAI = true;
            player.name = `AI (Retired ${player.name})`;
            player.aiInstance = new AIParticipant(player.id, player.name, player.color, 'MEDIUM');
            
            expect(player.isAI).toBe(true);
            expect(player.name).toBe('AI (Retired Player 1)');
            expect(player.aiInstance).toBeInstanceOf(AIParticipant);

            // Verify they can take turns successfully
            // General at 1,1
            game.multiverse['timeline-alpha'].currentState.board[1][1] = { type: TILE_TYPE.GENERAL, ownerId: 1, army: 10 };
            player.aiInstance.takeTurn(game, context);
            const agentSet = player.aiInstance.boardAgents.get('timeline-alpha');
            expect(agentSet).toBeDefined();
            expect(agentSet.focalPoint).toEqual({ row: 1, col: 1 });
        });
    });

    describe('6. Advanced Multi-Agent Tactics', () => {
        let game, context;

        beforeEach(() => {
            const board = Array(BOARD_ROWS).fill(null).map(() =>
                Array(BOARD_COLS).fill(null).map(() => ({ type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 }))
            );
            game = {
                multiverse: {
                    'timeline-alpha': {
                        currentState: { board, gameStep: 0, moves: [] }
                    }
                },
                settings: {
                    ai: {
                        attentionRadius: 6,
                        attentionShiftCooldown: 15,
                        alphaStrikeRatio: 1.25,
                        alphaStrikeThreshold: 150,
                        generalThreatThreshold: 300
                    },
                    fogOfWar: true
                },
                visibility: {
                    2: {
                        'timeline-alpha': Array(BOARD_ROWS).fill(null).map(() => Array(BOARD_COLS).fill(false))
                    }
                }
            };
            context = {
                TILE_TYPE,
                BOARD_ROWS,
                BOARD_COLS,
                findGeneral: (playerId, state) => {
                    for (let r = 0; r < BOARD_ROWS; r++) {
                        for (let c = 0; c < BOARD_COLS; c++) {
                            if (state.board[r][c].type === TILE_TYPE.GENERAL && state.board[r][c].ownerId === playerId) {
                                return { row: r, col: c, tile: state.board[r][c] };
                            }
                        }
                    }
                    return null;
                },
                processMove: () => {},
                splitTimeline: () => {},
                rollbackTimeline: () => {}
            };
        });

        test('Cooperative GATHER reinforcing works when General reserves are low', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');
            
            // Set up AI General with low troops (50 < 300 limit)
            game.multiverse['timeline-alpha'].currentState.board[1][1] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 50 };
            
            // Set up a large non-General AI tile at [4][4] with 100 troops
            game.multiverse['timeline-alpha'].currentState.board[4][4] = { type: TILE_TYPE.EMPTY, ownerId: 2, army: 100 };

            ai.takeTurn(game, context);
            const agentSet = ai.boardAgents.get('timeline-alpha');

            const coopRequest = agentSet.evaluateCooperative(game.multiverse['timeline-alpha'].currentState, 2, game, context);
            expect(coopRequest).toBeDefined();
            expect(coopRequest.type).toBe('GATHER');
            expect(coopRequest.action.type).toBe('MOVE');
            expect(coopRequest.action.path[0]).toEqual({ row: 4, col: 4 });
            expect(coopRequest.action.path[coopRequest.action.path.length - 1]).toEqual({ row: 1, col: 1 });
        });

        test('Aggressive Scouting directs moves towards estimated spawn corners when enemy is hidden', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');
            
            // AI General spawned at top-left [1][1]
            game.multiverse['timeline-alpha'].currentState.board[1][1] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 50 };
            
            // Unrevealed visibility scan (Fog of War)
            const vis = game.visibility[2]['timeline-alpha'];
            vis[1][1] = true;
            vis[1][2] = true;
            vis[2][1] = true;
            
            ai.takeTurn(game, context);
            const agentSet = ai.boardAgents.get('timeline-alpha');

            const scoutAction = agentSet.evaluateScouting(game.multiverse['timeline-alpha'].currentState, 2, game, context);
            expect(scoutAction).toBeDefined();
            expect(scoutAction.utility).toBe(0.70); // Elevated scouting utility in seek mode
        });

        test('Offensive Alpha Strike triggers coordinated march when numeric advantage is held', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');
            
            // AI General at [1][1] with 200 troops (decisive advantage > 1.25 * enemy, > 150 threshold)
            game.multiverse['timeline-alpha'].currentState.board[1][1] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 200 };
            
            // Enemy General at [4][4] with 50 troops (visible)
            game.multiverse['timeline-alpha'].currentState.board[4][4] = { type: TILE_TYPE.GENERAL, ownerId: 1, army: 50 };

            ai.takeTurn(game, context);
            const agentSet = ai.boardAgents.get('timeline-alpha');

            const offensiveAction = agentSet.evaluateOffensive(game.multiverse['timeline-alpha'].currentState, 2, context, game);
            expect(offensiveAction).toBeDefined();
            expect(offensiveAction.utility).toBe(0.98); // Coordinated march utility
            expect(offensiveAction.action.path[0]).toEqual({ row: 1, col: 1 });
            expect(offensiveAction.action.path[offensiveAction.action.path.length - 1]).toEqual({ row: 4, col: 4 });
        });

        test('Dynamic Gather Bounding, Split Moves, and reserves defense bounds', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');

            // Set up AI General with high troops (150 > 100 threshold), so gather should NOT trigger
            game.multiverse['timeline-alpha'].currentState.board[1][1] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 150 };
            game.multiverse['timeline-alpha'].currentState.board[4][4] = { type: TILE_TYPE.EMPTY, ownerId: 2, army: 100 };

            ai.takeTurn(game, context);
            const agentSet = ai.boardAgents.get('timeline-alpha');

            let coopRequest = agentSet.evaluateCooperative(game.multiverse['timeline-alpha'].currentState, 2, game, context);
            // Since reserves are healthy, it should return SPLIT instead of GATHER due to single timeline
            expect(coopRequest.type).toBe('SPLIT');

            // Tweak General to 50 (below 100 threat threshold)
            game.multiverse['timeline-alpha'].currentState.board[1][1].army = 50;

            coopRequest = agentSet.evaluateCooperative(game.multiverse['timeline-alpha'].currentState, 2, game, context);
            expect(coopRequest.type).toBe('GATHER');
            expect(coopRequest.action.isSplit).toBe(true); // Split gathers to leave reserves!
        });

        test('Active gather duplicate check block duplicate spamming', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');

            // General is low
            game.multiverse['timeline-alpha'].currentState.board[1][1] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 50 };
            game.multiverse['timeline-alpha'].currentState.board[4][4] = { type: TILE_TYPE.EMPTY, ownerId: 2, army: 100 };

            ai.takeTurn(game, context);
            const agentSet = ai.boardAgents.get('timeline-alpha');

            // Mock an active move currently pathing towards the General
            game.multiverse['timeline-alpha'].currentState.moves = [{
                ownerId: 2,
                army: 50,
                path: [{ row: 4, col: 4 }, { row: 1, col: 1 }],
                pathIndex: 0,
                progress: 0
            }];

            const coopRequest = agentSet.evaluateCooperative(game.multiverse['timeline-alpha'].currentState, 2, game, context);
            // Since a gather is already active, it should block duplicate spams by returning null
            expect(coopRequest).toBeNull();
        });

        test('Rollback request cooldown limits rollback spams', () => {
            const ai = new AIParticipant(2, 'AI Opponent', '#7B2CBF', 'HARD');
            
            // Set up AI General initially and timeline anchor step
            game.multiverse['timeline-alpha'].currentState.board[1][1] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 50 };
            game.multiverse['timeline-alpha'].anchorStep = 0;
            
            // Initialize extra keyframes to timeline-alpha to satisfy length > 1 constraint
            game.multiverse['timeline-alpha'].keyframes = [
                { step: 0, gameState: game.multiverse['timeline-alpha'].currentState },
                { step: 10, gameState: game.multiverse['timeline-alpha'].currentState }
            ];

            ai.takeTurn(game, context);
            const agentSet = ai.boardAgents.get('timeline-alpha');

            // Force dead general now
            game.multiverse['timeline-alpha'].currentState.board[1][1] = { type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 };
            
            // Initial lost general returns rollback
            let defensiveAction = agentSet.evaluateDefensive(game.multiverse['timeline-alpha'].currentState, 2, context, game.multiverse['timeline-alpha']);
            expect(defensiveAction).toBeDefined();
            expect(defensiveAction).not.toBeNull();
            expect(defensiveAction.type).toBe('REQUEST_ROLLBACK');

            // Set cooldown
            agentSet.rollbackCooldownTicks = 15;

            // Rollback request should now be suppressed under active cooldown
            defensiveAction = agentSet.evaluateDefensive(game.multiverse['timeline-alpha'].currentState, 2, context, game.multiverse['timeline-alpha']);
            expect(defensiveAction).toBeNull();
        });
    });
});
