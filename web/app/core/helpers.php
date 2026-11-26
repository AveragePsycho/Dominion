<?php

/** Escape text for HTML output. Use for every value that reaches a page. */
function e($value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** Build an app URL: url('admin/members', ['page' => 2]). */
function url(string $route = '', array $params = []): string
{
    $query = $route === '' ? $params : ['url' => $route] + $params;
    return 'index.php' . ($query ? '?' . http_build_query($query) : '');
}

function redirect(string $route, array $params = []): never
{
    header('Location: ' . url($route, $params));
    exit;
}

/** Render a view inside the shared layout. */
function view(string $name, array $data = []): void
{
    $viewFile = APP_PATH . '/views/' . $name . '.php';
    extract($data, EXTR_SKIP);

    ob_start();
    require $viewFile;
    $content = ob_get_clean();

    require APP_PATH . '/views/layout.php';
}

/** Remember submitted form values (never passwords) for one redisplay. */
function remember_input(array $fields): void
{
    $old = [];
    foreach ($fields as $field) {
        $old[$field] = (string) ($_POST[$field] ?? '');
    }
    Session::set('_old', $old);
}

function old(string $field, string $default = ''): string
{
    static $old = null;
    if ($old === null) {
        $old = Session::get('_old', []);
        Session::forget('_old');
    }
    return $old[$field] ?? $default;
}

/** Validation errors from the previous request, keyed by field. */
function errors(): array
{
    static $errors = null;
    if ($errors === null) {
        $errors = Session::get('_errors', []);
        Session::forget('_errors');
    }
    return $errors;
}

function field_error(string $field): string
{
    $errs = errors();
    return isset($errs[$field]) ? '<p class="field-error">' . e($errs[$field]) . '</p>' : '';
}

function back_with_errors(string $route, array $errors, array $fields = [], array $params = []): never
{
    Session::set('_errors', $errors);
    remember_input($fields);
    redirect($route, $params);
}

function client_ip(): string
{
    return substr((string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'), 0, 45);
}

/** Escape LIKE wildcards so a search for "100%" matches the literal text. */
function like_escape(string $term): string
{
    return addcslashes($term, '\\%_');
}
