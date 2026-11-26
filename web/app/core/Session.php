<?php

/**
 * Cookie-based PHP session with hardened settings.
 *
 * - The session id lives only in an HttpOnly, SameSite=Lax cookie (Secure on HTTPS).
 * - Strict mode rejects ids the server did not create (stops session fixation).
 * - Sessions expire after inactivity and after a maximum age.
 */
class Session
{
    public static function start(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }

        $cfg = Config::get('session');
        $secure = $cfg['secure'] ?? null;
        if ($secure === null) {
            $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
        }

        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.use_trans_sid', '0');

        session_name($cfg['name'] ?? 'dominion_sid');
        session_set_cookie_params([
            'lifetime' => 0,          // until the browser closes
            'path'     => '/',
            'secure'   => $secure,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);

        session_start();
        self::enforceTimeouts($cfg);
    }

    private static function enforceTimeouts(array $cfg): void
    {
        $now = time();
        $idle = $cfg['idle_timeout'] ?? 1800;
        $absolute = $cfg['absolute_timeout'] ?? 28800;

        $created = $_SESSION['_created'] ?? $now;
        $last = $_SESSION['_last_activity'] ?? $now;

        if (isset($_SESSION['user_id']) && ($now - $last > $idle || $now - $created > $absolute)) {
            self::restart();
            self::flash('error', 'Your session expired. Please log in again.');
            $created = $now;
        }

        $_SESSION['_created'] = $created;
        $_SESSION['_last_activity'] = $now;
    }

    /** Throw the old session away and begin a fresh, empty one with a new id. */
    public static function restart(): void
    {
        self::destroy();
        session_id(session_create_id());
        session_start();
        $_SESSION['_created'] = time();
        $_SESSION['_last_activity'] = time();
    }

    /** New session id, keeping the data. Call on login and privilege changes. */
    public static function regenerate(): void
    {
        session_regenerate_id(true);
        $_SESSION['_created'] = time();
    }

    public static function get(string $key, $default = null)
    {
        return $_SESSION[$key] ?? $default;
    }

    public static function set(string $key, $value): void
    {
        $_SESSION[$key] = $value;
    }

    public static function forget(string $key): void
    {
        unset($_SESSION[$key]);
    }

    /** One-time message shown on the next page. */
    public static function flash(string $type, string $message): void
    {
        $_SESSION['_flash'][] = ['type' => $type, 'message' => $message];
    }

    public static function takeFlashes(): array
    {
        $messages = $_SESSION['_flash'] ?? [];
        unset($_SESSION['_flash']);
        return $messages;
    }

    /** Wipe the session data, the server-side file and the browser cookie. */
    public static function destroy(): void
    {
        $_SESSION = [];

        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', [
                'expires'  => time() - 42000,
                'path'     => $p['path'],
                'domain'   => $p['domain'],
                'secure'   => $p['secure'],
                'httponly' => $p['httponly'],
                'samesite' => $p['samesite'] ?? 'Lax',
            ]);
        }

        session_destroy();
    }
}
