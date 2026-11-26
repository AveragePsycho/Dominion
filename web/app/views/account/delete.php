<h1>Delete account</h1>

<form method="post" action="<?= e(url('account/delete')) ?>" class="card form">
    <?= Csrf::field() ?>
    <p>This permanently deletes your account and your game history. It cannot be undone.</p>

    <label for="password">Enter your password to confirm</label>
    <input id="password" name="password" type="password" required autocomplete="current-password">
    <?= field_error('password') ?>

    <button type="submit" class="danger">Delete my account</button>
    <a href="<?= e(url('account')) ?>">Cancel</a>
</form>
