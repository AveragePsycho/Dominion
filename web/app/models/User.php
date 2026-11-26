<?php

class User
{
    private PDO $db;

    /** Columns the member list may be sorted by (ORDER BY can't be a placeholder). */
    private const SORTABLE = [
        'username'   => 'u.username',
        'email'      => 'u.email',
        'role'       => 'r.name',
        'status'     => 'u.status',
        'created'    => 'u.created_at',
        'last_login' => 'u.last_login_at',
    ];

    private const BASE_SELECT = '
        SELECT u.user_id, u.username, u.email, u.password_hash, u.display_name,
               u.role_id, r.name AS role_name, u.status,
               u.created_at, u.updated_at, u.last_login_at
        FROM users u
        JOIN roles r ON r.role_id = u.role_id
    ';

    public function __construct()
    {
        $this->db = Database::getInstance();
    }

    public function findById(int $id): ?array
    {
        $stmt = $this->db->prepare(self::BASE_SELECT . ' WHERE u.user_id = ?');
        $stmt->execute([$id]);
        return $stmt->fetch() ?: null;
    }

    public function findByUsername(string $username): ?array
    {
        $stmt = $this->db->prepare(self::BASE_SELECT . ' WHERE u.username = ?');
        $stmt->execute([$username]);
        return $stmt->fetch() ?: null;
    }

    /** Login accepts either username or email. */
    public function findByLogin(string $login): ?array
    {
        $stmt = $this->db->prepare(self::BASE_SELECT . ' WHERE u.username = ? OR u.email = ? LIMIT 1');
        $stmt->execute([$login, $login]);
        return $stmt->fetch() ?: null;
    }

    public function usernameTaken(string $username, ?int $exceptId = null): bool
    {
        $stmt = $this->db->prepare('SELECT 1 FROM users WHERE username = ? AND user_id <> ?');
        $stmt->execute([$username, $exceptId ?? 0]);
        return (bool) $stmt->fetchColumn();
    }

    public function emailTaken(string $email, ?int $exceptId = null): bool
    {
        $stmt = $this->db->prepare('SELECT 1 FROM users WHERE email = ? AND user_id <> ?');
        $stmt->execute([$email, $exceptId ?? 0]);
        return (bool) $stmt->fetchColumn();
    }

    /** Create a member. The password is hashed here and never stored in plain text. */
    public function create(string $username, string $email, string $password, string $displayName, int $roleId): int
    {
        $stmt = $this->db->prepare('
            INSERT INTO users (username, email, password_hash, display_name, role_id)
            VALUES (?, ?, ?, ?, ?)
        ');
        $stmt->execute([
            $username,
            $email,
            password_hash($password, PASSWORD_DEFAULT),
            $displayName,
            $roleId,
        ]);
        return (int) $this->db->lastInsertId();
    }

    public function updateProfile(int $id, string $username, string $email, string $displayName): void
    {
        $stmt = $this->db->prepare('
            UPDATE users SET username = ?, email = ?, display_name = ? WHERE user_id = ?
        ');
        $stmt->execute([$username, $email, $displayName, $id]);
    }

    public function updatePassword(int $id, string $password): void
    {
        $stmt = $this->db->prepare('UPDATE users SET password_hash = ? WHERE user_id = ?');
        $stmt->execute([password_hash($password, PASSWORD_DEFAULT), $id]);
    }

    /** Store a fresh hash when PHP's default algorithm or cost has changed. */
    public function rehashIfNeeded(array $user, string $password): void
    {
        if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
            $this->updatePassword((int) $user['user_id'], $password);
        }
    }

    public function updateRoleAndStatus(int $id, int $roleId, string $status): void
    {
        $stmt = $this->db->prepare('UPDATE users SET role_id = ?, status = ? WHERE user_id = ?');
        $stmt->execute([$roleId, $status, $id]);
    }

    public function touchLastLogin(int $id): void
    {
        $stmt = $this->db->prepare('UPDATE users SET last_login_at = NOW() WHERE user_id = ?');
        $stmt->execute([$id]);
    }

    public function delete(int $id): void
    {
        $stmt = $this->db->prepare('DELETE FROM users WHERE user_id = ?');
        $stmt->execute([$id]);
    }

    /** Number of active admins, used to stop the last one being removed or demoted. */
    public function countActiveAdmins(): int
    {
        $stmt = $this->db->prepare("
            SELECT COUNT(*) FROM users u JOIN roles r ON r.role_id = u.role_id
            WHERE r.name = 'admin' AND u.status = 'active'
        ");
        $stmt->execute();
        return (int) $stmt->fetchColumn();
    }

    /**
     * Search members by username, email or display name.
     * Returns ['rows' => [...], 'total' => n].
     */
    public function search(string $term, string $sort, string $dir, int $page, int $perPage): array
    {
        $where = '';
        $params = [];
        if ($term !== '') {
            $like = '%' . like_escape($term) . '%';
            $where = ' WHERE (u.username LIKE ? OR u.email LIKE ? OR u.display_name LIKE ?)';
            $params = [$like, $like, $like];
        }

        $count = $this->db->prepare('SELECT COUNT(*) FROM users u JOIN roles r ON r.role_id = u.role_id' . $where);
        $count->execute($params);
        $total = (int) $count->fetchColumn();

        $orderBy = self::SORTABLE[$sort] ?? self::SORTABLE['username'];
        $direction = strtolower($dir) === 'desc' ? 'DESC' : 'ASC';

        $stmt = $this->db->prepare(
            self::BASE_SELECT . $where . " ORDER BY $orderBy $direction, u.user_id ASC LIMIT ? OFFSET ?"
        );
        $i = 1;
        foreach ($params as $p) {
            $stmt->bindValue($i++, $p, PDO::PARAM_STR);
        }
        $stmt->bindValue($i++, $perPage, PDO::PARAM_INT);
        $stmt->bindValue($i, ($page - 1) * $perPage, PDO::PARAM_INT);
        $stmt->execute();

        return ['rows' => $stmt->fetchAll(), 'total' => $total];
    }

    public static function sortKeys(): array
    {
        return array_keys(self::SORTABLE);
    }
}
