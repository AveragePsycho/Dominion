<h1>Welcome, <?= e($user['display_name'] ?: $user['username']) ?></h1>

<div class="card">
    <p>You are signed in as <strong><?= e($user['username']) ?></strong> with the role <span class="badge"><?= e($user['role_name']) ?></span>.</p>
    <?php if ($permissions): ?>
        <p>Your permissions: <?= e(implode(', ', $permissions)) ?></p>
    <?php endif; ?>
</div>

<div class="actions">
    <form method="post" action="<?= e(url('games/play')) ?>" class="inline">
        <?= Csrf::field() ?>
        <button type="submit">Start or join a game</button>
    </form>
    <a class="button secondary" href="<?= e(url('games')) ?>">Find a game</a>
    <a class="button secondary" href="<?= e(url('account')) ?>">My account</a>
    <?php if (Auth::can('members.view')): ?>
        <a class="button secondary" href="<?= e(url('admin/members')) ?>">Manage members</a>
    <?php endif; ?>
</div>
