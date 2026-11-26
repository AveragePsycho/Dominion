<?php

/** Staff managing other members. Access is controlled by route permissions. */
class AdminMemberController
{
    private const PER_PAGE = 20;

    public function index(): void
    {
        $q = trim((string) ($_GET['q'] ?? ''));
        $sort = (string) ($_GET['sort'] ?? 'username');
        $dir = ($_GET['dir'] ?? 'asc') === 'desc' ? 'desc' : 'asc';
        $page = max(1, (int) ($_GET['page'] ?? 1));

        $result = (new User())->search($q, $sort, $dir, $page, self::PER_PAGE);

        view('admin/members/index', [
            'title'   => 'Members',
            'members' => $result['rows'],
            'total'   => $result['total'],
            'pages'   => max(1, (int) ceil($result['total'] / self::PER_PAGE)),
            'page'    => $page,
            'q'       => $q,
            'sort'    => in_array($sort, User::sortKeys(), true) ? $sort : 'username',
            'dir'     => $dir,
        ]);
    }

    public function show(): void
    {
        $member = $this->findOr404();
        view('admin/members/show', [
            'title'  => 'Member: ' . $member['username'],
            'member' => $member,
        ]);
    }

    public function edit(): void
    {
        $member = $this->findOr404();
        view('admin/members/edit', [
            'title'  => 'Edit member: ' . $member['username'],
            'member' => $member,
            'roles'  => (new Role())->all(),
            'isSelf' => (int) $member['user_id'] === Auth::id(),
        ]);
    }

    public function update(): void
    {
        $member = $this->findOr404();
        $id = (int) $member['user_id'];
        $users = new User();

        $username = trim((string) ($_POST['username'] ?? ''));
        $email = trim((string) ($_POST['email'] ?? ''));
        $displayName = trim((string) ($_POST['display_name'] ?? ''));
        $roleId = (int) ($_POST['role_id'] ?? $member['role_id']);
        $status = ($_POST['status'] ?? $member['status']) === 'disabled' ? 'disabled' : 'active';

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

        // Only holders of roles.assign may change roles.
        if (!Auth::can('roles.assign')) {
            $roleId = (int) $member['role_id'];
        }
        $newRole = (new Role())->find($roleId);
        if ($newRole === null) {
            $errors['role_id'] = 'Choose a valid role.';
        }

        // Staff can't lock themselves out from this page.
        if ($id === Auth::id()) {
            $roleId = (int) $member['role_id'];
            $status = $member['status'];
            $newRole = ['name' => $member['role_name']];
        }

        // Never leave the site without an active admin.
        $losingAdmin = $member['role_name'] === 'admin' && $member['status'] === 'active'
            && (($newRole['name'] ?? '') !== 'admin' || $status !== 'active');
        if ($losingAdmin && $users->countActiveAdmins() <= 1) {
            $errors['role_id'] = 'This is the last active admin, so their role and status cannot change.';
        }

        if ($errors) {
            back_with_errors('admin/members/edit', $errors, ['username', 'email', 'display_name'], ['id' => $id]);
        }

        $users->updateProfile($id, $username, $email, $displayName ?: $username);
        $users->updateRoleAndStatus($id, $roleId, $status);

        Session::flash('success', 'Member ' . $username . ' updated.');
        redirect('admin/members/show', ['id' => $id]);
    }

    public function destroy(): void
    {
        $member = $this->findOr404();
        $id = (int) $member['user_id'];
        $users = new User();

        if ($id === Auth::id()) {
            Session::flash('error', 'Use "My account" to delete your own account.');
            redirect('admin/members/show', ['id' => $id]);
        }
        if ($member['role_name'] === 'admin' && $member['status'] === 'active' && $users->countActiveAdmins() <= 1) {
            Session::flash('error', 'You cannot delete the last active admin.');
            redirect('admin/members/show', ['id' => $id]);
        }

        $users->delete($id);
        Session::flash('success', 'Member ' . $member['username'] . ' deleted.');
        redirect('admin/members');
    }

    private function findOr404(): array
    {
        $id = (int) ($_GET['id'] ?? $_POST['id'] ?? 0);
        $member = $id > 0 ? (new User())->findById($id) : null;
        if ($member === null) {
            http_response_code(404);
            view('errors/error', ['code' => 404, 'title' => 'Member not found']);
            exit;
        }
        return $member;
    }
}
