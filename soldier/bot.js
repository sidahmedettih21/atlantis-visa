#!/usr/bin/env node
console.log(`
//      /$$$$$$  /$$$$$$$$ /$$        /$$$$$$  /$$   /$$ /$$$$$$$$ /$$$$$$  /$$$$$$ 
//     /$$__  $$|__  $$__/| $$       /$$__  $$| $$$ | $$|__  $$__/|_  $$_/ /$$__  $$
//    | $$  \ $$   | $$   | $$      | $$  \ $$| $$$$| $$   | $$     | $$  | $$  \__/
//    | $$$$$$$$   | $$   | $$      | $$$$$$$$| $$ $$ $$   | $$     | $$  |  $$$$$$ 
//    | $$__  $$   | $$   | $$      | $$__  $$| $$  $$$$   | $$     | $$   \____  $$
//    | $$  | $$   | $$   | $$      | $$  | $$| $$\  $$$   | $$     | $$   /$$  \ $$
//    | $$  | $$   | $$   | $$$$$$$$| $$  | $$| $$ \  $$   | $$    /$$$$$$|  $$$$$$/
//    |__/  |__/   |__/   |________/|__/  |__/|__/  \__/   |__/   |______/ \______/ 
//                                                                                  
//                                                                                  
//                                                                                  
`);
// Atlantis-Visa – Live-only, ultra‑stable soldier
// Attaches to a real Chrome (--remote-debugging-port=9222)
// and waits for manual navigation to /appointment-booking.
// NEVER navigates away – only does page.reload().
// Refresh intervals: 5‑8 s (hot window), 300‑400 s (normal).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const BASE_DIR = process.env.ATLANTIS_HOME || path.join(os.homedir(), 'atlantis-visa');
const SELECTORS_PATH = (() => {
  const devPath = path.join(__dirname, '..', 'shared', 'selectors.json');
  if (fs.existsSync(devPath)) return devPath;
  const cwdPath = path.join(process.cwd(), 'shared', 'selectors.json');
  if (fs.existsSync(cwdPath)) return cwdPath;
  return path.join(BASE_DIR, 'shared', 'selectors.json');
})();
const LOG_DIR = path.join(BASE_DIR, 'logs');
const SCREENSHOT_DIR = path.join(LOG_DIR, 'screenshots');

const SPINNER_SELECTORS = [
  '.loading-spinner', '.spinner', '[class*="spinner"]',
  '[class*="loading"]', '.ajax-loader', '[class*="loader"]', '.tls-loader'
];
const BOOK_TEXTS = ['Book your appointment','Confirm','Submit','Book','Réserver','Confirmer','Valider'];
const CF_TERMS = ['checking your browser','you have been blocked','ray id','cloudflare','please wait','ddos protection','attention required'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (min,max) => Math.floor(Math.random()*(max-min+1))+min;

// Logger
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `bot_${Date.now()}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
function log(msg, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), msg, ...data }) + '\n';
  logStream.write(line);
  console.log(`[BOT] ${msg}`, data);
}

// Telegram
const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT = process.env.CHAT_ID || '';
function sendTelegram(text, shot) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    if (shot && fs.existsSync(shot)) {
      const boundary = '----FormBoundary' + Date.now();
      const parts = [
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TG_CHAT}\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${text}\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n`,
        fs.readFileSync(shot),
        `\r\n--${boundary}--\r\n`
      ];
      const payload = Buffer.concat(parts.map(p => Buffer.from(p, 'utf8')).slice(0,-1).concat(parts.slice(-1)));
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TG_TOKEN}/sendPhoto`,
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(payload) }
      });
      req.on('error', () => {});
      req.write(payload);
      req.end();
    } else {
      const payload = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' });
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TG_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      });
      req.on('error', () => {});
      req.write(payload);
      req.end();
    }
  } catch {}
}

// CDP
let browser;
async function connectCDP(retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      log('cdp_connected');
      return;
    } catch (e) {
      if (i === retries - 1) {
        console.error('❌ Cannot connect to Chrome after multiple retries. Exiting.');
        process.exit(1);
      }
      log('cdp_retrying', { attempt: i + 1, error: e.message });
      await sleep(5000);
    }
  }
}
async function ensureCDP() {
  if (!browser?.isConnected()) { log('cdp_reconnecting'); await connectCDP(10); }
}
async function getPage() {
  await ensureCDP();
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('NO_CONTEXT');
  let pages = ctx.pages();
  if (!pages.length) pages = [await ctx.newPage()];
  return pages.find(p => p.url().includes('tlscontact')) || pages[0];
}

// Selector helpers
async function queryVisible(page, selectors, ctx = '') {
  if (typeof selectors === 'string') selectors = [selectors];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      const count = await loc.count();
      if (count > 0 && await loc.isVisible().catch(() => false))
        return { loc, sel, count, visible: true };
    } catch {}
  }
  return null;
}
async function clickVisible(page, selectors, ctx = '') {
  const el = await queryVisible(page, selectors, ctx);
  if (!el) return false;
  await sleep(rand(200, 800));
  await el.loc.click({ force: false });
  const txt = await el.loc.textContent().catch(() => '');
  log('click', { context: ctx, selector: el.sel, text: txt?.trim()?.slice(0, 50) });
  return true;
}
async function shoot(page, label) {
  const file = path.join(SCREENSHOT_DIR, `${label}_${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

// Selectors
let SELECTORS;
try { SELECTORS = JSON.parse(fs.readFileSync(SELECTORS_PATH, 'utf8')).PT; }
catch { SELECTORS = { month_tab: 'a[href*="month="]', day_cell: '.day-cell', slot_button: '.tls-time-unit', slot_available: '.tls-time-unit.available', no_slots_text: "We currently don't have any appointment slots available." }; }

// State machine steps
async function stepWaitForAppointmentPage(page) {
  while (true) {
    const url = page.url();
    if (url.includes('/appointment-booking')) { log('appointment_reached', { url }); return 'CONTINUE'; }
    if (url.includes('/service-level')) {
      log('service_level_detected');
      await clickVisible(page, ['button:has-text("Standard")','a:has-text("Standard")','[data-type="standard"]']);
      await sleep(800);
      await clickVisible(page, ['button:has-text("Continue")','a:has-text("Continue")','button[type="submit"]']);
      await sleep(2000);
      continue;
    }
    await sleep(500);
  }
}

async function stepCourierModal(page) {
  if (await queryVisible(page, ['#courier-step','[id*="courier"]','.modal:has-text("Courier")','.modal:has-text("courier")']))
    await clickVisible(page, ['button:has-text("Continue")','a:has-text("Continue")','button:has-text("Next")']);
  return 'CONTINUE';
}

async function stepCheckNoSlots(page) {
  const patterns = [
    SELECTORS.no_slots_text ? `text="${SELECTORS.no_slots_text}"` : null,
    '.no-slots','#noSlotsMsg','[class*="no-slot"]','[class*="empty"]','text="Unfortunately"'
  ].filter(Boolean);
  const res = await queryVisible(page, patterns, 'no_slots');
  if (res) { log('no_slots_visible', { selector: res.sel }); return 'NO_SLOTS'; }
  return 'CONTINUE';
}

async function stepMonthTab(page) {
  const activeSel = SELECTORS.month_tab;
  const active = await queryVisible(page, [`${activeSel}.active`,`${activeSel}.selected`,`${activeSel}[aria-selected="true"]`], 'month_active');
  if (active) return 'CONTINUE';
  const allTabs = page.locator(activeSel);
  const cnt = await allTabs.count();
  for (let i = 0; i < cnt; i++) {
    const tab = allTabs.nth(i);
    const disabled = await tab.evaluate(el => el.disabled || el.classList.contains('disabled')).catch(() => true);
    if (!disabled) {
      await sleep(rand(200, 800));
      await tab.click();
      log('month_clicked', { index: i, text: (await tab.textContent().catch(() => ''))?.trim() });
      await sleep(600);
      return 'CONTINUE';
    }
  }
  return 'NO_SLOTS';
}

async function stepDay(page) {
  const pats = [`${SELECTORS.day_cell}.available`, `${SELECTORS.day_cell}:not(.disabled)`, SELECTORS.day_cell];
  const res = await queryVisible(page, pats, 'day');
  if (!res) return 'NO_SLOTS';
  await sleep(rand(200, 800));
  await res.loc.click();
  log('day_clicked');
  await sleep(500);
  return 'CONTINUE';
}

async function stepSpinnerAndTime(page) {
  for (const sel of SPINNER_SELECTORS) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      log('spinner_detected', { selector: sel });
      await loc.waitFor({ state: 'hidden', timeout: 10000 });
      break;
    }
  }
  const slotSel = SELECTORS.slot_button || '.tls-time-unit';
  await page.locator(slotSel).first().waitFor({ state: 'visible', timeout: 10000 });
  const pats = [SELECTORS.slot_available, slotSel, '.tls-time-unit.available', 'button[data-time]', 'a[data-time]', '[class*="time-slot"]', '[class*="slot"]:not([disabled])'].filter(Boolean);
  const res = await queryVisible(page, pats, 'time');
  if (!res) return 'NO_SLOTS';
  await sleep(rand(200, 800));
  await res.loc.click();
  log('time_clicked');
  return 'CONTINUE';
}

async function stepBook(page) {
  const textPats = BOOK_TEXTS.map(t => `button:has-text("${t}")`);
  const pats = [...textPats, '#bookBtn', '[data-testid="book-button"]', 'button[type="submit"]', 'input[type="submit"]'];
  const res = await queryVisible(page, pats, 'book');
  if (!res) return 'NO_SLOTS';
  await sleep(rand(200, 800));
  await res.loc.click();
  log('book_clicked');
  await sleep(1000);
  return 'CONTINUE';
}

async function stepConfirmation(page) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    const url = page.url();
    if (url.includes('/order-summary') || url.includes('/confirmation') || url.includes('/success')) {
      const shot = await shoot(page, 'confirmation');
      log('booking_success_url', { url, screenshot: shot });
      sendTelegram('<b>BOOKING SUCCESS</b>\nAppointment booked!', shot);
      return 'BOOKED';
    }
    const modal = await queryVisible(page, ['.modal-overlay.active','.modal.active','[class*="confirmation"]','[class*="success-modal"]','text="Appointment confirmed"','text="Booking confirmed"'], 'confirmation_modal');
    if (modal) {
      const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("OK"), button:has-text("Submit"), .modal-confirm').first();
      if (await confirmBtn.count() > 0 && await confirmBtn.isVisible()) {
        await sleep(rand(200, 800));
        await confirmBtn.click();
        log('confirm_button_clicked');
        await sleep(1000);
      }
      const shot = await shoot(page, 'confirmation');
      log('booking_success_modal', { screenshot: shot });
      sendTelegram('<b>BOOKING SUCCESS</b>\nAppointment booked!', shot);
      return 'BOOKED';
    }
    await sleep(500);
  }
  return 'NO_SLOTS';
}

const STEPS = [
  { name: 'WAIT_APPOINTMENT', fn: stepWaitForAppointmentPage },
  { name: 'COURIER_MODAL', fn: stepCourierModal },
  { name: 'CHECK_NO_SLOTS', fn: stepCheckNoSlots },
  { name: 'MONTH_TAB', fn: stepMonthTab },
  { name: 'SELECT_DAY', fn: stepDay },
  { name: 'WAIT_SPINNER_TIME', fn: stepSpinnerAndTime },
  { name: 'CLICK_BOOK', fn: stepBook },
  { name: 'DETECT_CONFIRMATION', fn: stepConfirmation },
];

async function runStateMachine(page) {
  for (const step of STEPS) {
    try {
      const result = await Promise.race([
        step.fn(page),
        new Promise((_, reject) => setTimeout(() => reject(new Error('STEP_TIMEOUT')), 30000))
      ]);
      if (result === 'NO_SLOTS') return false;
      if (result === 'BOOKED') return true;
    } catch (e) {
      log(`step_${step.name}_error`, { error: e.message });
      return false;
    }
  }
  return false;
}

// Refresh – only page.reload(), NEVER navigates away
async function safeReload(page) {
  log('page_reload');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await sleep(rand(2000, 4000));
}

async function handleCloudflare(page) {
  let backoff = 60000;
  while (true) {
    const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const title = await page.title().catch(() => '');
    if (!CF_TERMS.some(t => (body + ' ' + title).toLowerCase().includes(t))) break;
    log('cloudflare_block', { backoff });
    sendTelegram(`Cloudflare block – backing off ${backoff/1000}s`);
    await sleep(backoff);
    await safeReload(page);
    backoff = Math.min(backoff * 2, 3600000);
  }
}

// Main
(async () => {
  await connectCDP(10);
  let page = await getPage();
  const targetUrl = 'https://visas-pt.tlscontact.com/en-us/388184/workflow/appointment-booking?location=dzALG2pt';

  log('soldier_start');
  sendTelegram('Soldier started – please navigate to the appointment page');

  let lastRefresh = Date.now();
  while (true) {
    try {
      page = await getPage();
      const url = page.url();
      log('tick', { url });

      await handleCloudflare(page);

      if (url.includes('/login')) {
        log('session_expired');
        sendTelegram('Session expired – please log in again');
        await sleep(30000);
        continue;
      }

      const isHot = (() => {
        const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Algiers' }));
        const m = d.getHours()*60 + d.getMinutes();
        return (m >= 535 && m <= 555) || (m >= 835 && m <= 855);
      })();
      // Cold interval: 300‑400 seconds; hot interval: 5‑8 seconds
      const interval = isHot ? rand(5000, 8000) : rand(300000, 400000);

      if (Date.now() - lastRefresh > interval) {
        await safeReload(page);
        lastRefresh = Date.now();
      }

      const booked = await runStateMachine(page);
      if (booked) {
        log('booking_cycle_success');
        sendTelegram('Appointment booked!');
        await sleep(30000);
        lastRefresh = Date.now();
      } else {
        log('booking_cycle_no_slots');
        await sleep(rand(3000, 6000));
      }
    } catch (e) {
      log('loop_error', { error: e.message });
      await sleep(5000);
    }
  }
})();