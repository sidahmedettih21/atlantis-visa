#!/usr/bin/env node
// Atlantis-Visa — Production Soldier v2.1
// CDP-attached, real Chrome, zero-navigation, bulletproof state machine
// Fixes: calendar race condition, getPage fallback, cloudflare string bug,
//        confirmation timeout, DOM ready polling, cleanup

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG — NO FALLBACK SECRETS
// ═══════════════════════════════════════════════════════════════════════════════
const CDP_PORT   = parseInt(process.env.CDP_PORT || '9222', 10);
const BASE_DIR   = process.env.ATLANTIS_HOME || path.join(os.homedir(), 'atlantis-visa');
const COUNTRY    = process.env.ATLANTIS_COUNTRY || 'PT';
const TG_TOKEN   = process.env.TELEGRAM_TOKEN;
const TG_CHAT    = process.env.CHAT_ID;
const DRY_RUN    = process.env.DRY_RUN === '1';

const SELECTORS_PATH = (() => {
  const candidates = [
    path.join(__dirname, '..', 'shared', 'selectors.json'),
    path.join(process.cwd(), 'shared', 'selectors.json'),
    path.join(BASE_DIR, 'shared', 'selectors.json'),
  ];
  return candidates.find(p => fs.existsSync(p)) || candidates[2];
})();

const LOG_DIR       = path.join(BASE_DIR, 'logs');
const SCREENSHOT_DIR= path.join(LOG_DIR, 'screenshots');

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════
// LOCK FILE (dashboard heartbeat)
// ═══════════════════════════════════════════════════════════════════════════════
const LOCK_FILE = path.join(os.tmpdir(), `atlantis-soldier-${process.pid}`);
fs.writeFileSync(LOCK_FILE, String(process.pid));
const cleanup = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// ═══════════════════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;
const nowISO = () => new Date().toISOString();

// ═══════════════════════════════════════════════════════════════════════════════
// ROTATING LOGGER
// ═══════════════════════════════════════════════════════════════════════════════
class RotatingLogger {
  constructor(dir, prefix, maxBytes = 5 * 1024 * 1024) {
    this.dir = dir; this.prefix = prefix; this.maxBytes = maxBytes;
    this.seq = 0; this._open();
  }
  _path() { return path.join(this.dir, `${this.prefix}_${Date.now()}_${this.seq}.log`); }
  _open() {
    if (this.stream) { this.stream.end(); }
    this.current = this._path();
    this.stream = fs.createWriteStream(this.current, { flags: 'a' });
    this.bytes = fs.existsSync(this.current) ? fs.statSync(this.current).size : 0;
  }
  _rotate() {
    this.seq++; this._open();
  }
  write(obj) {
    const line = JSON.stringify({ ts: nowISO(), ...obj }) + '\n';
    const buf = Buffer.byteLength(line);
    if (this.bytes + buf > this.maxBytes) this._rotate();
    this.stream.write(line);
    this.bytes += buf;
  }
  close() { this.stream.end(); }
  get currentFile() { return this.current; }
}

const log = new RotatingLogger(LOG_DIR, 'bot');
const detailed = new RotatingLogger(LOG_DIR, 'detailed');

function jlog(msg, data = {}) { log.write({ msg, ...data }); }
function dlog(msg) { detailed.write({ raw: msg }); }
function logAndPrint(msg, data = {}) {
  jlog(msg, data);
  console.log(`[BOT] ${msg}`, Object.keys(data).length ? data : '');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM QUEUE (rate-limit safe)
// ═══════════════════════════════════════════════════════════════════════════════
class TelegramQueue {
  constructor(token, chatId) {
    this.token = token; this.chatId = chatId; this.queue = []; this.sending = false;
  }
  push(text, photoPath = null) { this.queue.push({ text, photoPath }); this._drain(); }
  async _drain() {
    if (this.sending || !this.queue.length || !this.token || !this.chatId) return;
    this.sending = true;
    const { text, photoPath } = this.queue.shift();
    try {
      if (photoPath && fs.existsSync(photoPath)) {
        await this._sendPhoto(text, photoPath);
      } else {
        await this._sendMessage(text);
      }
    } catch (e) {
      jlog('telegram_error', { error: e.message });
    }
    await sleep(1100);
    this.sending = false;
    this._drain();
  }
  _sendMessage(text) {
    return new Promise((res, rej) => {
      const payload = JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML' });
      const req = https.request({
        hostname: 'api.telegram.org', path: `/bot${this.token}/sendMessage`,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); });
      req.on('error', rej); req.write(payload); req.end();
    });
  }
  _sendPhoto(caption, photoPath) {
    return new Promise((res, rej) => {
      const boundary = '----Atlantis' + Date.now();
      const photoData = fs.readFileSync(photoPath);
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${this.chatId}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n`
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([head, photoData, tail]);
      const req = https.request({
        hostname: 'api.telegram.org', path: `/bot${this.token}/sendPhoto`,
        method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); });
      req.on('error', rej); req.write(body); req.end();
    });
  }
}
const tg = new TelegramQueue(TG_TOKEN, TG_CHAT);

// ═══════════════════════════════════════════════════════════════════════════════
// CDP MANAGER
// ═══════════════════════════════════════════════════════════════════════════════
let browser;
async function connectCDP(retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      logAndPrint('cdp_connected');
      dlog('CDP connected');
      return;
    } catch (e) {
      if (i === retries - 1) { console.error('Cannot connect to Chrome. Exiting.'); process.exit(1); }
      logAndPrint('cdp_retry', { attempt: i + 1, error: e.message });
      await sleep(5000);
    }
  }
}
async function ensureCDP() {
  if (!browser?.isConnected()) { logAndPrint('cdp_reconnect'); await connectCDP(10); }
}
async function getPage() {
  await ensureCDP();
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('NO_CONTEXT');
  const pages = ctx.pages();
  if (!pages.length) throw new Error('NO_PAGES');
  const tls = pages.find(p => p.url().includes('tlscontact'));
  if (tls) return tls;
  for (const p of pages) {
    const visible = await p.evaluate(() => document.visibilityState === 'visible').catch(() => false);
    if (visible) return p;
  }
  return pages[0]; // FALLBACK — never return undefined
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOM HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
async function pageInnerText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function pageHasText(page, regex) {
  const text = await pageInnerText(page);
  return text.length > 5 && regex.test(text); // FIX: was >20, too high
}

async function queryVisible(page, selectors, ctx = '') {
  if (typeof selectors === 'string') selectors = [selectors];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      const count = await loc.count();
      if (count > 0 && await loc.isVisible().catch(() => false)) {
        return { loc, sel };
      }
    } catch {}
  }
  return null;
}

async function stableClick(page, selectors, ctx) {
  const el = await queryVisible(page, selectors, ctx);
  if (!el) return null;
  await sleep(rand(300, 800));
  await el.loc.evaluate(e => e.scrollIntoView({ behavior: 'instant', block: 'center' })).catch(() => {});
  await sleep(rand(100, 300));
  await el.loc.click({ force: false });
  const txt = await el.loc.textContent().catch(() => '');
  logAndPrint('click', { ctx, selector: el.sel, text: txt?.trim()?.slice(0, 60) });
  dlog(`Click [${ctx}] -> ${el.sel}`);
  return el;
}

async function shoot(page, label) {
  const file = path.join(SCREENSHOT_DIR, `${label}_${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  dlog(`Screenshot: ${file}`);
  return file;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALENDAR READY POLLING (NEW — fixes two-phase loading race)
// ═══════════════════════════════════════════════════════════════════════════════
async function waitForCalendarReady(page, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // Positive signal 1: available day cells rendered
    const hasDays = await page.locator('.day-cell, [class*="day-cell"], td.available').first().count() > 0;
    // Positive signal 2: no-slots banner appeared
    const hasNoSlots = await pageHasText(page, NO_SLOTS_RE);
    // Positive signal 3: calendar grid skeleton visible
    const hasGrid = await page.locator('.calendar-grid, [class*="calendar"], .tls-calendar').first().count() > 0;

    if (hasNoSlots) return 'NO_SLOTS';
    if (hasDays && hasGrid) return 'READY';
    await sleep(300);
  }
  return 'TIMEOUT';
}

// ═══════════════════════════════════════════════════════════════════════════════
// SELECTORS
// ═══════════════════════════════════════════════════════════════════════════════
let SELECTORS;
try {
  SELECTORS = JSON.parse(fs.readFileSync(SELECTORS_PATH, 'utf8'))[COUNTRY];
} catch {
  SELECTORS = {
    month_tab: 'a[href*="month="]',
    day_cell: '.day-cell',
    slot_button: '.tls-time-unit',
    slot_available: '.tls-time-unit.available',
    no_slots_text: "We currently don't have any appointment slots available.",
  };
}

const NO_SLOTS_RE = /We currently don't have any appointment slots available|no appointments available|Unfortunately.*no appointments|aucun créneau|pas de rendez-vous/i;
const CF_RE = /checking your browser|you have been blocked|ray id|cloudflare|ddos protection|attention required/i;
const BOOKED_RE = /order.summary|confirmation|success|booking.summary|récapitulatif|confirmed|booked/i;
const ERROR_RE = /no longer available|déjà réservé|already booked|session expired|expirée|please try again|une erreur|error occurred/i;
const ALREADY_BOOKED_RE = /you already have an appointment|vous avez déjà|existing appointment|appointment already booked/i;

const SPINNER_SELS = ['.loading-spinner', '.spinner', '[class*="spinner"]', '[class*="loading"]', '.ajax-loader', '.tls-loader'];
const NEXT_MONTH_SELS = [
  '.tls-calendar .next', '.calendar-nav-next', '[class*="calendar"] [class*="next"]',
  'button[aria-label*="next" i]', 'button:has-text("›")', 'button:has-text(">")', '[data-direction="next"]'
];
const AVAIL_DAY_SELS = [
  '.day-cell.available', '.day-cell.day--available', '[class*="day-cell"][class*="available"]',
  '.day-cell:not(.disabled):not(.past):not(.other-month)'
];
const BOOK_BTN_SELS = [
  'button:has-text("Book")', 'button:has-text("Confirm")', 'button:has-text("Submit")',
  'button:has-text("Réserver")', 'button:has-text("Confirmer")',
  '#bookBtn', '[data-testid="book-button"]', 'button[type="submit"]'
];

// ═══════════════════════════════════════════════════════════════════════════════
// HOT WINDOW (Algiers TZ)
// ═══════════════════════════════════════════════════════════════════════════════
function isHotWindow() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Algiers' }));
  const m = d.getHours() * 60 + d.getMinutes();
  return (m >= 535 && m <= 555) || (m >= 835 && m <= 855);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════════
let cycleNumber = 0;
const nextCycle = () => { cycleNumber++; return `CYCLE #${cycleNumber}`; };

async function stepWaitAppointment(page) {
  dlog('Step: WAIT_APPOINTMENT');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes('/appointment-booking')) {
      logAndPrint('appointment_reached', { url });
      return 'CONTINUE';
    }
    if (url.includes('/service-level')) {
      await stableClick(page, ['button:has-text("Standard")', 'a:has-text("Standard")'], 'service_standard');
      await sleep(1000);
      await stableClick(page, ['button:has-text("Continue")', 'a:has-text("Continue")'], 'service_continue');
      await sleep(2000);
      continue;
    }
    if (ALREADY_BOOKED_RE.test(await pageInnerText(page))) {
      logAndPrint('already_booked_detected');
      tg.push('ℹ️ You already have an appointment. Bot stopping.');
      return 'ALREADY_BOOKED';
    }
    await sleep(800);
  }
  logAndPrint('appointment_timeout');
  return 'NO_SLOTS';
}

async function stepCourier(page) {
  dlog('Step: COURIER');
  const modal = await queryVisible(page, ['#courier-step', '[id*="courier"]', '.modal:has-text("Courier")']);
  if (modal) {
    await stableClick(page, ['button:has-text("Continue")', 'button:has-text("Next")'], 'courier_dismiss');
    await sleep(800);
  }
  return 'CONTINUE';
}

async function stepCheckNoSlots(page) {
  dlog('Step: CHECK_NO_SLOTS');
  const text = await pageInnerText(page);
  if (NO_SLOTS_RE.test(text)) {
    logAndPrint('no_slots_text');
    return 'NO_SLOTS';
  }
  const css = await queryVisible(page, ['.no-slots', '#noSlotsMsg', '[class*="no-slot"]', '[class*="empty-state"]']);
  if (css) {
    logAndPrint('no_slots_css', { selector: css.sel });
    return 'NO_SLOTS';
  }
  return 'CONTINUE';
}

async function stepMonthTab(page) {
  dlog('Step: MONTH_TAB');
  if (await pageHasText(page, NO_SLOTS_RE)) return 'NO_SLOTS';

  for (let attempt = 0; attempt < 4; attempt++) {
    if (await pageHasText(page, NO_SLOTS_RE)) return 'NO_SLOTS';

    const day = await queryVisible(page, AVAIL_DAY_SELS);
    if (day) {
      const isPast = await day.loc.evaluate(el => el.classList.contains('past') || el.classList.contains('disabled')).catch(() => true);
      if (!isPast) {
        logAndPrint('month_has_days', { attempt, selector: day.sel });
        return 'CONTINUE';
      }
    }

    if (attempt >= 3) break;
    const next = await queryVisible(page, NEXT_MONTH_SELS);
    if (!next) { logAndPrint('next_month_missing', { attempt }); break; }

    await sleep(rand(400, 900));
    await next.loc.click();
    logAndPrint('next_month_click', { attempt });

    // FIX: Active polling instead of blind sleep
    const ready = await waitForCalendarReady(page, 10000);
    if (ready === 'NO_SLOTS') {
      logAndPrint('month_no_slots_after_nav');
      return 'NO_SLOTS';
    }
    if (ready === 'TIMEOUT') {
      logAndPrint('month_nav_timeout', { attempt });
      // Continue loop — maybe next attempt works
    }
  }
  return 'NO_SLOTS';
}

async function stepSelectDay(page) {
  dlog('Step: SELECT_DAY');
  const pats = [...AVAIL_DAY_SELS, SELECTORS.day_cell].filter(Boolean);
  for (let retry = 0; retry < 3; retry++) {
    const res = await queryVisible(page, pats);
    if (res) {
      await sleep(rand(200, 600));
      const valid = await res.loc.evaluate(el =>
        !el.classList.contains('past') &&
        !el.classList.contains('disabled') &&
        !el.classList.contains('other-month')
      ).catch(() => false);
      if (valid) {
        await res.loc.evaluate(e => e.scrollIntoView({ block: 'center' }));
        await sleep(200);
        // FIX: Re-check visibility after scroll before click
        if (await res.loc.isVisible().catch(() => false)) {
          await res.loc.click();
          logAndPrint('day_clicked', { selector: res.sel });
          await sleep(800);
          return 'CONTINUE';
        }
      }
    }
    await sleep(1200);
  }
  logAndPrint('day_not_found');
  return 'NO_SLOTS';
}

async function stepSpinnerAndTime(page) {
  dlog('Step: SPINNER_TIME');
  for (const sel of SPINNER_SELS) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      logAndPrint('spinner_wait', { selector: sel });
      await loc.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
      break;
    }
  }

  const slotSel = SELECTORS.slot_button || '.tls-time-unit';
  const appeared = await page.locator(slotSel).first()
    .waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  if (!appeared) { logAndPrint('time_slots_missing'); return 'NO_SLOTS'; }

  const pats = [SELECTORS.slot_available, slotSel, 'button[data-time]', '[class*="time-slot"]:not([disabled])'].filter(Boolean);
  const res = await queryVisible(page, pats);
  if (!res) { logAndPrint('no_time_slot'); return 'NO_SLOTS'; }

  await sleep(rand(200, 600));
  await res.loc.evaluate(e => e.scrollIntoView({ block: 'center' }));
  await sleep(200);
  await res.loc.click();
  logAndPrint('time_clicked', { selector: res.sel });

  await sleep(600);
  const isSelected = await res.loc.evaluate(el =>
    el.classList.contains('selected') || el.classList.contains('active') || el.getAttribute('aria-selected') === 'true'
  ).catch(() => true);
  if (!isSelected) {
    logAndPrint('time_selection_failed');
    return 'NO_SLOTS';
  }
  return 'CONTINUE';
}

async function stepBook(page) {
  dlog('Step: BOOK');
  const res = await queryVisible(page, BOOK_BTN_SELS);
  if (!res) { logAndPrint('book_btn_missing'); return 'NO_SLOTS'; }

  if (DRY_RUN) {
    logAndPrint('dry_run_book_skipped');
    const shot = await shoot(page, 'dry_run_book');
    tg.push('🧪 DRY RUN — Would have booked. Screenshot attached.', shot);
    return 'BOOKED';
  }

  await sleep(rand(300, 700));
  await res.loc.evaluate(e => e.scrollIntoView({ block: 'center' }));
  await sleep(200);
  await res.loc.click();
  logAndPrint('book_clicked', { selector: res.sel });
  await sleep(1500);
  return 'CONTINUE';
}

async function stepConfirmation(page) {
  dlog('Step: CONFIRMATION');
  const start = Date.now();
  // FIX: 15s timeout instead of 25s — slots vanish fast, don't wait forever
  while (Date.now() - start < 15000) {
    const url = page.url();
    const text = await pageInnerText(page);

    if (BOOKED_RE.test(url + ' ' + text)) {
      const shot = await shoot(page, 'confirmation');
      logAndPrint('booked_url', { url });
      tg.push('✅ BOOKING SUCCESS\nAppointment booked! Check screenshot.', shot);
      return 'BOOKED';
    }

    if (ERROR_RE.test(text)) {
      logAndPrint('booking_error_text', { text: text.slice(0, 200) });
      return 'NO_SLOTS';
    }

    const modal = await queryVisible(page, ['.modal-overlay.active', '.modal.active', '[class*="confirmation"]', '[class*="success-modal"]']);
    if (modal) {
      const ok = page.locator('button:has-text("OK"), button:has-text("Confirm"), .modal-confirm').first();
      if (await ok.count() > 0 && await ok.isVisible()) {
        await ok.click();
        await sleep(1000);
      }
      const shot = await shoot(page, 'confirmation_modal');
      logAndPrint('booked_modal');
      tg.push('✅ BOOKING SUCCESS (modal)\nAppointment booked! Check screenshot.', shot);
      return 'BOOKED';
    }

    await sleep(600);
  }
  logAndPrint('confirmation_timeout');
  return 'NO_SLOTS';
}

const STEPS = [
  { name: 'WAIT_APPOINTMENT', fn: stepWaitAppointment },
  { name: 'COURIER', fn: stepCourier },
  { name: 'CHECK_NO_SLOTS', fn: stepCheckNoSlots },
  { name: 'MONTH_TAB', fn: stepMonthTab },
  { name: 'SELECT_DAY', fn: stepSelectDay },
  { name: 'SPINNER_TIME', fn: stepSpinnerAndTime },
  { name: 'BOOK', fn: stepBook },
  { name: 'CONFIRMATION', fn: stepConfirmation },
];

async function runMachine(page) {
  for (const step of STEPS) {
    try {
      const result = await Promise.race([
        step.fn(page),
        // FIX: 25s step timeout instead of 35s
        new Promise((_, reject) => setTimeout(() => reject(new Error('STEP_TIMEOUT')), 25000))
      ]);
      if (result === 'NO_SLOTS') { dlog(`-> NO_SLOTS at ${step.name}`); return false; }
      if (result === 'BOOKED') { dlog(`-> BOOKED at ${step.name}`); return true; }
      if (result === 'ALREADY_BOOKED') { dlog(`-> ALREADY_BOOKED at ${step.name}`); process.exit(0); }
    } catch (e) {
      logAndPrint('step_error', { step: step.name, error: e.message });
      dlog(`-> ERROR at ${step.name}: ${e.message}`);
      return false;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAFE RELOAD (with positive DOM confirmation)
// ═══════════════════════════════════════════════════════════════════════════════
async function safeReload(page) {
  const currentUrl = page.url();
  if (currentUrl.includes('month=')) {
    try {
      await page.evaluate(() => {
        const u = new URL(window.location.href);
        u.searchParams.delete('month');
        history.replaceState(null, '', u.toString());
      });
      dlog('Stripped month param');
    } catch (e) { dlog(`Month strip failed: ${e.message}`); }
  }

  logAndPrint('page_reload');
  dlog(`Reloading ${page.url()}`);
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});

  // FIX: Wait for calendar skeleton OR no-slots before proceeding
  const ready = await waitForCalendarReady(page, 15000);
  if (ready === 'NO_SLOTS') {
    dlog('Reload detected no slots immediately');
  } else if (ready === 'TIMEOUT') {
    dlog('Reload calendar ready timeout — proceeding cautiously');
  } else {
    dlog('Calendar DOM ready after reload');
  }

  await sleep(rand(1500, 2500)); // Reduced from 2-3.5s since we actively waited
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOUDFLARE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
async function handleCloudflare(page) {
  let backoff = 60000;
  while (true) {
    // FIX: Proper await precedence — was string concat bug
    const bodyText = await pageInnerText(page);
    const titleText = await page.title().catch(() => '');
    const combined = (bodyText + ' ' + titleText).toLowerCase();
    if (!CF_RE.test(combined)) break;

    const hot = isHotWindow();
    const wait = Math.min(backoff, hot ? 300000 : 3600000);
    logAndPrint('cloudflare_block', { waitMs: wait });
    tg.push(`⚠️ Cloudflare block — backing off ${wait / 1000}s`);
    await sleep(wait);
    await safeReload(page);
    backoff = Math.min(backoff * 2, 3600000);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════════════
(async () => {
  if (!TG_TOKEN || !TG_CHAT) console.warn('Telegram not configured');
  logAndPrint('soldier_start', { country: COUNTRY, cdpPort: CDP_PORT, dryRun: DRY_RUN });
  tg.push('🚀 Soldier started. Navigate to appointment page when ready.');
  await connectCDP(10);
  let page = await getPage();

  let lastCycleEnd = 0;
  const MIN_CYCLE_GAP = { hot: 8000, cold: 60000 };

  while (true) {
    try {
      page = await getPage();
      const url = page.url();
      const label = nextCycle();
      logAndPrint('tick', { url });
      dlog(`=== ${label} ===`);

      await handleCloudflare(page);

      // ═══════════════════════════════════════════════════════════════════════════════
// SESSION RECOVERY (replaces the old /login handler)
// ═══════════════════════════════════════════════════════════════════════════════

const SESSION_STATES = {
  HEALTHY: 'HEALTHY',
  NEEDS_RELOGIN: 'NEEDS_RELOGIN',      // Warm session, just re-auth
  NEEDS_CAPTCHA: 'NEEDS_CAPTCHA',      // Cloudflare/CAPTCHA gate
  FULL_EXPIRED: 'FULL_EXPIRED',        // Cold session, full re-login
};

async function detectSessionState(page) {
  const url = page.url();
  const text = await pageInnerText(page);
  const title = await page.title().catch(() => '');

  // Tier 1: Full expired — on login page with no session cookie hint
  if (url.includes('/login') || url.includes('/signin')) {
    // Check if there's a "remember me" or saved credential indicator
    const hasSavedCreds = await page.locator('input[type="email"]:prefilled, input[type="text"]:prefilled, input[autocomplete="email"]').count() > 0;
    if (hasSavedCreds) return { state: SESSION_STATES.NEEDS_RELOGIN, reason: 'saved_credentials_detected' };
    return { state: SESSION_STATES.FULL_EXPIRED, reason: 'cold_login_page' };
  }

  // Tier 2: CAPTCHA/Cloudflare challenge
  if (await pageHasCaptcha(page)) {
    return { state: SESSION_STATES.NEEDS_CAPTCHA, reason: 'captcha_detected' };
  }
  if (CF_RE.test(text + ' ' + title)) {
    return { state: SESSION_STATES.NEEDS_CAPTCHA, reason: 'cloudflare_challenge' };
  }

  // Tier 3: Appointment page but session might be stale (AJAX returns 401)
  if (url.includes('/appointment-booking')) {
    const hasCalendar = await page.locator('.day-cell, [class*="calendar"], .calendar-grid').first().count() > 0;
    if (!hasCalendar) {
      // Page loaded but no calendar = session expired mid-AJAX
      return { state: SESSION_STATES.NEEDS_RELOGIN, reason: 'appointment_page_no_calendar' };
    }
  }

  return { state: SESSION_STATES.HEALTHY };
}

async function handleSessionRecovery(page) {
  const { state, reason } = await detectSessionState(page);

  switch (state) {
    case SESSION_STATES.HEALTHY:
      return true; // Proceed normally

    case SESSION_STATES.NEEDS_RELOGIN: {
      // Warm session — user just needs to click "Log in" or re-auth
      logAndPrint('session_needs_relogin', { reason });
      tg.push(`🔑 Session warm — please re-login (saved password should work). Reason: ${reason}`);
      
      // Wait up to 5 minutes for user to re-login, checking every 5s
      const deadline = Date.now() + 300000; // 5 minutes
      while (Date.now() < deadline) {
        await sleep(5000);
        const url = page.url();
        if (url.includes('/appointment-booking')) {
          logAndPrint('session_recovered');
          tg.push('✅ Session recovered — bot resuming');
          return true;
        }
        // If still on login after 2 minutes, extend wait or alert again
        if (Date.now() - deadline > -180000 && url.includes('/login')) {
          tg.push('⏳ Still waiting for re-login... 3 minutes remaining');
        }
      }
      logAndPrint('session_relogin_timeout');
      tg.push('❌ Re-login timeout — bot pausing for 10 minutes');
      await sleep(600000); // 10 min cooldown before trying again
      return false;
    }

    case SESSION_STATES.NEEDS_CAPTCHA: {
      logAndPrint('session_captcha', { reason });
      tg.push(`🛡️ CAPTCHA/Challenge detected — please solve manually. Reason: ${reason}`);
      
      // Wait up to 10 minutes for manual solve
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        await sleep(5000);
        const check = await detectSessionState(page);
        if (check.state === SESSION_STATES.HEALTHY) {
          logAndPrint('captcha_resolved');
          tg.push('✅ Challenge resolved — bot resuming');
          return true;
        }
      }
      logAndPrint('captcha_timeout');
      tg.push('❌ Challenge timeout — bot backing off 30 minutes');
      await sleep(1800000); // 30 min
      return false;
    }

    case SESSION_STATES.FULL_EXPIRED: {
      logAndPrint('session_fully_expired', { reason });
      tg.push('🔴 Session fully expired — full re-login required. Bot pausing 1 hour.');
      await sleep(3600000); // 1 hour
      return false;
    }
  }
}
// After session recovery succeeds
if (!page.url().includes('/appointment-booking')) {
  logAndPrint('navigating_to_appointment');
  // Try to find and click "Book Appointment" or similar
  const bookLink = await queryVisible(page, [
    'a:has-text("Book")', 'a:has-text("Appointment")',
    'button:has-text("Book")', '[href*="appointment-booking"]'
  ]);
  if (bookLink) {
    await stableClick(page, [bookLink.sel], 'navigate_to_appointment');
    await sleep(3000);
  }
}
      const hot = isHotWindow();
      const gap = hot ? rand(MIN_CYCLE_GAP.hot, MIN_CYCLE_GAP.hot + 3000) : rand(MIN_CYCLE_GAP.cold, MIN_CYCLE_GAP.cold + 30000);
      const sinceLast = Date.now() - lastCycleEnd;
      if (sinceLast < gap) {
        const wait = gap - sinceLast;
        dlog(`Rate limit: sleeping ${wait}ms (min gap)`);
        await sleep(wait);
      }

      await safeReload(page);

      const booked = await runMachine(page);
      lastCycleEnd = Date.now();

      if (booked) {
        logAndPrint('success');
        tg.push('🎉 Appointment secured! Bot stopping — go pay NOW!');
        cleanup();
        process.exit(0);
      }

      logAndPrint('cycle_no_slots');

      if (page.url().includes('month=')) {
        try {
          await page.evaluate(() => { const u = new URL(window.location.href); u.searchParams.delete('month'); history.replaceState(null, '', u.toString()); });
        } catch {}
      }

    } catch (e) {
      logAndPrint('loop_error', { error: e.message });
      dlog(`Loop error: ${e.message}`);
      lastCycleEnd = Date.now();
      await sleep(5000);
    }
  }
})();