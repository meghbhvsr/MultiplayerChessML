import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiRouter } from './routes.js';
import { attachRealtime } from './realtime.js';

const PORT = Number(process.env.PORT) || 3001;
const dir = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use('/api', apiRouter);

// In production, serve the built React app from the same origin.
const dist = path.join(dir, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const server = http.createServer(app);
attachRealtime(server);

server.listen(PORT, () => {
  console.log(`Chess server listening on http://localhost:${PORT}`);
});
