<?php

class AuthController
{
    public function home(): void
    {
        redirect(Auth::check() ? 'dashboard' : 'games');
    }

    public function showLogin(): void
    {
        view('auth/login', ['title' => 'Log in']);
    }

    public function authenticate(): void
    {
        $login = trim((string) ($_POST['login'] ?? ''));
        $password = (string) ($_POST['password'] ?? '');
        $ip = client_ip();
        $attempts = new LoginAttempt();

        if ($login === '' || $password === '') {
            back_with_errors('login', ['login' => 'Enter your username or email and password.'], ['login']);
        }

        if ($attempts->tooMany($login, $ip)) {
            Session::flash('error', 'Too many failed attempts. Please wait a few minutes and try again.');
            remember_input(['login']);
            redirect('login');
        }

        $users = new User();
        $user = $users->findByLogin($login);

        // Always run password_verify so response time doesn't reveal whether the user exists.
        $hash = $user['password_hash'] ?? '$2y$10$cytyY3LMid77PtCKvZyux.2GsbjoGPJV2A25oTIBQh55UHgtLRt8y';
        $valid = password_verify($password, $hash) && $user !== null;

        if (!$valid || $user['status'] !== 'active') {
            $attempts->record($login, $ip, false);
            // One generic message: don't reveal which part was wrong.
            Session::flash('error', 'Invalid username or password.');
            remember_input(['login']);
            redirect('login');
        }

        $attempts->record($login, $ip, true);
        $attempts->clear($login);
        $users->rehashIfNeeded($user, $password);
        $users->touchLastLogin((int) $user['user_id']);

        Auth::login($user);
        Session::flash('success', 'Welcome back, ' . ($user['display_name'] ?: $user['username']) . '!');
        redirect('dashboard');
    }

    public function showRegister(): void
    {
        view('auth/register', ['title' => 'Create account']);
    }

    public function register(): void
    {
        $username = trim((string) ($_POST['username'] ?? ''));
        $email = trim((string) ($_POST['email'] ?? ''));
        $displayName = trim((string) ($_POST['display_name'] ?? ''));
        $password = (string) ($_POST['password'] ?? '');
        $confirm = (string) ($_POST['password_confirm'] ?? '');

        $users = new User();
        $errors = array_filter([
            'username'     => Validator::username($username),
            'email'        => Validator::email($email),
            'display_name' => Validator::displayName($displayName),
            'password'     => Validator::password($password, $confirm),
        ]);

        if (!isset($errors['username']) && $users->usernameTaken($username)) {
            $errors['username'] = 'That username is taken.';
        }
        if (!isset($errors['email']) && $users->emailTaken($email)) {
            $errors['email'] = 'An account with that email already exists.';
        }

        if ($errors) {
            back_with_errors('register', $errors, ['username', 'email', 'display_name']);
        }

        $role = (new Role())->findByName('member');
        $id = $users->create($username, $email, $password, $displayName ?: $username, (int) $role['role_id']);

        Auth::login($users->findById($id));
        Session::flash('success', 'Account created. Welcome to Dominion!');
        redirect('dashboard');
    }

    public function logout(): void
    {
        Auth::logout();
        Session::flash('success', 'You have been logged out.');
        redirect('login');
    }
}
