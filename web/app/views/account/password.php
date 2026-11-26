<h1>Change password</h1>

<form method="post" action="<?= e(url('account/password')) ?>" class="card form">
    <?= Csrf::field() ?>

    <label for="current_password">Current password</label>
    <input id="current_password" name="current_password" type="password" required autocomplete="current-password">
    <?= field_error('current_password') ?>

    <label for="password">New password</label>
    <input id="password" name="password" type="password" required minlength="8" maxlength="72" autocomplete="new-password">
    <?= field_error('password') ?>

    <label for="password_confirm">Confirm new password</label>
    <input id="password_confirm" name="password_confirm" type="password" required minlength="8" maxlength="72" autocomplete="new-password">

    <button type="submit">Change password</button>
    <a href="<?= e(url('account')) ?>">Cancel</a>
</form>
