import { Component } from 'react';

/** Shows the error instead of a blank screen if a page crashes. Reset by changing `resetKey` (e.g. on navigation). */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" style={{ maxWidth: 560, margin: '40px auto' }}>
        <h2>Something went wrong</h2>
        <pre className="error" style={{ whiteSpace: 'pre-wrap' }}>{String(this.state.error.message || this.state.error)}</pre>
        <button className="primary" onClick={() => { location.hash = '/lobby'; }}>Back to lobby</button>
      </div>
    );
  }
}
