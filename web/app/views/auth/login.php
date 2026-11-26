<h1>Log in</h1>

<form method="post" action="<?= e(url('login')) ?>" class="card form">
    <?= Csrf::field() ?>

    <label for="login">Username or email</label>
    <input id="login" name="login" type="text" value="<?= e(old('login')) ?>" required autofocus autocomplete="username">
    <?= field_error('login') ?>

    <label for="password">Password</label>
    <input id="password" name="password" type="password" required autocomplete="current-password">

    <button type="submit">Log in</button>
</form>

<p>No account yet? <a href="<?= e(url('register')) ?>">Sign up</a>, or <a href="<?= e(url('games')) ?>">play as a guest</a>.</p>
