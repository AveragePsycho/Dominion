<?php

/**
 * Single-use tickets that carry a logged-in user from the PHP site to the
 * Node game server. Node looks the token up, checks it is unused and not
 * expired, then marks it used.
 */
class GameTicket
{
    private PDO $db;

    public function __construct()
    {
        $this->db = Database::getInstance();
    }

    public function issue(int $userId, ?int $gameId): string
    {
        $token = bin2hex(random_bytes(32));
        $ttl = (int) Config::get('ticket_ttl', 60);

        $stmt = $this->db->prepare('
            INSERT INTO game_tickets (token, user_id, game_id, expires_at)
            VALUES (?, ?, ?, NOW() + INTERVAL ? SECOND)
        ');
        $stmt->execute([$token, $userId, $gameId, $ttl]);

        // Housekeeping: drop this user's old tickets.
        $cleanup = $this->db->prepare('
            DELETE FROM game_tickets WHERE user_id = ? AND (used_at IS NOT NULL OR expires_at < NOW())
        ');
        $cleanup->execute([$userId]);

        return $token;
    }
}
