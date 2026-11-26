<?php
declare(strict_types=1);

// Front controller: every request comes through here (index.php?url=...).

define('APP_PATH', dirname(__DIR__) . '/app');

require APP_PATH . '/core/helpers.php';

spl_autoload_register(function (string $class): void {
    foreach (['core', 'models', 'controllers'] as $dir) {
        $file = APP_PATH . "/$dir/$class.php";
        if (is_file($file)) {
            require $file;
            return;
        }
    }
});

Config::load(dirname(__DIR__) . '/config.php');

// Basic hardening headers.
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: same-origin');

Session::start();

$router = new Router();

// Public
$router->get('', AuthController::class, 'home');
$router->get('games', GameController::class, 'index');
$router->get('api/games', GameController::class, 'api');
$router->post('games/play', GameController::class, 'play');

// Logged-out visitors
$router->get('login', AuthController::class, 'showLogin', ['guest']);
$router->post('login', AuthController::class, 'authenticate', ['guest']);
$router->get('register', AuthController::class, 'showRegister', ['guest']);
$router->post('register', AuthController::class, 'register', ['guest']);

// Logged-in members
$router->post('logout', AuthController::class, 'logout', ['auth']);
$router->get('dashboard', DashboardController::class, 'index', ['auth']);
$router->get('account', AccountController::class, 'show', ['auth']);
$router->get('account/edit', AccountController::class, 'edit', ['auth']);
$router->post('account/edit', AccountController::class, 'update', ['auth']);
$router->get('account/password', AccountController::class, 'editPassword', ['auth']);
$router->post('account/password', AccountController::class, 'updatePassword', ['auth']);
$router->get('account/delete', AccountController::class, 'confirmDelete', ['auth']);
$router->post('account/delete', AccountController::class, 'destroy', ['auth']);

// Staff
$router->get('admin/members', AdminMemberController::class, 'index', ['perm:members.view']);
$router->get('admin/members/show', AdminMemberController::class, 'show', ['perm:members.view']);
$router->get('admin/members/edit', AdminMemberController::class, 'edit', ['perm:members.edit']);
$router->post('admin/members/edit', AdminMemberController::class, 'update', ['perm:members.edit']);
$router->post('admin/members/delete', AdminMemberController::class, 'destroy', ['perm:members.delete']);

$router->dispatch();
