import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken, setToken, clearToken, navigate } from './api.js';
import { GameSocket } from './socket.js';
import AuthPage from './components/AuthPage.jsx';
import Lobby from './components/Lobby.jsx';
import GameView from './components/GameView.jsx';
import History from './components/History.jsx';
import Leaderboard from './components/Leaderboard.jsx';
import Replay from './components/Replay.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

/** Routes live in the URL hash: #/lobby, #/game/12, #/replay/12, #/history, #/leaderboard */
function parseHash() {
  const [, name, id] = location.hash.replace(/^#\/?/, '/').split('/');
  return { name: name || 'lobby', id: id ? Number(id) : null };
}

export default function App() {
  const [token, setTok] = useState(getToken);
  const [user, setUser] = useState(null);
  const [route, setRoute] = useState(parseHash);
  const [connected, setConnected] = useState(false);
  const [openGames, setOpenGames] = useState([]);
  const [online, setOnline] = useState([]);
  const [games, setGames] = useState({});
  const [chats, setChats] = useState({});
  const [toast, setToast] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0); // bump to refetch stats/history
  const [socket, setSocket] = useState(null);
  const gamesRef = useRef(games);
  gamesRef.current = games;

  const logout = useCallback(() => {
    clearToken();
    setTok(null);
    setUser(null);
    setGames({});
    setChats({});
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!token) return;
    api('/me').then(setUser).catch((e) => e.status === 401 && logout());
  }, [token, refreshKey, logout]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const handleMessage = useRef();
  handleMessage.current = (msg) => {
    switch (msg.type) {
      case 'lobby':
        setOpenGames(msg.openGames);
        break;
      case 'online':
        setOnline(msg.users);
        break;
      case 'game_state': {
        const g = msg.game;
        if (gamesRef.current[g.id]?.status !== g.status) setRefreshKey((k) => k + 1);
        setGames((prev) => ({ ...prev, [g.id]: g }));
        break;
      }
      case 'game_created':
      case 'game_started':
        navigate(`/game/${msg.gameId}`);
        setRefreshKey((k) => k + 1);
        break;
      case 'chat':
        setChats((prev) => ({ ...prev, [msg.gameId]: [...(prev[msg.gameId] ?? []), msg].slice(-200) }));
        break;
      case 'error':
        setToast(msg.message);
        break;
      case 'unauthorized':
        logout();
        break;
    }
  };

  useEffect(() => {
    if (!token) return;
    const s = new GameSocket(token, (m) => handleMessage.current(m), setConnected);
    setSocket(s);
    return () => s.close();
  }, [token]);

  function onAuth({ token, user }) {
    setToken(token);
    setTok(token);
    setUser(user);
  }

  if (!token) return <AuthPage onAuth={onAuth} />;
  if (!user || !socket) return <div className="center muted">Loading…</div>;

  const navItems = [['lobby', 'Lobby'], ['history', 'History'], ['leaderboard', 'Leaderboard']];

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/lobby">♞ Chess</a>
        <nav>
          {navItems.map(([key, label]) => (
            <a key={key} href={`#/${key}`} className={route.name === key ? 'active' : ''}>{label}</a>
          ))}
        </nav>
        <div className="me">
          <span className={`dot ${connected ? 'on' : 'off'}`} title={connected ? 'Connected' : 'Reconnecting…'} />
          <strong>{user.username}</strong>
          {user.isGuest ? <span className="tag">guest</span> : <span className="rating">{user.rating}</span>}
          <button
            className="ghost"
            onClick={() => (!user.isGuest || confirm('Log out of this guest account? You won\'t be able to log back in to it.')) && logout()}
          >
            Log out
          </button>
        </div>
      </header>

      <main>
        <ErrorBoundary resetKey={`${route.name}/${route.id}`}>
        {route.name === 'lobby' && (
          <Lobby user={user} socket={socket} openGames={openGames} online={online} refreshKey={refreshKey} />
        )}
        {route.name === 'game' && route.id && (
          <GameView
            key={route.id}
            id={route.id}
            user={user}
            socket={socket}
            game={games[route.id]}
            chat={chats[route.id] ?? []}
          />
        )}
        {route.name === 'replay' && route.id && <Replay key={route.id} id={route.id} user={user} />}
        {route.name === 'history' && <History user={user} refreshKey={refreshKey} />}
        {route.name === 'leaderboard' && <Leaderboard user={user} refreshKey={refreshKey} />}
        </ErrorBoundary>
      </main>

      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}
