<?php

/**
 * Who is logged in, and what they may do.
 *
 * Only the user id is kept in the session. The user's row and permissions are
 * loaded fresh from the database on each request, so role changes and
 * disabled accounts take effect immediately.
 */
class Auth
{
    private static ?array $user = null;
    private static ?array $permissions = null;
    private static bool $loaded = false;

    public static function login(array $user): void
    {
        Session::regenerate();
        $_SESSION['user_id'] = (int) $user['user_id'];
        self::$loaded = false;
    }

    public static function logout(): void
    {
        Session::restart();
        self::$user = null;
        self::$permissions = null;
        self::$loaded = true;
    }

    public static function id(): ?int
    {
        $user = self::user();
        return $user ? (int) $user['user_id'] : null;
    }

    public static function check(): bool
    {
        return self::user() !== null;
    }

    /** The current user's row (with role_name), or null for guests. */
    public static function user(): ?array
    {
        if (!self::$loaded) {
            self::$loaded = true;
            self::$user = null;
            self::$permissions = null;

            if (isset($_SESSION['user_id'])) {
                $user = (new User())->findById((int) $_SESSION['user_id']);

                if ($user && $user['status'] === 'active') {
                    self::$user = $user;
                } else {
                    // Deleted or disabled since login: end the session.
                    Session::restart();
                    Session::flash('error', 'Your account is no longer active.');
                }
            }
        }

        return self::$user;
    }

    public static function role(): ?string
    {
        return self::user()['role_name'] ?? null;
    }

    /** Does the current user hold this permission key (e.g. "members.edit")? */
    public static function can(string $permission): bool
    {
        if (!self::check()) {
            return false;
        }
        if (self::$permissions === null) {
            self::$permissions = (new Role())->permissionKeys((int) self::$user['role_id']);
        }
        return in_array($permission, self::$permissions, true);
    }

    /** Forget the cached user so the next call reloads it (after profile edits). */
    public static function refresh(): void
    {
        self::$loaded = false;
    }
}
