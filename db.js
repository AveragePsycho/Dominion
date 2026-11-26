/**
 * MySQL access for the game server.
 *
 * The PHP site (web/) owns accounts; this module only:
 *   - redeems single-use login tickets issued by PHP (game_tickets),
 *   - keeps the games / game_players tables current so the site can search live games.
 *
 * Every query uses placeholders (pool.execute), never string-built SQL.
 *
 * The database is optional: if mysql2 isn't installed, DB_DISABLED=1 is set, or the
 * connection fails, the game still runs with guests only and nothing is recorded.
 *
 * Settings (environment variables, defaults match web/config.example.php):
 *   DB_HOST=localhost DB_PORT=3306 DB_NAME=dominion DB_USER=dominion_app DB_PASSWORD=change-me
 */

let pool = null;
let enabled = false;

async function init() {
    if (process.env.DB_DISABLED === '1') {
        console.log('[db] Disabled by DB_DISABLED=1. Guests only, games are not listed on the site.');
        return false;
    }

    let mysql;
    try {
        mysql = require('mysql2/promise');
    } catch (err) {
        console.log('[db] mysql2 is not installed (run "npm install"). Guests only, games are not listed on the site.');
        return false;
    }

    try {
        pool = mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            port: Number(process.env.DB_PORT || 3306),
            database: process.env.DB_NAME || 'dominion',
            user: process.env.DB_USER || 'dominion_app',
            password: process.env.DB_PASSWORD ?? 'change-me',
            waitForConnections: true,
            connectionLimit: 5,
            charset: 'utf8mb4',
        });
        await pool.execute('SELECT 1');
        enabled = true;
        console.log('[db] Connected to MySQL.');

        // Games left open by a previous run of the server no longer exist.
        await pool.execute(
            "UPDATE games SET status = 'finished', current_players = 0, ended_at = NOW() WHERE status <> 'finished'"
        );
    } catch (err) {
        console.log(`[db] Could not connect to MySQL (${err.code || err.message}). Guests only, games are not listed on the site.`);
        if (pool) pool.end().catch(() => {});
        pool = null;
        enabled = false;
    }
    return enabled;
}

function isEnabled() {
    return enabled;
}

/** Log and swallow DB errors so a database hiccup never crashes a running match. */
async function safe(label, fn, fallback = null) {
    if (!enabled) return fallback;
    try {
        return await fn();
    } catch (err) {
        console.error(`[db] ${label} failed:`, err.code || err.message);
        return fallback;
    }
}

/**
 * Redeem a login ticket. Marks it used in the same statement that checks it,
 * so a ticket can only ever be redeemed once.
 * @returns {Promise<{userId:number, username:string, displayName:string}|null>}
 */
function redeemTicket(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return Promise.resolve(null);

    return safe('redeemTicket', async () => {
        const [result] = await pool.execute(
            'UPDATE game_tickets SET used_at = NOW() WHERE token = ? AND used_at IS NULL AND expires_at > NOW()',
            [token]
        );
        if (result.affectedRows !== 1) return null;

        const [rows] = await pool.execute(
            `SELECT u.user_id, u.username, u.display_name
             FROM game_tickets t
             JOIN users u ON u.user_id = t.user_id
             WHERE t.token = ? AND u.status = 'active'`,
            [token]
        );
        if (!rows.length) return null;
        return { userId: rows[0].user_id, username: rows[0].username, displayName: rows[0].display_name };
    });
}

/** @returns {Promise<number|null>} the new game_id */
function createGame({ name, hostUserId, hostName, maxPlayers }) {
    return safe('createGame', async () => {
        const [result] = await pool.execute(
            `INSERT INTO games (name, host_user_id, host_name, status, max_players, current_players)
             VALUES (?, ?, ?, 'lobby', ?, 0)`,
            [name.slice(0, 60), hostUserId ?? null, hostName.slice(0, 50), Math.min(maxPlayers, 255)]
        );
        return result.insertId;
    });
}

/** Push a game's current status, host, player count and map size. */
function updateGame(dbId, { status, hostUserId, hostName, currentPlayers, cols, rows }) {
    return safe('updateGame', () => pool.execute(
        `UPDATE games SET
            status = ?,
            host_user_id = ?,
            host_name = ?,
            current_players = ?,
            map_cols = ?,
            map_rows = ?,
            started_at = CASE
                WHEN ? = 'running' AND (status <> 'running' OR started_at IS NULL) THEN NOW()
                WHEN ? = 'lobby' THEN NULL
                ELSE started_at END,
            ended_at = CASE WHEN ? = 'finished' THEN COALESCE(ended_at, NOW()) ELSE NULL END
         WHERE game_id = ?`,
        [status, hostUserId ?? null, hostName.slice(0, 50), Math.min(currentPlayers, 255),
         cols ?? null, rows ?? null, status, status, status, dbId]
    ));
}

/** Record a registered player as taking part in a match. */
function addPlayer(dbId, userId) {
    return safe('addPlayer', () => pool.execute(
        `INSERT INTO game_players (game_id, user_id, result) VALUES (?, ?, 'playing')
         ON DUPLICATE KEY UPDATE result = 'playing', joined_at = NOW()`,
        [dbId, userId]
    ));
}

/** result: 'won' | 'lost' | 'left' */
function setResult(dbId, userId, result) {
    return safe('setResult', () => pool.execute(
        'UPDATE game_players SET result = ? WHERE game_id = ? AND user_id = ?',
        [result, dbId, userId]
    ));
}

async function close() {
    if (pool) await pool.end();
    pool = null;
    enabled = false;
}

module.exports = { init, isEnabled, redeemTicket, createGame, updateGame, addPlayer, setResult, close };
