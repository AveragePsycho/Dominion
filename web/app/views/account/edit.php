<h1>Edit profile</h1>

<form method="post" action="<?= e(url('account/edit')) ?>" class="card form">
    <?= Csrf::field() ?>

    <label for="username">Username</label>
    <input id="username" name="username" type="text" value="<?= e(old('username', $user['username'])) ?>" required
           pattern="[A-Za-z0-9_]{3,20}" maxlength="20">
    <?= field_error('username') ?>

    <label for="email">Email</label>
    <input id="email" name="email" type="email" value="<?= e(old('email', $user['email'])) ?>" required maxlength="255">
    <?= field_error('email') ?>

    <label for="display_name">Display name</label>
    <input id="display_name" name="display_name" type="text" value="<?= e(old('display_name', $user['display_name'])) ?>" maxlength="50">
    <?= field_error('display_name') ?>

    <button type="submit">Save</button>
    <a href="<?= e(url('account')) ?>">Cancel</a>
</form>
