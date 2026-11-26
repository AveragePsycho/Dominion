<?php

/**
 * Tiny front-controller router: index.php?url=<route>.
 *
 * Each route can carry middleware:
 *   'auth'        logged-in users only
 *   'guest'       logged-out visitors only (login, register)
 *   'perm:<key>'  logged in and holding that permission
 * Every POST route is CSRF-checked automatically.
 */
class Router
{
    private array $routes = [];

    public function get(string $url, string $controller, string $method, array $middleware = []): void
    {
        $this->add('GET', $url, $controller, $method, $middleware);
    }

    public function post(string $url, string $controller, string $method, array $middleware = []): void
    {
        $this->add('POST', $url, $controller, $method, $middleware);
    }

    private function add(string $verb, string $url, string $controller, string $method, array $middleware): void
    {
        $this->routes[$verb][trim($url, '/')] = compact('controller', 'method', 'middleware');
    }

    public function dispatch(): void
    {
        $url = trim((string) ($_GET['url'] ?? ''), '/');
        $verb = $_SERVER['REQUEST_METHOD'] ?? 'GET';

        $route = $this->routes[$verb][$url] ?? null;
        if ($route === null) {
            $this->abort(isset($this->routes[$verb === 'GET' ? 'POST' : 'GET'][$url]) ? 405 : 404);
            return;
        }

        if ($verb === 'POST' && !Csrf::verify($_POST['_csrf'] ?? null)) {
            Session::flash('error', 'Your form expired. Please try again.');
            redirect($url === '' ? 'dashboard' : $url);
        }

        foreach ($route['middleware'] as $rule) {
            if ($rule === 'auth' && !Auth::check()) {
                Session::flash('error', 'Please log in first.');
                redirect('login');
            }
            if ($rule === 'guest' && Auth::check()) {
                redirect('dashboard');
            }
            if (str_starts_with($rule, 'perm:')) {
                if (!Auth::check()) {
                    Session::flash('error', 'Please log in first.');
                    redirect('login');
                }
                if (!Auth::can(substr($rule, 5))) {
                    $this->abort(403);
                    return;
                }
            }
        }

        $controller = new $route['controller']();
        $controller->{$route['method']}();
    }

    private function abort(int $code): void
    {
        http_response_code($code);
        $titles = [403 => 'Access denied', 404 => 'Page not found', 405 => 'Method not allowed'];
        view('errors/error', ['code' => $code, 'title' => $titles[$code] ?? 'Error']);
    }
}
