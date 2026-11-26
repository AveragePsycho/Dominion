<h1>Create an account</h1>

<form method="post" action="<?= e(url('register')) ?>" class="card form">
    <?= Csrf::field() ?>

    <label for="username">Username</label>
    <input id="username" name="username" type="text" value="<?= e(old('username')) ?>" required
           pattern="[A-Za-z0-9_]{3,20}" maxlength="20" autocomplete="username">
    <small>3 to 20 letters, numbers or underscores.</small>
    <?= field_error('username') ?>

    <label for="email">Email</label>
    <input id="email" name="email" type="email" value="<?= e(old('email')) ?>" required maxlength="255" autocomplete="email">
    <?= field_error('email') ?>

    <label for="display_name">Display name <small>(optional)</small></label>
    <input id="display_name" name="display_name" type="text" value="<?= e(old('display_name')) ?>" maxlength="50">
    <?= field_error('display_name') ?>

    <label for="password">Password</label>
    <input id="password" name="password" type="password" required minlength="8" maxlength="72" autocomplete="new-password">
    <?= field_error('password') ?>

    <label for="password_confirm">Confirm password</label>
    <input id="password_confirm" name="password_confirm" type="password" required minlength="8" maxlength="72" autocomplete="new-password">

    <button type="submit">Create account</button>
</form>

<p>Already have an account? <a href="<?= e(url('login')) ?>">Log in</a>.</p>
