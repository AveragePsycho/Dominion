# Dominion web (PHP)

The PHP side of Dominion: accounts, sessions, roles and game search. The real-time game itself stays in the Node server at the repo root, and both share one MySQL database.

Built from the course's template MVC classes (Router, controllers, `User` model, PDO `Database`), extended with signup, account management, roles and permissions, CSRF protection and hardened cookie sessions.

## Setup

Requirements: PHP 8.1+ with `pdo_mysql`, and MySQL 8 (or MariaDB 10.6+). XAMPP works.

1. Create the database, tables and the app's database user:
   ```
   mysql -u root -p < web/database/schema.sql
   mysql -u root -p dominion < web/database/seed.sql
   ```
   Change the `dominion_app` password at the bottom of `schema.sql` first, or afterwards with `ALTER USER`.
2. Copy `web/config.example.php` to `web/config.php` and put in your database password. `config.php` is gitignored.
3. Run the site:
   ```
   php -S localhost:8000 -t web/public
   ```
   Then open http://localhost:8000. With XAMPP/Apache, point a virtual host's document root at `web/public` instead.
4. Run the game as before (`node server.js`, port 3000). The "Join" and "Start a new game" buttons send players there.

To reset the data, run `DROP DATABASE dominion;` and repeat step 1.

### Demo accounts (seed data)

All use the password `Password123!`. Delete or change them before deploying.

| Username | Role |
|---|---|
| admin | admin |
| moderator | moderator |
| player1 | member |

## Layout

```
web/
  public/index.php        front controller and route table
  public/css/app.css      placeholder styles (Bootstrap comes in phase two)
  app/core/               Config, Database, Router, Session, Auth, Csrf, Validator, helpers
  app/models/             User, Role, Game, GameTicket, LoginAttempt
  app/controllers/        Auth, Dashboard, Account, AdminMember, Game
  app/views/              templates rendered inside layout.php
  database/schema.sql     tables, keys and the least-privilege app user
  database/seed.sql       roles, permissions, demo users and sample games
  tests/smoke.sh          end-to-end test with curl
```

## How each phase one requirement is covered

- **SQL database:** `database/schema.sql`. InnoDB, utf8mb4, foreign keys, unique username and email, indexes for search.
- **Prepared statements:** every query uses `prepare()` and `execute()` with `?` placeholders, and emulated prepares are off (`app/core/Database.php`). ORDER BY columns come from whitelists in the models. Search terms have `%` and `_` escaped so they match literally.
- **Cookie sessions:** `app/core/Session.php`. The session id lives only in an HttpOnly, SameSite=Lax cookie (Secure on HTTPS), strict mode is on, the id is regenerated on login and password change, and sessions end after 30 minutes idle or 8 hours total. Logout destroys the session and expires the cookie.
- **Signup, login and Member CRUD:** register, log in with username or email, view and edit your profile, change your password (needs the current one), and delete your account (needs your password). Staff can list, search, sort, view, edit, disable and delete members.
- **Password hashing:** `password_hash(PASSWORD_DEFAULT)` on signup and change, `password_verify` on login, `password_needs_rehash` upgrades old hashes. Failed logins get one generic message, and a username is locked out for 15 minutes after 5 failures.
- **Roles and permissions:** `roles`, `permissions` and `role_permissions` tables. Routes declare `perm:<key>` middleware, views hide actions the user can't take, and `Auth::can()` reads permissions fresh from the database on every request, so changes and disabled accounts apply immediately. The last active admin can't be demoted, disabled or deleted.

  | Permission | member | moderator | admin |
  |---|---|---|---|
  | games.create | yes | yes | yes |
  | games.moderate | | yes | yes |
  | members.view | | yes | yes |
  | members.edit | | | yes |
  | members.delete | | | yes |
  | roles.assign | | | yes |

- **Search over active games:** `index.php?url=games`, open to guests too. Search by game or host name, filter by lobby or running and by open slots, sort, and page through results. The same search is available as JSON at `index.php?url=api/games`.
- **Other hardening:** CSRF token on every POST (checked in the Router), all output escaped with `e()`, logout is a POST, and security headers are sent from `index.php`.

## Game server handoff (step 8, not wired up yet)

When a logged-in player clicks Join or Start, PHP stores a random 64-character token in `game_tickets` (valid for 60 seconds) and redirects to `http://localhost:3000/?game=<id>&ticket=<token>`. Guests are redirected without a ticket and will play as "Guest N".

The Node server still needs to:

1. Read `ticket` from the page URL and pass it in the Socket.IO handshake: `io({ auth: { ticket } })`.
2. On connection, run `SELECT user_id FROM game_tickets WHERE token = ? AND used_at IS NULL AND expires_at > NOW()`, then `UPDATE game_tickets SET used_at = NOW() WHERE token = ?`, and load the username. No ticket means a guest.
3. Keep `games` and `game_players` up to date as games are created, joined, started and finished, so they show up in search.
4. Support more than one game at a time (today `server.js` runs a single global game).

The `games` table currently holds sample rows from `seed.sql`.

## Testing

`tests/smoke.sh` runs 39 checks against a freshly seeded database: search and filters, SQL injection strings, cookie flags, signup validation, XSS escaping, CSRF rejection, profile and password changes, login and logout, game tickets, role permissions, the last-admin guard and login throttling.

```
php -S 127.0.0.1:8000 -t web/public &
bash web/tests/smoke.sh
```

It needs bash, curl and the `mysql` client (Git Bash works on Windows). It changes data, so reset the database afterwards.
