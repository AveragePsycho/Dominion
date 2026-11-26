<?php

class Config
{
    private static ?array $values = null;

    public static function load(string $file): void
    {
        if (!is_file($file)) {
            http_response_code(500);
            exit('Missing web/config.php. Copy web/config.example.php to web/config.php and edit it.');
        }
        self::$values = require $file;
    }

    public static function get(string $key, $default = null)
    {
        return self::$values[$key] ?? $default;
    }
}
