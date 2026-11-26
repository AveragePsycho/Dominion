<?php

/** Records login attempts so repeated failures can be slowed down. */
class LoginAttempt
{
    private PDO $db;

    public function __construct()
    {
        $this->db = Database::getInstance();
    }

    public function record(string $login, string $ip, bool $success): void
    {
        $stmt = $this->db->prepare('
            INSERT INTO login_attempts (username, ip_address, success) VALUES (?, ?, ?)
        ');
        $stmt->execute([mb_substr($login, 0, 255), $ip, $success ? 1 : 0]);
    }

    /** True when the username or the IP has too many recent failures. */
    public function tooMany(string $login, string $ip): bool
    {
        $max = (int) Config::get('login_max_attempts', 5);
        $minutes = (int) Config::get('login_window_minutes', 15);

        $stmt = $this->db->prepare('
            SELECT
                SUM(username = ?)   AS by_user,
                SUM(ip_address = ?) AS by_ip
            FROM login_attempts
            WHERE success = 0
              AND attempted_at > (NOW() - INTERVAL ? MINUTE)
              AND (username = ? OR ip_address = ?)
        ');
        $stmt->execute([$login, $ip, $minutes, $login, $ip]);
        $row = $stmt->fetch();

        return (int) ($row['by_user'] ?? 0) >= $max || (int) ($row['by_ip'] ?? 0) >= $max * 4;
    }

    /** A successful login clears that username's failure count. */
    public function clear(string $login): void
    {
        $stmt = $this->db->prepare('DELETE FROM login_attempts WHERE username = ? AND success = 0');
        $stmt->execute([$login]);
    }
}
