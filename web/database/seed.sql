-- Seed data for local development.
-- Demo accounts all use the password: Password123!   (change or delete them before deploying)

INSERT INTO roles (role_id, name, description) VALUES
    (1, 'member',    'Regular player'),
    (2, 'moderator', 'Can view members and moderate games'),
    (3, 'admin',     'Full access')
ON DUPLICATE KEY UPDATE description = VALUES(description);

INSERT INTO permissions (perm_key, description) VALUES
    ('games.create',   'Create and host games'),
    ('games.moderate', 'Close or clean up other players\' games'),
    ('members.view',   'View the member list and member details'),
    ('members.edit',   'Edit other members\' profiles and status'),
    ('members.delete', 'Delete other members'),
    ('roles.assign',   'Change a member\'s role')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- member: games.create
-- moderator: games.create, games.moderate, members.view
-- admin: everything
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
JOIN permissions p
  ON (r.name = 'member'    AND p.perm_key IN ('games.create'))
  OR (r.name = 'moderator' AND p.perm_key IN ('games.create', 'games.moderate', 'members.view'))
  OR (r.name = 'admin');

INSERT IGNORE INTO users (username, email, password_hash, display_name, role_id) VALUES
    ('admin',     'admin@example.com',     '$2y$10$1CG4E/DXLpsu1NRU3b0C8.hRNpXkugkMxqPXJl/LLTrO14fsCFdMa', 'Admin',     3),
    ('moderator', 'moderator@example.com', '$2y$10$1CG4E/DXLpsu1NRU3b0C8.hRNpXkugkMxqPXJl/LLTrO14fsCFdMa', 'Moderator', 2),
    ('player1',   'player1@example.com',   '$2y$10$1CG4E/DXLpsu1NRU3b0C8.hRNpXkugkMxqPXJl/LLTrO14fsCFdMa', 'Player One', 1);

-- Sample games so the search page has something to show before the Node server writes real ones.
INSERT INTO games (name, host_user_id, host_name, status, max_players, current_players, map_cols, map_rows, started_at) VALUES
    ('Paradox Pit',        (SELECT user_id FROM users WHERE username = 'player1'), 'player1',   'lobby',   8, 3, 40, 30, NULL),
    ('Timeline Brawl',     (SELECT user_id FROM users WHERE username = 'admin'),   'admin',     'running', 4, 4, 30, 24, NOW()),
    ('Guest Skirmish',     NULL,                                                    'Guest 2',   'lobby',   6, 1, 30, 24, NULL),
    ('Anchor Wars 100%',   (SELECT user_id FROM users WHERE username = 'moderator'),'moderator', 'running', 8, 6, 50, 40, NOW()),
    ('Old Finished Match', (SELECT user_id FROM users WHERE username = 'player1'), 'player1',   'finished',4, 2, 30, 24, NOW());
