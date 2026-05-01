// soldier/session-recorder.js – Ultra‑detailed manual session logger
// Writes a single structured .txt file: manual_session_logs/session_log.txt

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const CDP_PORT = 9222;
const LOG_DIR = path.join(__dirname, 'manual_session_logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const TXT_LOG = path.join(LOG_DIR, 'session_log.txt');
const SHOT_DIR = path.join(LOG_DIR, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

// Human‑readable timestamp
function now() {
  return new Date().toISOString().replace('T', ' ').substring(0, 23);
}

// Buffer the log so we don't hammer the disk
let buffer = [];
let flushTimer = null;

function flush() {
  if (buffer.length === 0) return;
  fs.appendFileSync(TXT_LOG, buffer.join('\n') + '\n');
  buffer = [];
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

function log(line) {
  buffer.push(line);
  if (!flushTimer) flushTimer = setTimeout(flush, 1000);
  console.log(line.substring(0, 200)); // also console print for real-time
}

// Quick shutdown flush
process.on('exit', flush);
process.on('SIGINT', () => { flush(); process.exit(); });

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();

  // Write session header
  log(`=================================================================`);
  log(`  TLScontact Manual Session Log`);
  log(`  Started: ${now()}`);
  log(`=================================================================`);
  log('');

  // ── Screen info ──
  const screenInfo = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    screenWidth: screen.width,
    screenHeight: screen.height,
    availWidth: screen.availWidth,
    availHeight: screen.availHeight
  }));
  log(`[${now()}] SCREEN_INFO: width=${screenInfo.width}, height=${screenInfo.height}, dpr=${screenInfo.devicePixelRatio}, screen=${screenInfo.screenWidth}x${screenInfo.screenHeight}`);

  // ── Inject mouse/scroll/zoom tracker into page ──
  await page.evaluate(() => {
    let lastMouseMove = 0;
    const MOUSE_THROTTLE_MS = 100; // log mouse max 10 times/sec

    function send(type, detail) {
      console.log('__TRACK__', JSON.stringify({ type, detail }));
    }

    document.addEventListener('mousemove', e => {
      const now = Date.now();
      if (now - lastMouseMove < MOUSE_THROTTLE_MS) return;
      lastMouseMove = now;
      send('mouse', { x: e.clientX, y: e.clientY, target: e.target?.tagName });
    }, { passive: true });

    document.addEventListener('click', e => {
      send('click', {
        x: e.clientX, y: e.clientY,
        tag: e.target?.tagName,
        id: e.target?.id,
        text: e.target?.textContent?.substring(0, 60)
      });
    });

    let lastScroll = 0;
    window.addEventListener('scroll', () => {
      const now = Date.now();
      if (now - lastScroll < 200) return;
      lastScroll = now;
      send('scroll', { scrollX: window.scrollX, scrollY: window.scrollY });
    }, { passive: true });

    try {
      window.visualViewport?.addEventListener('resize', () => {
        send('zoom', {
          width: window.visualViewport.width,
          height: window.visualViewport.height,
          scale: window.visualViewport.scale
        });
      });
    } catch(e) {}
  });

  // ── Handle navigations ──
  page.on('framenavigated', async frame => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    log('');
    log(`=================================================================`);
    log(`[${now()}] NAVIGATION: ${url}`);
    log(`=================================================================`);

    // Screenshot
    const shotName = `${Date.now()}.png`;
    const shotPath = path.join(SHOT_DIR, shotName);
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    log(`[${now()}] SCREENSHOT: ${shotName}`);

    // DOM dump (short summary)
    const domText = await page.evaluate(() => document.body?.innerText?.substring(0, 3000) || '(empty)').catch(() => '(error)');
    const domName = `dom_${Date.now()}.txt`;
    const domPath = path.join(SHOT_DIR, domName);
    fs.writeFileSync(domPath, domText);
    log(`[${now()}] DOM_DUMP: ${domName} (saved separately)`);

    // Cookies summary
    const cookies = await ctx.cookies();
    log(`[${now()}] COOKIES: ${cookies.length} cookies`);
    cookies.forEach(c => {
      log(`  - ${c.name}: ${c.value.substring(0, 50)} (domain: ${c.domain})`);
    });
  });

  // ── Console messages (including injected trackers) ──
  page.on('console', msg => {
    const text = msg.text();
    if (text.startsWith('__TRACK__')) {
      try {
        const evt = JSON.parse(text.substring(11));
        const ts = now();
        const type = evt.type;
        const d = evt.detail;
        if (type === 'mouse') {
          log(`[${ts}] MOUSE_MOVE  x=${d.x} y=${d.y} target=${d.target||''}`);
        } else if (type === 'click') {
          log(`[${ts}] CLICK       x=${d.x} y=${d.y} tag=${d.tag||''} id=${d.id||''} text="${d.text||''}"`);
        } else if (type === 'scroll') {
          log(`[${ts}] SCROLL      x=${d.scrollX} y=${d.scrollY}`);
        } else if (type === 'zoom') {
          log(`[${ts}] ZOOM        w=${d.width} h=${d.height} scale=${d.scale}`);
        }
      } catch {}
      return;
    }
    // General console messages
    log(`[${now()}] CONSOLE_${msg.type().toUpperCase()}: ${text.substring(0, 200)}`);
  });

  // ── Dialogs ──
  page.on('dialog', async dialog => {
    log(`[${now()}] DIALOG      type=${dialog.type()} message="${dialog.message()}"`);
    await dialog.dismiss().catch(() => {});
  });

  log(`[${now()}] Recorder ready. Perform the complete manual flow. Press Ctrl+C to stop.`);
  log('');
  // Keep alive
  await new Promise(() => {});
})();