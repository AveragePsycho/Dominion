/**
 * End-to-end check of the Node game server with the PHP site and MySQL.
 *
 * Needs: a freshly seeded database, the PHP site running (web/), this game server
 * running with DB access, and `npm install --no-save socket.io-client` for the test client.
 *
 *   GAME_URL=http://localhost:3000 SITE_URL=http://127.0.0.1:8000/index.php \
 *   DB_PASSWORD=change-me node tests/integration/multiplayer.js
 *
 * It is not part of `npm test`, because it needs those servers up.
 */
const { io } = require('socket.io-client');
const mysql = require('mysql2/promise');

const GAME_URL = process.env.GAME_URL || 'http://localhost:3000';
const SITE_URL = process.env.SITE_URL || 'http://127.0.0.1:8000/index.php';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`PASS ${name}`); }
    else { failed++; console.log(`FAIL ${name} ${detail}`); }
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** Log in on the PHP site and ask it for a game ticket, like the Join button does. */
async function siteTicket(login, password, gameId) {
    let cookie = '';
    const keep = (res) => {
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
    };
    const csrfFrom = async (route) => {
        const res = await fetch(`${SITE_URL}?url=${route}`, { headers: { cookie } });
        keep(res);
        return (await res.text()).match(/name="_csrf" value="([^"]+)"/)[1];
    };
    let token = await csrfFrom('login');
    let res = await fetch(`${SITE_URL}?url=login`, {
        method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: token, login, password }),
    });
    keep(res);
    token = await csrfFrom('games');
    const body = { _csrf: token };
    if (gameId) body.game_id = String(gameId);
    res = await fetch(`${SITE_URL}?url=games/play`, {
        method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
    });
    return new URL(res.headers.get('location')).searchParams;
}

/** Connect like the browser client does and collect the events we care about. */
function connect(auth) {
    return new Promise((resolve) => {
        const socket = io(GAME_URL, { auth, forceNew: true, transports: ['websocket'] });
        const client = { socket, lobby: null, assignment: null, events: [] };
        socket.on('player-assignment', (a) => { client.assignment = a; });
        socket.on('lobby-update', (l) => { client.lobby = l; client.events.push('lobby-update'); });
        socket.on('game-start', () => client.events.push('game-start'));
        socket.on('game-over', (g) => { client.events.push('game-over'); client.gameOver = g; });
        socket.on('game-in-progress', () => client.events.push('game-in-progress'));
        socket.on('connect', () => setTimeout(() => resolve(client), 300));
        socket.on('connect_error', (e) => { client.error = e.message; resolve(client); });
    });
}

const names = (c) => (c.lobby?.players || []).map(p => p.name);

(async () => {
    const db = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'dominion_app',
        password: process.env.DB_PASSWORD ?? 'change-me', database: process.env.DB_NAME || 'dominion',
    });
    const gameRow = async (id) => (await db.execute('SELECT * FROM games WHERE game_id = ?', [id]))[0][0];

    // Seeded sample games were closed when the server started.
    const [[{ open }]] = await db.execute("SELECT COUNT(*) AS open FROM games WHERE status <> 'finished'");
    check('stale games closed on server start', open === 0, `open=${open}`);

    // 1. A logged-in member hosts a new game through the site.
    const hostParams = await siteTicket('player1', 'Password123!');
    check('site sends new=1 and a ticket', hostParams.get('new') === '1' && /^[0-9a-f]{64}$/.test(hostParams.get('ticket') || ''));
    const host = await connect({ ticket: hostParams.get('ticket'), new: true });
    check('member joins under their display name', names(host).includes('Player One'), JSON.stringify(names(host)));

    const [[newest]] = await db.execute("SELECT * FROM games WHERE status = 'lobby' ORDER BY game_id DESC LIMIT 1");
    const gameId = newest.game_id;
    check('game row created in lobby', newest && newest.name === "Player One's game" && newest.host_name === 'Player One');
    await wait(100);
    check('player count includes the AI opponent', (await gameRow(gameId)).current_players === 2);

    // 2. The ticket can't be used twice.
    const reuse = await connect({ ticket: hostParams.get('ticket'), new: true });
    check('reused ticket plays as a guest', names(reuse).some(n => /^Guest \d+$/.test(n)) && !names(reuse).includes('Player One'),
        JSON.stringify(names(reuse)));
    reuse.socket.disconnect();

    // 3. A guest joins the same match from the search page.
    const guest = await connect({ game: String(gameId) });
    check('guest joins the chosen match as Guest 2', names(guest).includes('Guest 2') && names(guest).includes('Player One'),
        JSON.stringify(names(guest)));
    await wait(100);
    check('both players see each other', names(host).includes('Guest 2'));

    // 4. Another guest hosts a separate match; the first room doesn't hear about it.
    const before = host.events.length;
    const other = await connect({ new: true });
    check('second match is separate', !names(other).includes('Player One'));
    await wait(100);
    check('first match gets no events from the second', host.events.length === before);

    // 5. The site's search lists both live matches.
    const search = await (await fetch(`${SITE_URL}?url=api/games`)).json();
    const listed = search.games.map(g => g.name);
    check('site search lists both live matches', listed.includes("Player One's game") && listed.includes('Guest game'),
        JSON.stringify(listed));

    // 6. Start the first match.
    host.socket.emit('player-ready', true);
    guest.socket.emit('player-ready', true);
    await wait(400);
    check('match starts for both players', host.events.includes('game-start') && guest.events.includes('game-start'));
    check('other match did not start', !other.events.includes('game-start'));
    const running = await gameRow(gameId);
    check('game row shows running with map size', running.status === 'running' && running.map_cols > 0 && running.started_at !== null);
    const [[gp]] = await db.execute('SELECT result FROM game_players WHERE game_id = ? AND user_id = (SELECT user_id FROM users WHERE username = ?)', [gameId, 'player1']);
    check('registered player recorded in game_players', gp && gp.result === 'playing');

    const late = await connect({ game: String(gameId) });
    check('joining a running match is refused', late.events.includes('game-in-progress'));

    // 7. The guest leaves, so the member wins.
    guest.socket.disconnect();
    await wait(1500);
    check('remaining player gets game over', host.events.includes('game-over'));
    const [[won]] = await db.execute('SELECT result FROM game_players WHERE game_id = ? AND user_id = (SELECT user_id FROM users WHERE username = ?)', [gameId, 'player1']);
    check('member result recorded as won', won && won.result === 'won', JSON.stringify(won));

    // 8. Everyone leaves: matches close and drop out of search.
    host.socket.disconnect();
    other.socket.disconnect();
    await wait(300);
    check('empty match marked finished', (await gameRow(gameId)).status === 'finished');
    const after = await (await fetch(`${SITE_URL}?url=api/games`)).json();
    check('search is empty once everyone leaves', after.total === 0, JSON.stringify(after.games));

    await db.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
