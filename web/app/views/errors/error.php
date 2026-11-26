<h1><?= e($code) ?> · <?= e($title) ?></h1>

<div class="card">
    <?php if ($code === 403): ?>
        <p>Your account doesn't have permission to view this page.</p>
    <?php else: ?>
        <p>We couldn't find what you were looking for.</p>
    <?php endif; ?>
    <p><a href="<?= e(url('')) ?>">Back to the start</a></p>
</div>
