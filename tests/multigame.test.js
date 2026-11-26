/**
 * Unit tests for running several matches in one server.
 * The database is not connected in tests, so games get local ids.
 */
process.env.NODE_ENV = 'test';

const server = require('../server');
const {
    games, withGame, createRegisteredGame, findOpenLobby, destroyGame, humanSocketIds,
    getGame, getBoardCols, getBoardRows,
} = server;

describe('multiple games', () => {
    afterEach(() => {
        for (const g of [...games.values()]) destroyGame(g);
    });

    test('createRegisteredGame registers a lobby with its own room', async () => {
        const g = await createRegisteredGame({ userId: null, name: null });
        expect(g.id).toMatch(/^local-\d+$/);
        expect(g.room).toBe(`game-${g.id}`);
        expect(g.name).toBe('Guest game');
        expect(g.gameState).toBe('LOBBY');
        expect(games.get(String(g.id))).toBe(g);
    });

    test('a member-hosted game is named after them', async () => {
        const g = await createRegisteredGame({ userId: 7, name: 'Jams' });
        expect(g.name).toBe("Jams's game");
    });

    test('withGame points the engine at one match and restores the previous one', async () => {
        const a = await createRegisteredGame({ userId: null, name: null });
        const b = await createRegisteredGame({ userId: null, name: null });
        a.boardDimensions = { cols: 12, rows: 9 };
        b.boardDimensions = { cols: 50, rows: 40 };
        const outer = getGame();
        const outerCols = getBoardCols();

        withGame(a, () => {
            expect(getGame()).toBe(a);
            expect(getBoardCols()).toBe(12);
            expect(getBoardRows()).toBe(9);
            withGame(b, () => {
                expect(getGame()).toBe(b);
                expect(getBoardCols()).toBe(50);
            });
            expect(getGame()).toBe(a);
            expect(getBoardCols()).toBe(12);
        });

        expect(getGame()).toBe(outer);
        expect(getBoardCols()).toBe(outerCols);
    });

    test('withGame restores context even when the handler throws', async () => {
        const a = await createRegisteredGame({ userId: null, name: null });
        const outer = getGame();
        expect(() => withGame(a, () => { throw new Error('boom'); })).toThrow('boom');
        expect(getGame()).toBe(outer);
    });

    test('findOpenLobby skips running matches', async () => {
        const running = await createRegisteredGame({ userId: null, name: null });
        running.gameState = 'RUNNING';
        expect(findOpenLobby()).toBeNull();

        const lobby = await createRegisteredGame({ userId: null, name: null });
        expect(findOpenLobby()).toBe(lobby);
    });

    test('destroyGame removes the match and stops its timers', async () => {
        const g = await createRegisteredGame({ userId: null, name: null });
        g.gameInterval = setTimeout(() => { throw new Error('should not run'); }, 50);
        destroyGame(g);
        expect(games.has(String(g.id))).toBe(false);
        expect(g.destroyed).toBe(true);
        await new Promise(r => setTimeout(r, 80));
    });

    test('humanSocketIds ignores AI players', async () => {
        const g = await createRegisteredGame({ userId: null, name: null });
        g.players = { abc: { id: 1 }, 'ai-socket-opponent': { id: 2, isAI: true } };
        expect(humanSocketIds(g)).toEqual(['abc']);
    });
});
