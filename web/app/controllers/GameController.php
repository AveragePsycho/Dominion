<?php

/** Searching active games and joining them. Open to guests and members. */
class GameController
{
    private const PER_PAGE = 15;

    public function index(): void
    {
        $filters = $this->filters();
        $result = (new Game())->searchActive(
            $filters['q'], $filters['status'], $filters['open'], $filters['sort'], $filters['page'], self::PER_PAGE
        );

        view('games/index', [
            'title'   => 'Find a game',
            'games'   => $result['rows'],
            'total'   => $result['total'],
            'pages'   => max(1, (int) ceil($result['total'] / self::PER_PAGE)),
            'filters' => $filters,
        ]);
    }

    /** Same search as JSON, for live refresh or other clients. */
    public function api(): void
    {
        $filters = $this->filters();
        $result = (new Game())->searchActive(
            $filters['q'], $filters['status'], $filters['open'], $filters['sort'], $filters['page'], self::PER_PAGE
        );

        header('Content-Type: application/json; charset=utf-8');
        echo json_encode([
            'total' => $result['total'],
            'page'  => $filters['page'],
            'games' => array_map(fn ($g) => [
                'id'              => (int) $g['game_id'],
                'name'            => $g['name'],
                'host'            => $g['host_name'],
                'status'          => $g['status'],
                'current_players' => (int) $g['current_players'],
                'max_players'     => (int) $g['max_players'],
            ], $result['rows']),
        ]);
    }

    /**
     * Send the player to the game server.
     * Logged-in members get a single-use ticket; guests go straight in as "Guest N".
     */
    public function play(): void
    {
        $gameId = (int) ($_POST['game_id'] ?? 0) ?: null;
        if ($gameId !== null && (new Game())->find($gameId) === null) {
            Session::flash('error', 'That game no longer exists.');
            redirect('games');
        }

        $params = [];
        if ($gameId !== null) {
            $params['game'] = $gameId;
        }
        if (Auth::check()) {
            $params['ticket'] = (new GameTicket())->issue(Auth::id(), $gameId);
        }

        $target = rtrim((string) Config::get('game_url'), '/') . '/';
        header('Location: ' . $target . ($params ? '?' . http_build_query($params) : ''));
        exit;
    }

    private function filters(): array
    {
        $status = (string) ($_GET['status'] ?? '');
        $sort = (string) ($_GET['sort'] ?? 'newest');

        return [
            'q'      => mb_substr(trim((string) ($_GET['q'] ?? '')), 0, 60),
            'status' => in_array($status, ['lobby', 'running'], true) ? $status : '',
            'open'   => !empty($_GET['open']),
            'sort'   => in_array($sort, Game::sortKeys(), true) ? $sort : 'newest',
            'page'   => max(1, (int) ($_GET['page'] ?? 1)),
        ];
    }
}
