<?php

/** Shared input rules for signup, profile edits and admin edits. */
class Validator
{
    public static function username(string $username): ?string
    {
        if (!preg_match('/^[A-Za-z0-9_]{3,20}$/', $username)) {
            return 'Username must be 3 to 20 letters, numbers or underscores.';
        }
        return null;
    }

    public static function email(string $email): ?string
    {
        if (strlen($email) > 255 || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            return 'Enter a valid email address.';
        }
        return null;
    }

    public static function displayName(string $name): ?string
    {
        if (mb_strlen($name) > 50) {
            return 'Display name can be at most 50 characters.';
        }
        return null;
    }

    public static function password(string $password, string $confirm): ?string
    {
        if (strlen($password) < 8) {
            return 'Password must be at least 8 characters.';
        }
        // bcrypt only uses the first 72 bytes.
        if (strlen($password) > 72) {
            return 'Password can be at most 72 characters.';
        }
        if (!hash_equals($password, $confirm)) {
            return 'Passwords do not match.';
        }
        return null;
    }
}
