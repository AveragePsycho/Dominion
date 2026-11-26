<?php
$sortLink = function (string $key, string $label) use ($q, $sort, $dir): string {
    $nextDir = ($sort === $key && $dir === 'asc') ? 'desc' : 'asc';
    $arrow = $sort === $key ? ($dir === 'asc' ? ' ▲' : ' ▼') : '';
    return '<a href="' . e(url('admin/members', ['q' => $q, 'sort' => $key, 'dir' => $nextDir])) . '">' . e($label) . $arrow . '</a>';
};
?>
<h1>Members</h1>

<form method="get" action="index.php" class="search">
    <input type="hidden" name="url" value="admin/members">
    <input type="search" name="q" value="<?= e($q) ?>" placeholder="Search username, email or name" maxlength="100">
    <button type="submit">Search</button>
    <?php if ($q !== ''): ?><a href="<?= e(url('admin/members')) ?>">Clear</a><?php endif; ?>
</form>

<p><?= e($total) ?> member<?= $total === 1 ? '' : 's' ?> found.</p>

<table class="table">
    <thead>
    <tr>
        <th><?= $sortLink('username', 'Username') ?></th>
        <th><?= $sortLink('email', 'Email') ?></th>
        <th><?= $sortLink('role', 'Role') ?></th>
        <th><?= $sortLink('status', 'Status') ?></th>
        <th><?= $sortLink('created', 'Joined') ?></th>
        <th><?= $sortLink('last_login', 'Last login') ?></th>
        <th></th>
    </tr>
    </thead>
    <tbody>
    <?php foreach ($members as $m): ?>
        <tr>
            <td><?= e($m['username']) ?></td>
            <td><?= e($m['email']) ?></td>
            <td><span class="badge"><?= e($m['role_name']) ?></span></td>
            <td><span class="status status-<?= e($m['status']) ?>"><?= e($m['status']) ?></span></td>
            <td><?= e(substr((string) $m['created_at'], 0, 10)) ?></td>
            <td><?= e($m['last_login_at'] ? substr($m['last_login_at'], 0, 16) : 'Never') ?></td>
            <td class="row-actions">
                <a href="<?= e(url('admin/members/show', ['id' => $m['user_id']])) ?>">View</a>
                <?php if (Auth::can('members.edit')): ?>
                    <a href="<?= e(url('admin/members/edit', ['id' => $m['user_id']])) ?>">Edit</a>
                <?php endif; ?>
            </td>
        </tr>
    <?php endforeach; ?>
    <?php if (!$members): ?>
        <tr><td colspan="7">No members match your search.</td></tr>
    <?php endif; ?>
    </tbody>
</table>

<?php if ($pages > 1): ?>
    <nav class="pager">
        <?php for ($p = 1; $p <= $pages; $p++): ?>
            <?php if ($p === $page): ?>
                <strong><?= $p ?></strong>
            <?php else: ?>
                <a href="<?= e(url('admin/members', ['q' => $q, 'sort' => $sort, 'dir' => $dir, 'page' => $p])) ?>"><?= $p ?></a>
            <?php endif; ?>
        <?php endfor; ?>
    </nav>
<?php endif; ?>
