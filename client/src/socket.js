/**
 * Thin WebSocket wrapper: auto-reconnects with backoff, queues messages while
 * disconnected, and re-subscribes to watched games after a reconnect.
 */
export class GameSocket {
  constructor(token, onMessage, onStatus) {
    this.token = token;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.queue = [];
    this.watching = new Set();
    this.retries = 0;
    this.closed = false;
    this.connect();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.retries = 0;
      this.onStatus(true);
      for (const gameId of this.watching) this.raw({ type: 'watch_game', gameId });
      for (const msg of this.queue.splice(0)) this.raw(msg);
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = (e) => {
      this.onStatus(false);
      if (this.closed) return;
      if (e.code === 4001) return this.onMessage({ type: 'unauthorized' });
      const delay = Math.min(1000 * 2 ** this.retries++, 10_000);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  raw(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.raw(msg);
    else this.queue.push(msg);
  }

  watch(gameId) {
    this.watching.add(gameId);
    this.send({ type: 'watch_game', gameId });
  }

  unwatch(gameId) {
    this.watching.delete(gameId);
    this.send({ type: 'unwatch_game', gameId });
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws.close();
  }
}
