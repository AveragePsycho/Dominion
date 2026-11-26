<?php

class Game
{
    private PDO $db;

    private const SORTABLE = [
        'newest'  => 'g.created_at DESC',
        'name'    => 'g.name ASC',
        'players' => 'g.current_players DESC',
        'open'    => '(g.max_players - g.current_players) DESC',
    ];

    public function __construct()
    {
        $this->db = Database::getInstance();
    }

    public function find(int $id): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM games WHERE game_id = ?');
        $stmt->execute([$id]);
        return $stmt->fetch() ?: null;
    }

    /**
     * Search active (lobby or running) games.
     *
     * @param string $term     matched against game name and host name
     * @param string $status   '' (any active), 'lobby' or 'running'
     * @param bool   $openOnly only games with free slots
     */
    public function searchActive(string $term, string $status, bool $openOnly, string $sort, int $page, int $perPage): array
    {
        $conditions = ["g.status IN ('lobby', 'running')"];
        $params = [];

        if ($term !== '') {
            $like = '%' . like_escape($term) . '%';
            $conditions[] = '(g.name LIKE ? OR g.host_name LIKE ?)';
            $params[] = $like;
            $params[] = $like;
        }
        if ($status === 'lobby' || $status === 'running') {
            $conditions[] = 'g.status = ?';
            $params[] = $status;
        }
        if ($openOnly) {
            $conditions[] = 'g.current_players < g.max_players';
        }

        $where = ' WHERE ' . implode(' AND ', $conditions);

        $count = $this->db->prepare('SELECT COUNT(*) FROM games g' . $where);
        $count->execute($params);
        $total = (int) $count->fetchColumn();

        $orderBy = self::SORTABLE[$sort] ?? self::SORTABLE['newest'];
        $stmt = $this->db->prepare("
            SELECT g.game_id, g.name, g.host_name, g.status, g.max_players, g.current_players,
                   g.map_cols, g.map_rows, g.created_at, g.started_at
            FROM games g
            $where
            ORDER BY $orderBy, g.game_id DESC
            LIMIT ? OFFSET ?
        ");
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
