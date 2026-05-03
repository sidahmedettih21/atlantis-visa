#!/usr/bin/env node
// Atlantis-Visa — Commander Dashboard v2.0
// Secure, efficient, real-time

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.COMMANDER_PORT || '9000', 10);
const AUTH_TOKEN = process.env.COMMANDER_AUTH; // Set this or dashboard is wide open

const BASE_DIR = process.env.ATLANTIS_HOME || path.join(os.homedir(), 'atlantis-visa');
const LOG_DIR = path.join(BASE_DIR, 'logs');
const SCREENSHOT_DIR = path.join(LOG_DIR, 'screenshots');
const LOCK_TMP = os.tmpdir();
const LOCK_PREFIX = 'atlantis-soldier-';

const app = express();
const server = http.createServer(app);

// ── Auth middleware ──────────────────────────────────────────────────────────
if (AUTH_TOKEN) {
  app.use((req, res, next) => {
    const tok = req.headers['x-auth-token'] || req.query.token;
    if (tok !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(SCREENSHOT_DIR));

// ── Efficient tail (read from end, not beginning) ────────────────────────────
function readLastLines(filePath, maxLines = 200) {
  if (!fs.existsSync(filePath)) return [];
  const stats = fs.statSync(filePath);
  if (stats.size === 0) return [];
  const fd = fs.openSync(filePath, 'r');
  const bufSize = 8192;
  let pos = stats.size;
  let lines = [];
  let leftover = '';
  while (pos > 0 && lines.length < maxLines) {
    const chunk = Math.min(bufSize, pos);
    pos -= chunk;
    const buf = Buffer.alloc(chunk);
    fs.readSync(fd, buf, 0, chunk, pos);
    const str = buf.toString('utf8') + leftover;
    const parts = str.split('\n');
    leftover = parts.shift(); // incomplete line
    lines.unshift(...parts.filter(Boolean));
  }
  fs.closeSync(fd);
  return lines.slice(-maxLines).map(l => {
    try { return JSON.parse(l); } catch { return { raw: l }; }
  });
}

function latestBotLog() {
  if (!fs.existsSync(LOG_DIR)) return null;
  const files = fs.readdirSync(LOG_DIR)
    .filter(f => f.startsWith('bot_') && f.endsWith('.log'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(LOG_DIR, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(LOG_DIR, files[0].name) : null;
}

// ── API: Status ──────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  let online = false;
  try {
    const locks = fs.readdirSync(LOCK_TMP).filter(f => f.startsWith(LOCK_PREFIX));
    for (const f of locks) {
      const pid = parseInt(fs.readFileSync(path.join(LOCK_TMP, f), 'utf8').trim(), 10);
      try { process.kill(pid, 0); online = true; break; } catch {}
    }
  } catch {}

  const logFile = latestBotLog();
  const lines = logFile ? readLastLines(logFile, 500) : [];
  const cycles = lines.filter(l => l.msg === 'cycle_no_slots' || l.msg === 'success').length;
  const reloads = lines.filter(l => l.msg === 'page_reload').length;
  const booked = lines.some(l => l.msg === 'success' || l.msg === 'booked_url' || l.msg === 'booked_modal');
  const last = lines[lines.length - 1] || null;
  const start = lines.find(l => l.msg === 'soldier_start');

  res.json({ online, booked, cycles, reloads, lastTs: last?.ts || null, lastMsg: last?.msg || null, startTs: start?.ts || null });
});

// ── API: Stats ───────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const logFile = latestBotLog();
  const lines = logFile ? readLastLines(logFile, 2000) : [];
  const counts = {};
  lines.forEach(l => { if (l.msg) counts[l.msg] = (counts[l.msg] || 0) + 1; });
  const errors = lines.filter(l => l.msg?.includes('error') || l.msg?.includes('fail')).slice(-10);
  res.json({ counts, errors, cfHits: counts['cloudflare_block'] || 0, noSlots: counts['cycle_no_slots'] || 0, reloads: counts['page_reload'] || 0 });
});

// ── API: Logs ────────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  const logFile = latestBotLog();
  res.json(logFile ? readLastLines(logFile, 100) : []);
});

// ── API: Screenshots ─────────────────────────────────────────────────────────
app.get('/api/screenshots', (req, res) => {
  if (!fs.existsSync(SCREENSHOT_DIR)) return res.json([]);
  const files = fs.readdirSync(SCREENSHOT_DIR)
    .filter(f => f.endsWith('.png'))
    .map(f => ({ name: f, time: fs.statSync(path.join(SCREENSHOT_DIR, f)).mtime.getTime() }))
    .sort((a, b) => b.time - a.time)
    .slice(0, 20)
    .map(f => f.name);
  res.json(files);
});

// ── WebSocket for real-time logs (replaces broken SSE) ───────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
let currentLogFile = null;
let currentWatcher = null;

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

function tailLog() {
  const latest = latestBotLog();
  if (!latest) return;
  if (latest === currentLogFile && currentWatcher) return;

  if (currentWatcher) { try { currentWatcher.close(); } catch {} }
  currentLogFile = latest;
  currentWatcher = fs.watch(currentLogFile, (evt) => {
    if (evt !== 'change') return;
    // Read only new bytes
    try {
      const stat = fs.statSync(currentLogFile);
      const stream = fs.createReadStream(currentLogFile, { start: Math.max(0, stat.size - 4096), encoding: 'utf8' });
      let buf = '';
      stream.on('data', chunk => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        lines.filter(Boolean).forEach(line => {
          try { broadcast(JSON.parse(line)); } catch { broadcast({ raw: line }); }
        });
      });
    } catch {}
  });
}
setInterval(tailLog, 2000); // Re-check for log rotation every 2s

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'hello', msg: 'Connected to Atlantis Commander' }));
  tailLog();
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown() {
  console.log('Shutting down...');
  if (currentWatcher) try { currentWatcher.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🔱 Commander on http://127.0.0.1:${PORT}`);
  if (!AUTH_TOKEN) console.warn('WARNING: No COMMANDER_AUTH set — dashboard is unprotected');
  console.log(` LOG_DIR: ${LOG_DIR}`);
});