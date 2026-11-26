<?php $me = Auth::user(); ?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title><?= e(($title ?? '') !== '' ? $title . ' · ' : '') ?><?= e(Config::get('app_name', 'Dominion')) ?></title>
    <link rel="stylesheet" href="css/app.css">
</head>
<body>
<header class="topbar">
    <a class="brand" href="<?= e(url('')) ?>"><?= e(Config::get('app_name', 'Dominion')) ?></a>
    <nav>
        <a href="<?= e(url('games')) ?>">Find a game</a>
        <?php if ($me): ?>
            <a href="<?= e(url('dashboard')) ?>">Dashboard</a>
            <a href="<?= e(url('account')) ?>">My account</a>
            <?php if (Auth::can('members.view')): ?>
                <a href="<?= e(url('admin/members')) ?>">Members</a>
            <?php endif; ?>
            <form method="post" action="<?= e(url('logout')) ?>" class="inline">
                <?= Csrf::field() ?>
                <button type="submit" class="link">Log out (<?= e($me['username']) ?>)</button>
            </form>
        <?php else: ?>
            <a href="<?= e(url('login')) ?>">Log in</a>
            <a href="<?= e(url('register')) ?>">Sign up</a>
        <?php endif; ?>
    </nav>
</header>

<main class="container">
    <?php foreach (Session::takeFlashes() as $flash): ?>
        <div class="flash flash-<?= e($flash['type']) ?>"><?= e($flash['message']) ?></div>
    <?php endforeach; ?>

    <?= $content ?>
</main>
</body>
</html>
