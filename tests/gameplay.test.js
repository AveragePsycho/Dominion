// tests/gameplay.test.js
const {
    getGame,
    setGame,
    createNewGame,
    calculateMapDimensions,
    generateSpawnPoints,
    initializeGame,
    processMove,
    runSingleTickLogic,
    splitTimeline,
    findValidAdjacentTile,
    calculatePlayerStats,
    gameLoop,
    updateTimeline,
    freezeTimeline,
    overclockTimeline,
    rollbackTimeline,
    anchorTimeline,
    openPortal,
    findGeneral,
    handlePlayerDefeat,
    updatePlayerVisibility,
    getPrunedClientState,
    paradoxHandler,
    TILE_TYPE,
    getBoardCols,
    setBoardCols,
    getBoardRows,
    setBoardRows,
    GREEK_ALPHABET
} = require('../server');

describe('Dominion Gameplay Testing Suite', () => {
    let originalCols, originalRows;

    beforeAll(() => {
        originalCols = getBoardCols();
        originalRows = getBoardRows();
    });

    afterAll(() => {
        setBoardCols(originalCols);
        setBoardRows(originalRows);
    });

    beforeEach(() => {
        // Reset the board size to a manageable 6x6 for testing
        setBoardCols(6);
        setBoardRows(6);
        
        // Setup a fresh game structure
        const game = createNewGame();
        game.players = {
            'socket-p1': { id: 1, name: 'Player 1', color: 'hsl(120, 90%, 60%)', isReady: true },
            'socket-p2': { id: 2, name: 'Player 2', color: 'hsl(240, 90%, 60%)', isReady: true }
        };
        game.playerCount = 2;
        setGame(game);
    });

    describe('1. Game Setup & Initialization', () => {
        test('calculateMapDimensions calculates board size correctly based on player count', () => {
            const dims2 = calculateMapDimensions(2);
            expect(dims2.cols).toBeGreaterThan(0);
            expect(dims2.rows).toBeGreaterThan(0);

            const dims8 = calculateMapDimensions(8);
            expect(dims8.cols * dims8.rows).toBeGreaterThan(dims2.cols * dims2.rows);
        });

        test('generateSpawnPoints creates spaced points with player IDs assigned', () => {
            const boardDimensions = { cols: 30, rows: 30 };
            const spawnPoints = generateSpawnPoints(boardDimensions, 2);
            expect(spawnPoints).toHaveLength(2);
            expect(spawnPoints[0].playerId).toBe(1);
            expect(spawnPoints[1].playerId).toBe(2);
            
            // Check that spawn points don't occupy the exact same tile
            expect(spawnPoints[0].row === spawnPoints[1].row && spawnPoints[0].col === spawnPoints[1].col).toBe(false);
        });

        test('initializeGame constructs timelines, sets lobby status, and spawns cities and generals', () => {
            const game = getGame();
            initializeGame(game);

            expect(game.gameState).toBe('RUNNING');
            expect(game.multiverse).toHaveProperty('timeline-alpha');

            const timelineAlpha = game.multiverse['timeline-alpha'];
            expect(timelineAlpha.currentState.gameStep).toBe(0);
            expect(timelineAlpha.keyframes).toHaveLength(1);

            // Verify both player generals exist on the board
            const p1Gen = findGeneral(1, timelineAlpha.currentState);
            const p2Gen = findGeneral(2, timelineAlpha.currentState);
            expect(p1Gen).not.toBeNull();
            expect(p2Gen).not.toBeNull();
        });
    });

    describe('2. Core Movement & Redirection/Cancellation', () => {
        let game, timeline;

        beforeEach(() => {
            game = getGame();
            
            // Manually populate a custom, clean board for predictable movement testing
            const cols = 6;
            const rows = 6;
            setBoardCols(cols);
            setBoardRows(rows);

            const board = Array(rows).fill(null).map(() => 
                Array(cols).fill(null).map(() => ({ type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 }))
            );

            // Place Generals
            board[0][0] = { type: TILE_TYPE.GENERAL, ownerId: 1, army: 100 };
            board[5][5] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 100 };

            // Place Mountain at [0][2]
            board[0][2] = { type: TILE_TYPE.MOUNTAIN, ownerId: 0, army: 0 };

            const initialGameState = { board, gameStep: 0, moves: [] };
            game.boardDimensions = { cols, rows };
            game.multiverse['timeline-alpha'] = {
                id: 'timeline-alpha',
                currentState: initialGameState,
                keyframes: [{ step: 0, gameState: JSON.parse(JSON.stringify(initialGameState)) }],
                actions: [],
                isFrozen: false,
                freezeUntilStep: 0,
                overclockUntilStep: 0,
                speedMultiplier: 1.0,
                anchorStep: 0,
                parentId: null,
                splitStep: 0,
                isUnravelling: false,
                unravelCenter: null,
                unravelRadius: 0
            };
            game.gameState = 'RUNNING';
            timeline = game.multiverse['timeline-alpha'];
        });

        test('processMove allows valid contiguous movements and updates moves queue', () => {
            const action = {
                path: [
                    { row: 0, col: 0 },
                    { row: 0, col: 1 },
                    { row: 1, col: 1 }
                ],
                isSplit: false
            };

            processMove(1, action, 'timeline-alpha', game);

            expect(timeline.currentState.moves).toHaveLength(1);
            const move = timeline.currentState.moves[0];
            expect(move.ownerId).toBe(1);
            expect(move.army).toBe(99); // 100 starting - 1 left behind
            expect(timeline.currentState.board[0][0].army).toBe(1); // 1 left behind
        });

        test('processMove rejects illegal non-contiguous moves or movements through mountains', () => {
            // Attempt move through Mountain at [0][2]
            const actionThroughMountain = {
                path: [
                    { row: 0, col: 0 },
                    { row: 0, col: 1 },
                    { row: 0, col: 2 }
                ],
                isSplit: false
            };

            processMove(1, actionThroughMountain, 'timeline-alpha', game);
            expect(timeline.currentState.moves).toHaveLength(0);

            // Attempt diagonal non-contiguous jump
            const actionDiagonalJump = {
                path: [
                    { row: 0, col: 0 },
                    { row: 1, col: 1 }
                ],
                isSplit: false
            };

            processMove(1, actionDiagonalJump, 'timeline-alpha', game);
            expect(timeline.currentState.moves).toHaveLength(0);
        });

        test('processMove redirects active armies correctly and cancels the prior move, returning troops', () => {
            // Initiate first move
            const action1 = {
                path: [
                    { row: 0, col: 0 },
                    { row: 0, col: 1 },
                    { row: 1, col: 1 }
                ],
                isSplit: false
            };
            processMove(1, action1, 'timeline-alpha', game);
            expect(timeline.currentState.moves).toHaveLength(1);
            expect(timeline.currentState.board[0][0].army).toBe(1);

            // Advance time by 1 tick so army moves to [0][1]
            runSingleTickLogic(timeline.currentState, 'timeline-alpha', game);
            runSingleTickLogic(timeline.currentState, 'timeline-alpha', game); // 2 progress ticks = 1 move step (MOVE_TICKS = 2)

            const activeMove = timeline.currentState.moves[0];
            expect(activeMove.pathIndex).toBe(1); // At [0][1]
            expect(timeline.currentState.board[0][1].ownerId).toBe(1);

            // Redirect: Player issues a new path starting from [0][1] to [0][0]
            const actionRedirect = {
                path: [
                    { row: 0, col: 1 },
                    { row: 0, col: 0 }
                ],
                isSplit: false
            };
            processMove(1, actionRedirect, 'timeline-alpha', game);

            // Old move should be cancelled and removed.
            // Since path starting tile [0][1] now has the returned armies (99) + its own 1 (ownerId was 1),
            // issuing a new move leaves 1 behind and moves 98.
            expect(timeline.currentState.moves).toHaveLength(1);
            const redirectMove = timeline.currentState.moves[0];
            expect(redirectMove.army).toBe(98);
            expect(timeline.currentState.board[0][1].army).toBe(1);
        });

        test('processMove enforces maxMovingArmies limit and handles concurrent multi-army redirection correctly', () => {
            // Set limit to 2
            game.settings.maxMovingArmies = 2;

            // Populate player 1 tiles with armies
            timeline.currentState.board[1][0] = { type: TILE_TYPE.EMPTY, ownerId: 1, army: 50 };
            timeline.currentState.board[2][0] = { type: TILE_TYPE.EMPTY, ownerId: 1, army: 50 };
            timeline.currentState.board[3][0] = { type: TILE_TYPE.EMPTY, ownerId: 1, army: 50 };

            // Issue Move 1: from [1][0] to [1][1]
            const action1 = {
                path: [
                    { row: 1, col: 0 },
                    { row: 1, col: 1 }
                ],
                isSplit: false
            };
            processMove(1, action1, 'timeline-alpha', game);
            expect(timeline.currentState.moves).toHaveLength(1);
            expect(timeline.currentState.moves[0].path[0]).toEqual({ row: 1, col: 0 });

            // Issue Move 2: from [2][0] to [2][1]
            const action2 = {
                path: [
                    { row: 2, col: 0 },
                    { row: 2, col: 1 }
                ],
                isSplit: false
            };
            processMove(1, action2, 'timeline-alpha', game);
            expect(timeline.currentState.moves).toHaveLength(2);
            expect(timeline.currentState.moves[1].path[0]).toEqual({ row: 2, col: 0 });

            // Issue Move 3: from [3][0] to [3][1] -> Should be blocked because limit is 2
            const action3 = {
                path: [
                    { row: 3, col: 0 },
                    { row: 3, col: 1 }
                ],
                isSplit: false
            };
            processMove(1, action3, 'timeline-alpha', game);
            // moves length should still be 2, not 3
            expect(timeline.currentState.moves).toHaveLength(2);

            // Redirect Move 1: from [1][0] to [1][2]
            const actionRedirect = {
                path: [
                    { row: 1, col: 0 },
                    { row: 1, col: 1 },
                    { row: 1, col: 2 }
                ],
                isSplit: false
            };
            processMove(1, actionRedirect, 'timeline-alpha', game);

            // The moves count should still be 2
            expect(timeline.currentState.moves).toHaveLength(2);

            // Move 1's destination should now be [1][2]
            const redirectedMove = timeline.currentState.moves.find(m => m.path[m.path.length - 1].row === 1 && m.path[m.path.length - 1].col === 2);
            expect(redirectedMove).toBeDefined();
            expect(redirectedMove.army).toBe(49); // 50 - 1 left behind

            // Move 2 should remain completely intact
            const intactMove = timeline.currentState.moves.find(m => m.path[0].row === 2 && m.path[0].col === 0);
            expect(intactMove).toBeDefined();
            expect(intactMove.army).toBe(49); // 50 - 1 left behind
        });

        test('processMove allows prefix and destination path extensions seamlessly without resetting movement progress', () => {
            // Set up board for player 1
            timeline.currentState.board[1][0] = { type: TILE_TYPE.EMPTY, ownerId: 1, army: 50 };

            // 1. Prefix Extension test:
            // Issue Move 1: [1][0] to [1][1]
            const action1 = {
                path: [
                    { row: 1, col: 0 },
                    { row: 1, col: 1 }
                ],
                isSplit: false
            };
            processMove(1, action1, 'timeline-alpha', game);
            expect(timeline.currentState.moves).toHaveLength(1);
            
            const moveObj = timeline.currentState.moves[0];
            expect(moveObj.path).toHaveLength(2);
            expect(moveObj.progress).toBe(0);

            // Tick time once, so progress becomes 1
            runSingleTickLogic(timeline.currentState, 'timeline-alpha', game);
            expect(moveObj.progress).toBe(1);

            // Issue Prefix Extension: [1][0] -> [1][1] -> [1][2]
            const actionPrefixExtension = {
                path: [
                    { row: 1, col: 0 },
                    { row: 1, col: 1 },
                    { row: 1, col: 2 }
                ],
                isSplit: false
            };
            processMove(1, actionPrefixExtension, 'timeline-alpha', game);

            // Verify path is updated, but progress and army are NOT reset/returned!
            expect(timeline.currentState.moves).toHaveLength(1);
            expect(moveObj.path).toHaveLength(3);
            expect(moveObj.progress).toBe(1); // Crucial: progress was NOT reset to 0!
            expect(timeline.currentState.board[1][0].army).toBe(1); // Crucial: troops not returned!

            // 2. Destination Extension test:
            // Issue Destination Extension from the final destination [1][2] to [1][3]
            const actionDestExtension = {
                path: [
                    { row: 1, col: 2 },
                    { row: 1, col: 3 }
                ],
                isSplit: false
            };
            processMove(1, actionDestExtension, 'timeline-alpha', game);

            // Verify path has been appended, progress remains 1
            expect(timeline.currentState.moves).toHaveLength(1);
            expect(moveObj.path).toHaveLength(4);
            expect(moveObj.path[3]).toEqual({ row: 1, col: 3 });
            expect(moveObj.progress).toBe(1); // Crucial: progress not reset!
        });

        test('soldier accumulation ticks operate normally based on step count', () => {
            // General accumulates 1 soldier every 4 ticks
            // Land (Empty) accumulates 1 soldier every 20 ticks
            timeline.currentState.board[0][1] = { type: TILE_TYPE.EMPTY, ownerId: 1, army: 10 };
            
            // Advance game ticks
            for (let i = 0; i < 20; i++) {
                runSingleTickLogic(timeline.currentState, 'timeline-alpha', game);
            }

            // General (at 0,0) generated 5 soldiers (20 / 4)
            expect(timeline.currentState.board[0][0].army).toBe(105);

            // Empty Land (at 0,1) generated 1 soldier (20 / 20)
            expect(timeline.currentState.board[0][1].army).toBe(11);
        });
    });

    describe('3. Combat Resolution & Defeat Handlers', () => {
        let game, timeline;

        beforeEach(() => {
            game = getGame();
            const cols = 6;
            const rows = 6;
            setBoardCols(cols);
            setBoardRows(rows);

            const board = Array(rows).fill(null).map(() => 
                Array(cols).fill(null).map(() => ({ type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 }))
            );

            // Player 1 General
            board[0][0] = { type: TILE_TYPE.GENERAL, ownerId: 1, army: 50 };
            // Player 2 General
            board[5][5] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 30 };
            // Neutral City
            board[0][1] = { type: TILE_TYPE.CITY, ownerId: 0, army: 10 };

            const initialGameState = { board, gameStep: 0, moves: [] };
            game.boardDimensions = { cols, rows };
            game.multiverse['timeline-alpha'] = {
                id: 'timeline-alpha',
                currentState: initialGameState,
                keyframes: [{ step: 0, gameState: JSON.parse(JSON.stringify(initialGameState)) }],
                actions: [],
                isFrozen: false,
                freezeUntilStep: 0,
                overclockUntilStep: 0,
                speedMultiplier: 1.0,
                anchorStep: 0,
                parentId: null,
                splitStep: 0,
                isUnravelling: false,
                unravelCenter: null,
                unravelRadius: 0
            };
            game.gameState = 'RUNNING';
            timeline = game.multiverse['timeline-alpha'];
        });

        test('armies can attack and conquer neutral cities if they have a larger army', () => {
            // Player 1 moves from [0][0] to [0][1] (city with 10 troops)
            const action = {
                path: [
                    { row: 0, col: 0 },
                    { row: 0, col: 1 }
                ],
                isSplit: false
            };
            processMove(1, action, 'timeline-alpha', game);

            // Tick game loop to execute the move (MOVE_TICKS = 2)
            runSingleTickLogic(timeline.currentState, 'timeline-alpha', game);
            runSingleTickLogic(timeline.currentState, 'timeline-alpha', game);

            // City should now be owned by Player 1.
            // Remaining army = 49 (attacker) - 10 (neutral) = 39.
            expect(timeline.currentState.board[0][1].ownerId).toBe(1);
            expect(timeline.currentState.board[0][1].army).toBe(39);
        });

        test('attacking enemy-occupied tiles triggers combat and correctly transfers territory', () => {
            // Setup Player 2 unit at [0][1] with 10 armies
            timeline.currentState.board[0][1] = { type: TILE_TYPE.EMPTY, ownerId: 2, army: 10 };

            // Player 1 attacks with 49 troops
            const action = {
                path: [
                    { row: 0, col: 0 },
                    { row: 0, col: 1 }
                ],
                isSplit: false
            };
            processMove(1, action, 'timeline-alpha', game);

            runSingleTickLogic(timeline.currentState, 'timeline-alpha', game);
            runSingleTickLogic(timeline.currentState, 'timeline-alpha', game);

            // Player 1 conquers the tile. Remaining army = 49 - 10 = 39.
            expect(timeline.currentState.board[0][1].ownerId).toBe(1);
            expect(timeline.currentState.board[0][1].army).toBe(39);
        });

        test('capturing an enemy general conquers all of their territory and defeats them', () => {
            // Give Player 2 some lands
            timeline.currentState.board[0][1] = { type: TILE_TYPE.EMPTY, ownerId: 2, army: 5 };
            timeline.currentState.board[0][2] = { type: TILE_TYPE.EMPTY, ownerId: 2, army: 5 };

            // Player 1 General is at [0][0] with 50 troops. Player 2 General at [5][5] has 30 troops.
            // Let's teleport Player 1's army right next to Player 2's General and attack.
            timeline.currentState.board[5][4] = { type: TILE_TYPE.EMPTY, ownerId: 1, army: 45 };

            const action = {
                path: [
                    { row: 5, col: 4 },
                    { row: 5, col: 5 }
                ],
                isSplit: false
            };
            processMove(1, action, 'timeline-alpha', game);

            // Execute attack
            runSingleTickLogic(timeline.currentState, 'timeline-alpha', game);
            runSingleTickLogic(timeline.currentState, 'timeline-alpha', game);

            // Player 2 General at [5][5] is conquered. Remaining army = 44 - 30 = 14.
            expect(timeline.currentState.board[5][5].ownerId).toBe(1);
            expect(timeline.currentState.board[5][5].army).toBe(14);

            // All Player 2 territory should be inherited by Player 1.
            expect(timeline.currentState.board[0][1].ownerId).toBe(1);
            expect(timeline.currentState.board[0][2].ownerId).toBe(1);
        });
    });

    describe('4. Time Manipulation Powers', () => {
        let game, timeline;

        beforeEach(() => {
            game = getGame();
            const cols = 6;
            const rows = 6;
            setBoardCols(cols);
            setBoardRows(rows);

            const board = Array(rows).fill(null).map(() => 
                Array(cols).fill(null).map(() => ({ type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 }))
            );

            // Player 1 General at [0][0] with 1000 soldiers for time manipulation actions
            board[0][0] = { type: TILE_TYPE.GENERAL, ownerId: 1, army: 1000 };
            board[5][5] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 100 };

            const initialGameState = { board, gameStep: 0, moves: [] };
            game.boardDimensions = { cols, rows };
            game.multiverse['timeline-alpha'] = {
                id: 'timeline-alpha',
                currentState: initialGameState,
                keyframes: [{ step: 0, gameState: JSON.parse(JSON.stringify(initialGameState)) }],
                actions: [],
                isFrozen: false,
                freezeUntilStep: 0,
                overclockUntilStep: 0,
                speedMultiplier: 1.0,
                anchorStep: 0,
                parentId: null,
                splitStep: 0,
                isUnravelling: false,
                unravelCenter: null,
                unravelRadius: 0
            };
            game.gameState = 'RUNNING';
            timeline = game.multiverse['timeline-alpha'];
        });

        test('splitTimeline creates a perfect timeline copy and deducts exponential HSL cost', () => {
            const initialTimelineCount = Object.keys(game.multiverse).length;
            expect(initialTimelineCount).toBe(1);

            // Perform Split
            splitTimeline(1, 'timeline-alpha', game);

            const activeTimelines = Object.keys(game.multiverse);
            expect(activeTimelines).toHaveLength(2);

            const newTimelineId = activeTimelines.find(id => id !== 'timeline-alpha');
            expect(newTimelineId).toContain('timeline-');

            // Verify parent-child tracking
            const childTimeline = game.multiverse[newTimelineId];
            expect(childTimeline.parentId).toBe('timeline-alpha');
            expect(childTimeline.splitStep).toBe(0);

            // Verify cost deduction. Base SPLIT_BASE is 250.
            // 1000 - 250 = 750 remaining in both timelines
            expect(timeline.currentState.board[0][0].army).toBe(750);
            expect(childTimeline.currentState.board[0][0].army).toBe(750);
        });

        test('freezeTimeline pauses timeline steps and freezes movements', () => {
            // Freeze timeline first! Cost calculation is dynamic (approx 15 * 1.07^(10/5) = 17)
            freezeTimeline(1, 'timeline-alpha', game, 10, 17);

            expect(timeline.isFrozen).toBe(true);
            expect(timeline.freezeUntilStep).toBe(10);
            // 1000 - 17 = 983 remaining
            expect(timeline.currentState.board[0][0].army).toBe(983);

            // Now process the move with remaining troops
            const action = {
                path: [
                    { row: 0, col: 0 },
                    { row: 0, col: 1 }
                ],
                isSplit: false
            };
            processMove(1, action, 'timeline-alpha', game);
            expect(timeline.currentState.moves).toHaveLength(1);

            // Advancing the game loop does not process single tick logic
            updateTimeline(timeline, 'timeline-alpha', game);
            expect(timeline.currentState.gameStep).toBe(1); // step increments but logic doesn't run
            expect(timeline.currentState.moves[0].progress).toBe(0); // movement progress did not increase
        });

        test('overclockTimeline accelerates single-tick logic executions', () => {
            // Overclock timeline first! Cost calculation: approx 20 * 1.08^2 = 23
            overclockTimeline(1, 'timeline-alpha', game, 10, 23);

            expect(timeline.speedMultiplier).toBe(2.0);
            expect(timeline.overclockUntilStep).toBe(10);
            // 1000 - 23 = 977 remaining
            expect(timeline.currentState.board[0][0].army).toBe(977);

            // Now process a move with length 3 path to allow step progression check
            const action = {
                path: [
                    { row: 0, col: 0 },
                    { row: 0, col: 1 },
                    { row: 0, col: 2 }
                ],
                isSplit: false
            };
            processMove(1, action, 'timeline-alpha', game);

            // Single gameLoop call now runs two ticks for overclocked timeline
            gameLoop(game);

            // Game step increases by 2.
            expect(timeline.currentState.gameStep).toBe(2);
            // In 2 ticks, the army completes its first step:
            // pathIndex is advanced to 1, and progress is reset to 0
            expect(timeline.currentState.moves[0].pathIndex).toBe(1);
            expect(timeline.currentState.moves[0].progress).toBe(0);
        });

        test('openPortal registers portals and facilitates inter-timeline travel', () => {
            // Split timeline to create a second universe
            splitTimeline(1, 'timeline-alpha', game);
            const activeTimelines = Object.keys(game.multiverse);
            const childTimelineId = activeTimelines.find(id => id !== 'timeline-alpha');

            // Open portal at [0][1]. Cost approx 40 * 1.06^(10/5) = 44
            openPortal(1, 'timeline-alpha', { row: 0, col: 1 }, game, 10, 44);

            // Expect portals to be set up bidirectionally in game.portals
            expect(game.portals).toHaveLength(2);
            
            const portalFromAlpha = game.portals.find(p => p.fromTimelineId === 'timeline-alpha');
            expect(portalFromAlpha.toTimelineId).toBe(childTimelineId);
            expect(portalFromAlpha.coords).toEqual({ row: 0, col: 1 });

            // Issue movement in timeline-alpha that goes into the portal
            const action = {
                path: [
                    { row: 0, col: 0 },
                    { row: 0, col: 1 }
                ],
                isSplit: false
            };
            processMove(1, action, 'timeline-alpha', game);

            // Execute ticks
            runSingleTickLogic(timeline.currentState, 'timeline-alpha', game);
            runSingleTickLogic(timeline.currentState, 'timeline-alpha', game);

            // The army should have hopped! It should be removed from timeline-alpha moves queue
            // and added to the destination timeline moves queue emerging at a valid adjacent tile.
            expect(timeline.currentState.moves).toHaveLength(0);

            const destTimeline = game.multiverse[childTimelineId];
            expect(destTimeline.currentState.moves).toHaveLength(1);

            const hoppedMove = destTimeline.currentState.moves[0];
            expect(hoppedMove.ownerId).toBe(1);
            expect(hoppedMove.causalityTag).toBeDefined();
            expect(hoppedMove.causalityTag.originTimelineId).toBe('timeline-alpha');
        });

        test('anchorTimeline updates save-point steps correctly', () => {
            // Set steps to 50, save a keyframe
            timeline.currentState.gameStep = 50;
            timeline.keyframes.push({ step: 50, gameState: JSON.parse(JSON.stringify(timeline.currentState)) });

            // Anchor the timeline
            anchorTimeline(1, 'timeline-alpha', game);

            expect(timeline.anchorStep).toBe(50);
            expect(timeline.currentState.board[0][0].army).toBe(800); // 1000 - ANCHOR cost (200)
        });

        test('rollbackTimeline rewinds game states using keyframes and replaying moves', () => {
            // Save starting state keyframe at step 0
            // Advance steps, create a keyframe at step 10
            timeline.currentState.gameStep = 10;
            timeline.keyframes.push({ step: 10, gameState: JSON.parse(JSON.stringify(timeline.currentState)) });

            // Add a move action recorded in timeline actions at step 12
            timeline.currentState.gameStep = 15;
            timeline.currentState.board[0][1] = { type: TILE_TYPE.EMPTY, ownerId: 1, army: 50 };
            timeline.actions.push({
                step: 12,
                action: {
                    type: 'MOVE',
                    playerId: 1,
                    path: [{ row: 0, col: 1 }, { row: 1, col: 1 }],
                    isSplit: false
                }
            });

            // Revert timeline back to step 10
            rollbackTimeline(1, 'timeline-alpha', 10, game);

            // Current state step should be reverted to 10
            expect(timeline.currentState.gameStep).toBe(10);
            // Action taken at step 12 should be erased
            expect(timeline.currentState.board[0][1].army).toBe(0);
            expect(timeline.actions).toHaveLength(0);
        });
    });

    describe('5. Paradox Handling & Causality', () => {
        let game, timeline;

        beforeEach(() => {
            game = getGame();
            const cols = 6;
            const rows = 6;
            setBoardCols(cols);
            setBoardRows(rows);

            const board = Array(rows).fill(null).map(() => 
                Array(cols).fill(null).map(() => ({ type: TILE_TYPE.EMPTY, ownerId: 0, army: 0 }))
            );

            // Player 1 General
            board[0][0] = { type: TILE_TYPE.GENERAL, ownerId: 1, army: 1000 };
            // Player 2 General
            board[5][5] = { type: TILE_TYPE.GENERAL, ownerId: 2, army: 100 };

            const initialGameState = { board, gameStep: 0, moves: [] };
            game.boardDimensions = { cols, rows };
            game.multiverse['timeline-alpha'] = {
                id: 'timeline-alpha',
                currentState: initialGameState,
                keyframes: [{ step: 0, gameState: JSON.parse(JSON.stringify(initialGameState)) }],
                actions: [],
                isFrozen: false,
                freezeUntilStep: 0,
                overclockUntilStep: 0,
                speedMultiplier: 1.0,
                anchorStep: 0,
                parentId: null,
                splitStep: 0,
                isUnravelling: false,
                unravelCenter: null,
                unravelRadius: 0
            };
            game.gameState = 'RUNNING';
            timeline = game.multiverse['timeline-alpha'];
        });

        test('unravelling timeline: child timeline unravels if parent is rolled back past split step', () => {
            // Set parent timeline steps to 20, split child timeline
            timeline.currentState.gameStep = 20;
            timeline.keyframes.push({ step: 20, gameState: JSON.parse(JSON.stringify(timeline.currentState)) });

            splitTimeline(1, 'timeline-alpha', game);
            const activeTimelines = Object.keys(game.multiverse);
            const childTimelineId = activeTimelines.find(id => id !== 'timeline-alpha');
            const childTimeline = game.multiverse[childTimelineId];

            expect(childTimeline.splitStep).toBe(20);

            // Rollback parent timeline to step 10 (before split)
            rollbackTimeline(1, 'timeline-alpha', 0, game);

            // Trigger paradox handler to detect the parent split rollback
            paradoxHandler(game);

            // Child timeline should now be flagged as unravelling
            expect(childTimeline.isUnravelling).toBe(true);
            expect(childTimeline.unravelCenter).toBeDefined();

            // Run paradoxHandler again to progress unravelling and erase tiles
            paradoxHandler(game);
            expect(childTimeline.unravelRadius).toBe(1);
            
            // Center of unravelling is General coordinate (0,0)
            // It should erase the general tile
            expect(childTimeline.currentState.board[0][0].type).toBe(TILE_TYPE.ERASED);
            expect(childTimeline.currentState.board[0][0].army).toBe(0);
        });

        test('timeline erasure reparents child timelines to grandparent to preserve UI connectivity', () => {
            // 1. Set timeline-alpha step to 10 and split to create timeline-beta
            timeline.currentState.gameStep = 10;
            timeline.keyframes.push({ step: 10, gameState: JSON.parse(JSON.stringify(timeline.currentState)) });
            splitTimeline(1, 'timeline-alpha', game);

            const betaId = Object.keys(game.multiverse).find(id => id !== 'timeline-alpha');
            const betaTimeline = game.multiverse[betaId];
            expect(betaTimeline.parentId).toBe('timeline-alpha');

            // 2. Set timeline-beta step to 20 and split to create timeline-gamma
            betaTimeline.currentState.gameStep = 20;
            betaTimeline.keyframes.push({ step: 20, gameState: JSON.parse(JSON.stringify(betaTimeline.currentState)) });
            splitTimeline(1, betaId, game);

            const gammaId = Object.keys(game.multiverse).find(id => id !== 'timeline-alpha' && id !== betaId);
            const gammaTimeline = game.multiverse[gammaId];
            expect(gammaTimeline.parentId).toBe(betaId);

            // 3. Rollback timeline-alpha past timeline-beta's splitStep (10)
            rollbackTimeline(1, 'timeline-alpha', 0, game);

            // 4. Run paradoxHandler to trigger unravelling of timeline-beta
            paradoxHandler(game);
            expect(betaTimeline.isUnravelling).toBe(true);

            // 5. Progress paradoxHandler until timeline-beta is completely erased/deleted
            for (let i = 0; i < 15; i++) {
                paradoxHandler(game);
            }

            // 6. Verify timeline-beta is deleted
            expect(game.multiverse[betaId]).toBeUndefined();

            // 7. Verify timeline-gamma's parentId has been updated to grandparent (timeline-alpha)!
            expect(gammaTimeline.parentId).toBe('timeline-alpha');
        });

        test('causality violation: units and territory erased if hopped-from portal history is undone', () => {
            // Split timeline to create universe-beta
            splitTimeline(1, 'timeline-alpha', game);
            const activeTimelines = Object.keys(game.multiverse);
            const childTimelineId = activeTimelines.find(id => id !== 'timeline-alpha');
            const childTimeline = game.multiverse[childTimelineId];

            // Set parent steps to 10 and record keyframe, then advance to 20
            timeline.currentState.gameStep = 10;
            timeline.keyframes.push({ step: 10, gameState: JSON.parse(JSON.stringify(timeline.currentState)) });
            timeline.currentState.gameStep = 20;

            // Set up a hopped unit inside child timeline with causality pointing to timeline-alpha at step 15
            childTimeline.currentState.board[3][3] = {
                type: TILE_TYPE.EMPTY,
                ownerId: 1,
                army: 40,
                causalityTag: { originTimelineId: 'timeline-alpha', originStep: 15 }
            };

            // Run paradox handler - no paradox yet as timeline-alpha is still at step 20 (>= 15)
            paradoxHandler(game);
            expect(childTimeline.currentState.board[3][3].army).toBe(40);

            // Roll back parent to step 10 (erasing step 15 history)
            rollbackTimeline(1, 'timeline-alpha', 10, game);

            // Trigger paradox handler
            paradoxHandler(game);

            // Hopped unit should be erased and territory neutralized
            const neutralizedTile = childTimeline.currentState.board[3][3];
            expect(neutralizedTile.army).toBe(0);
            expect(neutralizedTile.ownerId).toBe(0);
            expect(neutralizedTile.causalityTag).toBeUndefined();
            expect(game.paradoxEvents).toHaveLength(1);
        });
    });
});
