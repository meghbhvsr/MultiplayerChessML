import { useState } from 'react';
import { api } from '../api.js';

export default function AuthPage({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(request) {
    setError('');
    setBusy(true);
    try {
      onAuth(await request());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e) {
    e.preventDefault();
    run(() => api(mode === 'login' ? '/login' : '/register', { method: 'POST', body: { username: username.trim(), password } }));
  }

  const playAsGuest = () => run(() => api('/guest', { method: 'POST' }));

  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <h1>♞ Chess</h1>
        <p className="muted">Play live chess against your friends.</p>

        <div className="tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Log in</button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>Sign up</button>
        </div>

        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
          {mode === 'register' && <span className="hint">3–20 characters: letters, numbers, _ . - (no spaces)</span>}
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
          />
        </label>

        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? '…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>

        <div className="divider"><span>or</span></div>
        <button type="button" onClick={playAsGuest} disabled={busy}>Play as guest</button>
        <span className="hint center-text">You'll get a guest ID like Guest_48213. Guests don't appear on the leaderboard.</span>
      </form>
    </div>
  );
}
