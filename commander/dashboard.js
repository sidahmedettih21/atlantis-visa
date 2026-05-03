#!/usr/bin/env node
// commander/dashboard.js  – Atlantis-Visa Commander (server)

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');

const PORT = parseInt(process.env.COMMANDER_PORT || '9000', 10);

// ── Paths – must mirror bot.js exactly ──────────────────────────────────────
// Bot uses: BASE_DIR = ATLANTIS_HOME || ~/atlantis-visa
const BASE_DIR       = process.env.ATLANTIS_HOME || path.join(os.homedir(), 'atlantis-visa');
const LOG_DIR        = path.join(BASE_DIR, 'logs');
const SCREENSHOT_DIR = path.join(LOG_DIR, 'screenshots');
const LOCK_TMP       = os.tmpdir();
const LOCK_PREFIX    = 'atlantis-soldier-';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(SCREENSHOT_DIR));

// ── Helper: find & parse the latest log file ─────────────────────────────────
function latestLogLines(n = 200) {
  if (!fs.existsSync(LOG_DIR)) return [];
  const files = fs.readdirSync(LOG_DIR)
    .filter(f => f.startsWith('bot_') && f.endsWith('.log'))
    .sort();
  if (!files.length) return [];
  const content = fs.readFileSync(path.join(LOG_DIR, files[files.length - 1]), 'utf8');
  return content.trim().split('\n').filter(Boolean).slice(-n).map(l => {
    try { return JSON.parse(l); } catch { return { raw: l }; }
  });
}

// ── /api/status – soldier alive + basic stats ────────────────────────────────
app.get('/api/status', (req, res) => {
  // 1. Check lock files for a living soldier process
  let online = false;
  try {
    const locks = fs.readdirSync(LOCK_TMP).filter(f => f.startsWith(LOCK_PREFIX));
    for (const f of locks) {
      const pid = parseInt(fs.readFileSync(path.join(LOCK_TMP, f), 'utf8').trim(), 10);
      try { process.kill(pid, 0); online = true; break; } catch { /* stale lock */ }
    }
  } catch {}

  // 2. Pull quick stats from logs
  const lines = latestLogLines(500);
  const cycles = lines.filter(l => l.msg === 'booking_cycle_no_slots' || l.msg === 'booking_cycle_success').length;
  const reloads = lines.filter(l => l.msg === 'page_reload').length;
  const booked  = lines.some(l => l.msg === 'booking_cycle_success');
  const lastLine = lines[lines.length - 1] || null;
  const startLine = lines.find(l => l.msg === 'soldier_start');

  res.json({
    online,
    booked,
    cycles,
    reloads,
    lastTs:  lastLine?.ts  || null,
    lastMsg: lastLine?.msg || null,
    startTs: startLine?.ts || null,
  });
});

// ── /api/stats – richer analytics over entire log ───────────────────────────
app.get('/api/stats', (req, res) => {
  const lines = latestLogLines(2000);
  const counts = {};
  lines.forEach(l => { if (l.msg) counts[l.msg] = (counts[l.msg] || 0) + 1; });

  const errors  = lines.filter(l => l.msg?.includes('error') || l.msg?.includes('fail'));
  const cfHits  = counts['cloudflare_block'] || 0;
  const noSlots = counts['booking_cycle_no_slots'] || 0;
  const reloads = counts['page_reload'] || 0;

  res.json({ counts, errors: errors.slice(-10), cfHits, noSlots, reloads });
});

// ── /api/logs – last 100 log lines ──────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  res.json(latestLogLines(100));
});

// ── /api/screenshots – 20 most recent screenshots ───────────────────────────
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

// ── /api/events – SSE tail of latest log ────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });

  const send = data => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };

  if (!fs.existsSync(LOG_DIR)) { send({ error: 'log_dir_missing' }); return; }
  const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('bot_') && f.endsWith('.log')).sort();
  if (!files.length) { send({ error: 'no_log_file' }); return; }

  const latest  = path.join(LOG_DIR, files[files.length - 1]);
  let lastSize  = fs.statSync(latest).size;

  const watcher = fs.watch(latest, eventType => {
    if (eventType !== 'change') return;
    try {
      const stat = fs.statSync(latest);
      if (stat.size <= lastSize) return;
      const stream = fs.createReadStream(latest, { start: lastSize, end: stat.size - 1, encoding: 'utf8' });
      let buf = '';
      stream.on('data', chunk => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        lines.filter(Boolean).forEach(line => { try { res.write(`data: ${line}\n\n`); } catch {} });
      });
      lastSize = stat.size;
    } catch {}
  });

  req.on('close', () => { try { watcher.close(); } catch {} });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`🔱 Commander on http://127.0.0.1:${PORT}`);
  console.log(`   LOG_DIR: ${LOG_DIR}`);
});