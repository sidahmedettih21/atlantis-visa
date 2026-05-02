#!/usr/bin/env node
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.COMMANDER_PORT || 9000;
const LOG_DIR = path.join(__dirname, '..', 'soldier', 'logs');
const SCREENSHOT_DIR = path.join(LOG_DIR, 'screenshots');
const LOCK_TMP = os.tmpdir();
const LOCK_PREFIX = 'atlantis-soldier-';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(SCREENSHOT_DIR));

// ── API: soldier status (using the lock file the soldier already creates) ─
app.get('/api/status', (req, res) => {
  try {
    const locks = fs.readdirSync(LOCK_TMP).filter(f => f.startsWith(LOCK_PREFIX));
    let online = false;
    for (const f of locks) {
      const pid = parseInt(fs.readFileSync(path.join(LOCK_TMP, f), 'utf8').trim(), 10);
      try { process.kill(pid, 0); online = true; break; } catch { /* stale lock */ }
    }
    res.json({ online });
  } catch (e) {
    res.json({ online: false });
  }
});

// ── API: latest log lines ──────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  if (!fs.existsSync(LOG_DIR)) return res.json([]);
  const logs = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('bot_') && f.endsWith('.log')).sort();
  if (!logs.length) return res.json([]);
  const latest = path.join(LOG_DIR, logs[logs.length - 1]);
  const content = fs.readFileSync(latest, 'utf8');
  const lines = content.trim().split('\n').slice(-100).map(l => {
    try { return JSON.parse(l); } catch { return { raw: l }; }
  });
  res.json(lines);
});

// ── API: recent screenshots ─────────────────────────────────────────────
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

// ── SSE stream: tail latest log ────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  if (!fs.existsSync(LOG_DIR)) {
    send({ error: 'Log directory not found' });
    return;
  }
  const logs = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('bot_') && f.endsWith('.log')).sort();
  if (!logs.length) {
    send({ error: 'No log file yet' });
    return;
  }
  const latest = path.join(LOG_DIR, logs[logs.length - 1]);
  let lastSize = fs.statSync(latest).size;

  fs.watch(latest, (eventType) => {
    if (eventType !== 'change') return;
    try {
      const stat = fs.statSync(latest);
      if (stat.size > lastSize) {
        const stream = fs.createReadStream(latest, { start: lastSize, end: stat.size - 1, encoding: 'utf8' });
        let buf = '';
        stream.on('data', chunk => {
          buf += chunk;
          const lines = buf.split('\n');
          buf = lines.pop(); // incomplete line
          lines.filter(Boolean).forEach(line => {
            try { res.write(`data: ${line}\n\n`); } catch {}
          });
        });
        lastSize = stat.size;
      }
    } catch (e) {}
  });

  req.on('close', () => {});
});

app.listen(PORT, '127.0.0.1', () => console.log(`🔱 Commander on http://127.0.0.1:${PORT}`));