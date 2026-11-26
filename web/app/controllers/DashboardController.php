<?php

class DashboardController
{
    public function index(): void
    {
        $user = Auth::user();
        $permissions = (new Role())->permissionKeys((int) $user['role_id']);

        view('dashboard', [
            'title'       => 'Dashboard',
            'user'        => $user,
            'permissions' => $permissions,
        ]);
    }
}
