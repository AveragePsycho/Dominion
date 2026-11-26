<h1>Edit member: <?= e($member['username']) ?></h1>

<form method="post" action="<?= e(url('admin/members/edit', ['id' => $member['user_id']])) ?>" class="card form">
    <?= Csrf::field() ?>
    <input type="hidden" name="id" value="<?= e($member['user_id']) ?>">

    <label for="username">Username</label>
    <input id="username" name="username" type="text" value="<?= e(old('username', $member['username'])) ?>" required
           pattern="[A-Za-z0-9_]{3,20}" maxlength="20">
    <?= field_error('username') ?>

    <label for="email">Email</label>
    <input id="email" name="email" type="email" value="<?= e(old('email', $member['email'])) ?>" required maxlength="255">
    <?= field_error('email') ?>

    <label for="display_name">Display name</label>
    <input id="display_name" name="display_name" type="text" value="<?= e(old('display_name', $member['display_name'])) ?>" maxlength="50">
    <?= field_error('display_name') ?>

    <?php if ($isSelf): ?>
        <p class="note">You can't change your own role or status here.</p>
    <?php else: ?>
        <label for="role_id">Role</label>
        <select id="role_id" name="role_id" <?= Auth::can('roles.assign') ? '' : 'disabled' ?>>
            <?php foreach ($roles as $role): ?>
                <option value="<?= e($role['role_id']) ?>" <?= (int) $role['role_id'] === (int) $member['role_id'] ? 'selected' : '' ?>>
                    <?= e($role['name']) ?>
                </option>
            <?php endforeach; ?>
        </select>
        <?php if (!Auth::can('roles.assign')): ?><small>Only admins can change roles.</small><?php endif; ?>
        <?= field_error('role_id') ?>

        <label for="status">Status</label>
        <select id="status" name="status">
            <option value="active" <?= $member['status'] === 'active' ? 'selected' : '' ?>>active</option>
            <option value="disabled" <?= $member['status'] === 'disabled' ? 'selected' : '' ?>>disabled</option>
        </select>
    <?php endif; ?>

    <button type="submit">Save changes</button>
    <a href="<?= e(url('admin/members/show', ['id' => $member['user_id']])) ?>">Cancel</a>
</form>
