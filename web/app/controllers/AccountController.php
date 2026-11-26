<?php

/** A member managing their own account. */
class AccountController
{
    public function show(): void
    {
        view('account/show', ['title' => 'My account', 'user' => Auth::user()]);
    }

    public function edit(): void
    {
        view('account/edit', ['title' => 'Edit profile', 'user' => Auth::user()]);
    }

    public function update(): void
    {
        $id = Auth::id();
        $username = trim((string) ($_POST['username'] ?? ''));
        $email = trim((string) ($_POST['email'] ?? ''));
        $displayName = trim((string) ($_POST['display_name'] ?? ''));

        $users = new User();
        $errors = array_filter([
            'username'     => Validator::username($username),
            'email'        => Validator::email($email),
            'display_name' => Validator::displayName($displayName),
        ]);
        if (!isset($errors['username']) && $users->usernameTaken($username, $id)) {
            $errors['username'] = 'That username is taken.';
        }
        if (!isset($errors['email']) && $users->emailTaken($email, $id)) {
            $errors['email'] = 'An account with that email already exists.';
        }
        if ($errors) {
            back_with_errors('account/edit', $errors, ['username', 'email', 'display_name']);
        }

        $users->updateProfile($id, $username, $email, $displayName ?: $username);
        Session::flash('success', 'Profile updated.');
        redirect('account');
    }

    public function editPassword(): void
    {
        view('account/password', ['title' => 'Change password']);
    }

    public function updatePassword(): void
    {
        $user = Auth::user();
        $current = (string) ($_POST['current_password'] ?? '');
        $password = (string) ($_POST['password'] ?? '');
        $confirm = (string) ($_POST['password_confirm'] ?? '');

        $errors = [];
        if (!password_verify($current, $user['password_hash'])) {
            $errors['current_password'] = 'Current password is incorrect.';
        }
        if ($error = Validator::password($password, $confirm)) {
            $errors['password'] = $error;
        }
        if ($errors) {
            back_with_errors('account/password', $errors);
        }

        (new User())->updatePassword((int) $user['user_id'], $password);
        Session::regenerate();
        Session::flash('success', 'Password changed.');
        redirect('account');
    }

    public function confirmDelete(): void
    {
        view('account/delete', ['title' => 'Delete account']);
    }

    public function destroy(): void
    {
        $user = Auth::user();
        $users = new User();

        if (!password_verify((string) ($_POST['password'] ?? ''), $user['password_hash'])) {
            back_with_errors('account/delete', ['password' => 'Password is incorrect.']);
        }
        if ($user['role_name'] === 'admin' && $users->countActiveAdmins() <= 1) {
            Session::flash('error', 'You are the last admin. Make someone else an admin before deleting your account.');
            redirect('account');
        }

        $users->delete((int) $user['user_id']);
        Auth::logout();
        Session::flash('success', 'Your account has been deleted.');
        redirect('login');
    }
}
