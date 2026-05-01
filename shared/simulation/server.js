// server.js – Atlantis-Visa Super-Advanced Simulation Server (no dependencies)
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.SIM_PORT || 8080;
const LOG_FILE = path.join(__dirname, 'events.jsonl');
const SIM_FILE = path.join(__dirname, 'index.html');

// Store connected SSE clients
const sseClients = new Set();

// Helper to write JSON lines
function logEvent(type, data = {}) {
  const entry = { ts: new Date().toISOString(), type, ...data };
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(LOG_FILE, line);
  
  // Broadcast to all SSE clients
  const eventData = `data: ${JSON.stringify(entry)}\n\n`;
  sseClients.forEach(client => {
    try { client.write(eventData); } catch {}
  });
  console.log(`[SIM] ${type}`, data);
}

// Read the simulation HTML (cached)
let simHtml = null;
function getSimHtml() {
  if (!simHtml) {
    try { simHtml = fs.readFileSync(SIM_FILE, 'utf8'); } catch { simHtml = '<h1>Simulation HTML not found</h1>'; }
  }
  return simHtml;
}

// MIME types
const mimeTypes = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png' };

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ----- API: Log event -----
  if (method === 'POST' && pathname === '/log-event') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const event = JSON.parse(body);
        logEvent(event.type || 'unknown', event.data || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // ----- API: Force slot -----
  if (method === 'POST' && pathname === '/api/force-slot') {
    logEvent('command', { command: 'force-slot' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Force-slot command sent (click it in simulation)' }));
    return;
  }

  // ----- API: Reset -----
  if (method === 'POST' && pathname === '/api/reset') {
    logEvent('command', { command: 'reset' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Reset command sent' }));
    return;
  }

  // ----- API: Status -----
  if (method === 'GET' && pathname === '/api/status') {
    const stats = { uptime: process.uptime(), clients: sseClients.size, logFile: LOG_FILE };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }

  // ----- SSE stream for real-time events -----
  if (method === 'GET' && pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('data: {"type":"connected","message":"SSE stream established"}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ----- Simple admin page -----
  if (method === 'GET' && pathname === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html><html><head><title>Atlantis-Visa Admin</title></head><body>
      <h1>Atlantis-Visa Simulation Admin</h1>
      <p>Status: <span id="status">Connected</span> | Clients: <span id="clients">0</span></p>
      <button onclick="fetch('/api/force-slot',{method:'POST'})">Force Slot</button>
      <button onclick="fetch('/api/reset',{method:'POST'})">Reset</button>
      <hr>
      <h2>Live Events</h2>
      <pre id="log"></pre>
      <script>
        const evtSource = new EventSource('/events');
        evtSource.onmessage = (e) => {
          const log = document.getElementById('log');
          log.innerHTML += e.data + '\\n';
          log.scrollTop = log.scrollHeight;
        };
        setInterval(async () => {
          const r = await fetch('/api/status').then(r => r.json());
          document.getElementById('status').textContent = 'Running';
          document.getElementById('clients').textContent = r.clients;
        }, 2000);
      </script></body></html>`);
    return;
  }

  // ----- Default: Serve static files -----
  let filePath = pathname === '/' ? SIM_FILE : path.join(__dirname, pathname);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);

  // Support Range header for larger files (optional)
  const range = req.headers.range;
  if (range && stat.size > 10000) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1
    });
    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);
    return;
  }

  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`🔬 Atlantis-Visa Simulation Server ready on http://localhost:${PORT}`);
  console.log(`   Admin panel: http://localhost:${PORT}/admin`);
  console.log(`   Live events: http://localhost:${PORT}/events`);
});

// Graceful shutdown
process.on('SIGINT', () => { console.log('Server shutting down.'); process.exit(); });