<?php

class Role
{
    private PDO $db;

    public function __construct()
    {
        $this->db = Database::getInstance();
    }

    public function all(): array
    {
        $stmt = $this->db->prepare('SELECT role_id, name, description FROM roles ORDER BY role_id');
        $stmt->execute();
        return $stmt->fetchAll();
    }

    public function find(int $id): ?array
    {
        $stmt = $this->db->prepare('SELECT role_id, name, description FROM roles WHERE role_id = ?');
        $stmt->execute([$id]);
        return $stmt->fetch() ?: null;
    }

    public function findByName(string $name): ?array
    {
        $stmt = $this->db->prepare('SELECT role_id, name, description FROM roles WHERE name = ?');
        $stmt->execute([$name]);
        return $stmt->fetch() ?: null;
    }

    /** @return string[] permission keys granted to the role */
    public function permissionKeys(int $roleId): array
    {
        $stmt = $this->db->prepare('
            SELECT p.perm_key
            FROM role_permissions rp
            JOIN permissions p ON p.permission_id = rp.permission_id
            WHERE rp.role_id = ?
            ORDER BY p.perm_key
        ');
        $stmt->execute([$roleId]);
        return $stmt->fetchAll(PDO::FETCH_COLUMN);
    }
}
