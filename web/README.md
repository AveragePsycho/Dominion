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
4. Install the game's packages (this adds `mysql2`) and start it: `npm install`, then `node server.js` on port 3000. Set `DB_PASSWORD` (see below) if you changed the app user's password.

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

## Game server (Node) and how it connects

The game server at the repo root now runs any number of matches at once, each in its own Socket.IO room, and talks to the same MySQL database.

- **Joining from the site:** Join sends a player to `http://localhost:3000/?game=<id>`, and "Start a new game" to `?new=1`. Logged-in players also get `&ticket=<token>`, a random single-use token from `game_tickets` that expires after 60 seconds. The client passes these in the Socket.IO handshake and removes the ticket from the address bar.
- **Who is playing:** the server redeems the ticket with one `UPDATE ... WHERE token = ? AND used_at IS NULL AND expires_at > NOW()`, so it works exactly once, then shows the player's display name. No ticket (or a used one) means a guest, shown as "Guest N".
- **Live search:** the server creates a `games` row for each match and keeps its status, host, player count and map size current. Registered players get a `game_players` row with their result (playing, won, lost or left). When everyone leaves, the match is marked finished and drops out of search. On startup, rows left open by a previous run are closed.
- **Opening the game directly** (no `game` or `new`) joins the first open lobby, as before.
- **Without a database** (mysql2 not installed, `DB_DISABLED=1`, or MySQL down) the game still works with guests only.

Database settings come from environment variables, with defaults matching `config.example.php`:

```
DB_HOST=localhost DB_PORT=3306 DB_NAME=dominion DB_USER=dominion_app DB_PASSWORD=change-me
```

On Windows PowerShell: `$env:DB_PASSWORD="your-password"; node server.js`.

## Testing

- `npm test` runs the game's Jest tests (55), including the multiple-games tests in `tests/multigame.test.js`.
- `npm run test:integration` runs 20 end-to-end checks with real socket clients against the running game server, PHP site and MySQL: tickets, guests, separate rooms, live search, match start, results and cleanup. Start from a freshly seeded database.
- `web/tests/smoke.sh` runs 39 checks on the PHP site against a freshly seeded database (with the game server stopped, since it closes the sample games): search and filters, SQL injection strings, cookie flags, signup validation, XSS escaping, CSRF rejection, profile and password changes, login and logout, game tickets, role permissions, the last-admin guard and login throttling.

```
php -S 127.0.0.1:8000 -t web/public &
bash web/tests/smoke.sh
```

It needs bash, curl and the `mysql` client (Git Bash works on Windows). It changes data, so reset the database afterwards.
