<h1>My account</h1>

<dl class="card details">
    <dt>Username</dt><dd><?= e($user['username']) ?></dd>
    <dt>Display name</dt><dd><?= e($user['display_name']) ?></dd>
    <dt>Email</dt><dd><?= e($user['email']) ?></dd>
    <dt>Role</dt><dd><span class="badge"><?= e($user['role_name']) ?></span></dd>
    <dt>Member since</dt><dd><?= e($user['created_at']) ?></dd>
    <dt>Last login</dt><dd><?= e($user['last_login_at'] ?? 'Never') ?></dd>
</dl>

<div class="actions">
    <a class="button" href="<?= e(url('account/edit')) ?>">Edit profile</a>
    <a class="button secondary" href="<?= e(url('account/password')) ?>">Change password</a>
    <a class="button danger" href="<?= e(url('account/delete')) ?>">Delete account</a>
</div>
