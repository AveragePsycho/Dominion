<?php

/**
 * Single shared PDO connection.
 *
 * Every query in this app goes through prepare() + execute() with placeholders.
 * Emulated prepares are turned off so MySQL itself receives the parameters
 * separately from the SQL text.
 */
class Database
{
    private static ?PDO $conn = null;

    public static function getInstance(): PDO
    {
        if (self::$conn === null) {
            $db = Config::get('db');

            $dsn = sprintf(
                'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
                $db['host'],
                $db['port'] ?? 3306,
                $db['name']
            );

            self::$conn = new PDO($dsn, $db['user'], $db['password'], [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]);
        }

        return self::$conn;
    }
}
