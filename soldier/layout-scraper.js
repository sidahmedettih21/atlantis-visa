// soldier/layout-scraper-v2.js – Pixel‑perfect TLS geometry recorder
// Captures: buttons, links, inputs, slots, calendar cells, click coords,
// navigation screenshots, and DOM texts. One .txt output.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const CDP_PORT = 9222;
const OUT_DIR = path.join(__dirname, 'manual_session_logs');
fs.mkdirSync(OUT_DIR, { recursive: true });
const TXT_LOG = path.join(OUT_DIR, 'layout_full.txt');
const SHOT_DIR = path.join(OUT_DIR, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

function now() { return new Date().toISOString().replace('T',' ').substring(0,23); }
function log(line) { fs.appendFileSync(TXT_LOG, line + '\n'); console.log(line.substring(0,200)); }

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();

  // ── Inject geometry capture into the current page ────────────
  async function injectCapture() {
    await page.evaluate(() => {
      window.__captureLayout = () => {
        const els = document.querySelectorAll('button, a, input, select, .tls-time-unit, .day-cell, .month-tab, .month-btn, .slot-grid, .calendar-grid');
        const out = [];
        els.forEach(el => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          out.push({
            tag: el.tagName,
            id: el.id,
            class: el.className?.substring?.(0,80),
            text: el.textContent?.replace(/\s+/g,' ').trim().substring(0,40),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            margin: s.margin,
            padding: s.padding,
            border: s.border,
            font: s.font,
            color: s.color,
            bg: s.backgroundColor
          });
        });
        return out;
      };
    }).catch(() => {});
  }
  await injectCapture();

  // ── Reinject on every new page ──────────────────────────────
  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    await injectCapture();
    const url = page.url();
    log(`\n=== NAVIGATION: ${url} ===`);

    // Screenshot
    const shotName = `${Date.now()}.png`;
    await page.screenshot({ path: path.join(SHOT_DIR, shotName), fullPage: true }).catch(() => {});
    log(`SCREENSHOT: ${shotName}`);

    // DOM text (trimmed)
    const domText = await page.evaluate(() => document.body?.innerText?.substring(0, 2000) || '(empty)').catch(() => '(error)');
    log(`DOM_TEXT: ${domText}`);

    // Layout capture
    const layout = await page.evaluate(() => window.__captureLayout()).catch(() => []);
    log(`LAYOUT_ELEMENTS: ${layout.length}`);
    layout.forEach(el => {
      log(`  [${el.tag}] "${el.text}" id="${el.id}" class="${el.class}" rect=${JSON.stringify(el.rect)} margin="${el.margin}" padding="${el.padding}" font="${el.font}" color="${el.color}" bg="${el.bg}"`);
    });
  });

  // ── Click tracking (only coordinates + target) ───────────────
  await page.evaluate(() => {
    document.addEventListener('click', (e) => {
      const detail = {
        x: e.clientX, y: e.clientY,
        tag: e.target?.tagName,
        id: e.target?.id,
        text: e.target?.textContent?.substring(0,40)
      };
      console.log('__CLICK__', JSON.stringify(detail));
    });
  });
  page.on('console', msg => {
    if (msg.text().startsWith('__CLICK__')) {
      const data = msg.text().substring(10);
      log(`CLICK: ${data}`);
    }
  });

  log(`Recorder started. Navigate TLScontact. Ctrl+C to stop.`);
  await new Promise(() => {});
})();