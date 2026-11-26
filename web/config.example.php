<?php
// Copy this file to config.php and fill in your own values.
// config.php is gitignored so real credentials never get committed.

return [
    'app_name' => 'Dominion',

    'db' => [
        'host'     => '127.0.0.1',
        'port'     => 3306,
        'name'     => 'dominion',
        'user'     => 'dominion_app',
        'password' => 'change-me',
    ],

    'session' => [
        'name'             => 'dominion_sid',
        'idle_timeout'     => 30 * 60,      // seconds of inactivity before logout
        'absolute_timeout' => 8 * 60 * 60,  // max session age in seconds
        // null = auto-detect HTTPS. Force true in production behind HTTPS.
        'secure'           => null,
    ],

    // Where the Node game server runs. Players are sent here to play.
    'game_url' => 'http://localhost:3000',

    // How long a game ticket stays valid, in seconds.
    'ticket_ttl' => 60,

    // Login throttling: max failed attempts per username or IP within the window.
    'login_max_attempts' => 5,
    'login_window_minutes' => 15,
];
