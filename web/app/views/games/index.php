<?php
$query = fn (array $extra = []) => array_filter([
    'q'      => $filters['q'],
    'status' => $filters['status'],
    'open'   => $filters['open'] ? '1' : '',
    'sort'   => $filters['sort'],
] + $extra, fn ($v) => $v !== '' && $v !== null);
?>
<h1>Find a game</h1>

<form method="get" action="index.php" class="search">
    <input type="hidden" name="url" value="games">
    <input type="search" name="q" value="<?= e($filters['q']) ?>" placeholder="Game or host name" maxlength="60">

    <select name="status" aria-label="Status">
        <option value="" <?= $filters['status'] === '' ? 'selected' : '' ?>>Any active</option>
        <option value="lobby" <?= $filters['status'] === 'lobby' ? 'selected' : '' ?>>In lobby</option>
        <option value="running" <?= $filters['status'] === 'running' ? 'selected' : '' ?>>Running</option>
    </select>

    <select name="sort" aria-label="Sort by">
        <option value="newest" <?= $filters['sort'] === 'newest' ? 'selected' : '' ?>>Newest</option>
        <option value="name" <?= $filters['sort'] === 'name' ? 'selected' : '' ?>>Name</option>
        <option value="players" <?= $filters['sort'] === 'players' ? 'selected' : '' ?>>Most players</option>
        <option value="open" <?= $filters['sort'] === 'open' ? 'selected' : '' ?>>Most open slots</option>
    </select>

    <label class="checkbox"><input type="checkbox" name="open" value="1" <?= $filters['open'] ? 'checked' : '' ?>> Has open slots</label>

    <button type="submit">Search</button>
</form>

<p><?= e($total) ?> active game<?= $total === 1 ? '' : 's' ?> found.
    <?php if (!Auth::check()): ?>
        You're browsing as a guest. <a href="<?= e(url('login')) ?>">Log in</a> to keep your results.
    <?php endif; ?>
</p>

<table class="table">
    <thead>
    <tr><th>Game</th><th>Host</th><th>Status</th><th>Players</th><th>Map</th><th></th></tr>
    </thead>
    <tbody>
    <?php foreach ($games as $g): ?>
        <?php $full = (int) $g['current_players'] >= (int) $g['max_players']; ?>
        <tr>
            <td><?= e($g['name']) ?></td>
            <td><?= e($g['host_name']) ?></td>
            <td><span class="status status-<?= e($g['status']) ?>"><?= e($g['status'] === 'lobby' ? 'in lobby' : 'running') ?></span></td>
            <td><?= e($g['current_players']) ?> / <?= e($g['max_players']) ?></td>
            <td><?= $g['map_cols'] ? e($g['map_cols'] . '×' . $g['map_rows']) : '' ?></td>
            <td>
                <?php if ($g['status'] === 'lobby' && !$full): ?>
                    <form method="post" action="<?= e(url('games/play')) ?>" class="inline">
                        <?= Csrf::field() ?>
                        <input type="hidden" name="game_id" value="<?= e($g['game_id']) ?>">
                        <button type="submit">Join</button>
                    </form>
                <?php else: ?>
                    <span class="muted"><?= $full ? 'Full' : 'In progress' ?></span>
                <?php endif; ?>
            </td>
        </tr>
    <?php endforeach; ?>
    <?php if (!$games): ?>
        <tr><td colspan="6">No active games match your search.</td></tr>
    <?php endif; ?>
    </tbody>
</table>

<?php if ($pages > 1): ?>
    <nav class="pager">
        <?php for ($p = 1; $p <= $pages; $p++): ?>
            <?php if ($p === $filters['page']): ?>
                <strong><?= $p ?></strong>
            <?php else: ?>
                <a href="<?= e(url('games', $query(['page' => $p]))) ?>"><?= $p ?></a>
            <?php endif; ?>
        <?php endfor; ?>
    </nav>
<?php endif; ?>

<form method="post" action="<?= e(url('games/play')) ?>" class="inline">
    <?= Csrf::field() ?>
    <button type="submit" class="secondary">Start a new game</button>
</form>
