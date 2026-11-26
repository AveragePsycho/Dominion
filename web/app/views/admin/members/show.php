<h1>Member: <?= e($member['username']) ?></h1>

<dl class="card details">
    <dt>User id</dt><dd><?= e($member['user_id']) ?></dd>
    <dt>Username</dt><dd><?= e($member['username']) ?></dd>
    <dt>Display name</dt><dd><?= e($member['display_name']) ?></dd>
    <dt>Email</dt><dd><?= e($member['email']) ?></dd>
    <dt>Role</dt><dd><span class="badge"><?= e($member['role_name']) ?></span></dd>
    <dt>Status</dt><dd><span class="status status-<?= e($member['status']) ?>"><?= e($member['status']) ?></span></dd>
    <dt>Joined</dt><dd><?= e($member['created_at']) ?></dd>
    <dt>Last updated</dt><dd><?= e($member['updated_at']) ?></dd>
    <dt>Last login</dt><dd><?= e($member['last_login_at'] ?? 'Never') ?></dd>
</dl>

<div class="actions">
    <a class="button secondary" href="<?= e(url('admin/members')) ?>">Back to members</a>
    <?php if (Auth::can('members.edit')): ?>
        <a class="button" href="<?= e(url('admin/members/edit', ['id' => $member['user_id']])) ?>">Edit</a>
    <?php endif; ?>
    <?php if (Auth::can('members.delete') && (int) $member['user_id'] !== Auth::id()): ?>
        <form method="post" action="<?= e(url('admin/members/delete')) ?>" class="inline"
              onsubmit="return confirm('Delete this member permanently?');">
            <?= Csrf::field() ?>
            <input type="hidden" name="id" value="<?= e($member['user_id']) ?>">
            <button type="submit" class="danger">Delete member</button>
        </form>
    <?php endif; ?>
</div>
