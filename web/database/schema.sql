-- Dominion web schema (MySQL 8 / MariaDB 10.6+)
-- Run once:  mysql -u root -p < web/database/schema.sql
-- Then:      mysql -u root -p dominion < web/database/seed.sql

CREATE DATABASE IF NOT EXISTS dominion
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE dominion;

-- ---------------------------------------------------------------------
-- Roles and permissions
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
    role_id     TINYINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name        VARCHAR(30)  NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    PRIMARY KEY (role_id),
    UNIQUE KEY uq_roles_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS permissions (
    permission_id SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
    perm_key      VARCHAR(50)  NOT NULL,
    description   VARCHAR(255) NOT NULL DEFAULT '',
    PRIMARY KEY (permission_id),
    UNIQUE KEY uq_permissions_key (perm_key)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id       TINYINT UNSIGNED  NOT NULL,
    permission_id SMALLINT UNSIGNED NOT NULL,
    PRIMARY KEY (role_id, permission_id),
    CONSTRAINT fk_rp_role FOREIGN KEY (role_id)
        REFERENCES roles (role_id) ON DELETE CASCADE,
    CONSTRAINT fk_rp_permission FOREIGN KEY (permission_id)
        REFERENCES permissions (permission_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Users (members)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    user_id       INT UNSIGNED NOT NULL AUTO_INCREMENT,
    username      VARCHAR(20)  NOT NULL,
    email         VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name  VARCHAR(50)  NOT NULL DEFAULT '',
    role_id       TINYINT UNSIGNED NOT NULL,
    status        ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_login_at DATETIME NULL,
    PRIMARY KEY (user_id),
    UNIQUE KEY uq_users_username (username),
    UNIQUE KEY uq_users_email (email),
    KEY ix_users_role (role_id),
    CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles (role_id)
) ENGINE=InnoDB;

-- Failed and successful login attempts, used for simple throttling.
CREATE TABLE IF NOT EXISTS login_attempts (
    attempt_id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username     VARCHAR(255) NOT NULL,
    ip_address   VARCHAR(45)  NOT NULL,
    success      TINYINT(1)   NOT NULL DEFAULT 0,
    attempted_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (attempt_id),
    KEY ix_attempts_user_time (username, attempted_at),
    KEY ix_attempts_ip_time (ip_address, attempted_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Games (written by the Node game server, read by the PHP site)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS games (
    game_id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name            VARCHAR(60)  NOT NULL,
    host_user_id    INT UNSIGNED NULL,           -- NULL when hosted by a guest
    host_name       VARCHAR(50)  NOT NULL,       -- username or "Guest N"
    status          ENUM('lobby', 'running', 'finished') NOT NULL DEFAULT 'lobby',
    max_players     TINYINT UNSIGNED NOT NULL DEFAULT 8,
    current_players TINYINT UNSIGNED NOT NULL DEFAULT 0,
    map_cols        SMALLINT UNSIGNED NULL,
    map_rows        SMALLINT UNSIGNED NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at      DATETIME NULL,
    ended_at        DATETIME NULL,
    PRIMARY KEY (game_id),
    KEY ix_games_status (status),
    KEY ix_games_name (name),
    CONSTRAINT fk_games_host FOREIGN KEY (host_user_id)
        REFERENCES users (user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Registered players in a game. Guests are counted in games.current_players only.
CREATE TABLE IF NOT EXISTS game_players (
    game_id   INT UNSIGNED NOT NULL,
    user_id   INT UNSIGNED NOT NULL,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    result    ENUM('playing', 'won', 'lost', 'left') NOT NULL DEFAULT 'playing',
    PRIMARY KEY (game_id, user_id),
    KEY ix_gp_user (user_id),
    CONSTRAINT fk_gp_game FOREIGN KEY (game_id) REFERENCES games (game_id) ON DELETE CASCADE,
    CONSTRAINT fk_gp_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Single-use tickets that hand a logged-in PHP user over to the Node game server.
CREATE TABLE IF NOT EXISTS game_tickets (
    token      CHAR(64)     NOT NULL,            -- hex of 32 random bytes
    user_id    INT UNSIGNED NOT NULL,
    game_id    INT UNSIGNED NULL,
    expires_at DATETIME     NOT NULL,
    used_at    DATETIME     NULL,
    PRIMARY KEY (token),
    KEY ix_tickets_user (user_id),
    CONSTRAINT fk_tickets_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
    CONSTRAINT fk_tickets_game FOREIGN KEY (game_id) REFERENCES games (game_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Application database user (least privilege). Change the password!
-- ---------------------------------------------------------------------
CREATE USER IF NOT EXISTS 'dominion_app'@'localhost' IDENTIFIED BY 'change-me';
GRANT SELECT, INSERT, UPDATE, DELETE ON dominion.* TO 'dominion_app'@'localhost';
