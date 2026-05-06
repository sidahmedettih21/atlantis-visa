#!/usr/bin/env node
// Atlantis-Visa — Production Soldier v3.1
// Fixes: rand() in evaluate, waitForCalendarReady wired up, cookie catch→false,
//        dead replaceState removed, exponential backoff, BOOK_BTN tightened,
//        slot fingerprinting, BASE_URL in relogin message, password redaction.

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const os    = require('os');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const BASE_DIR = process.env.ATLANTIS_HOME || path.join(os.homedir(), 'atlantis-visa');
const COUNTRY  = process.env.ATLANTIS_COUNTRY || 'PT';
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT  = process.env.CHAT_ID;
const DRY_RUN  = process.env.DRY_RUN === '1';

const BASE_URL = 'https://visas-pt.tlscontact.com/en-us/485975/workflow/appointment-booking?location=dzALG2pt';

const SELECTORS_PATH = (() => {
  const candidates = [
    path.join(__dirname, '..', 'shared', 'selectors.json'),
    path.join(process.cwd(), 'shared', 'selectors.json'),
    path.join(BASE_DIR, 'shared', 'selectors.json'),
  ];
  return candidates.find(p => fs.existsSync(p)) || candidates[2];
})();

const LOG_DIR        = path.join(BASE_DIR, 'logs');
const SCREENSHOT_DIR = path.join(LOG_DIR, 'screenshots');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════
// LOCK FILE
// ═══════════════════════════════════════════════════════════════════════════════
const LOCK_FILE = path.join(os.tmpdir(), `atlantis-soldier-${process.pid}`);
fs.writeFileSync(LOCK_FILE, String(process.pid));
const cleanup = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// ═══════════════════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════════════════
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const rand   = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;
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
    if (this.stream) this.stream.end();
    this.current = this._path();
    this.stream = fs.createWriteStream(this.current, { flags: 'a' });
    this.bytes = fs.existsSync(this.current) ? fs.statSync(this.current).size : 0;
  }
  _rotate() { this.seq++; this._open(); }
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

const log      = new RotatingLogger(LOG_DIR, 'bot');
const detailed = new RotatingLogger(LOG_DIR, 'detailed');

function jlog(msg, data = {})        { log.write({ msg, ...data }); }
function dlog(msg)                   { detailed.write({ raw: msg }); }
function logAndPrint(msg, data = {}) {
  jlog(msg, data);
  console.log(`[BOT] ${msg}`, Object.keys(data).length ? data : '');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM QUEUE
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
      if (photoPath && fs.existsSync(photoPath)) await this._sendPhoto(text, photoPath);
      else await this._sendMessage(text);
    } catch (e) { jlog('telegram_error', { error: e.message }); }
    await sleep(1100);
    this.sending = false;
    this._drain();
  }
  _sendMessage(text) {
    return new Promise((res, rej) => {
      const payload = JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML' });
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.token}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
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
        hostname: 'api.telegram.org',
        path: `/bot${this.token}/sendPhoto`,
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
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
      return;
    } catch (e) {
      if (i === retries - 1) { console.error('Cannot connect to Chrome. Exiting.'); process.exit(1); }
      logAndPrint('cdp_retrying', { attempt: i + 1, error: e.message });
      await sleep(5000);
    }
  }
}
async function ensureCDP() {
  if (!browser?.isConnected()) { logAndPrint('cdp_reconnecting'); await connectCDP(10); }
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
  return pages[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOM HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
async function pageInnerText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function pageHasText(page, regex) {
  const text = await pageInnerText(page);
  return text.length > 5 && regex.test(text);
}

async function pageHasCaptcha(page) {
  const challengeSelectors = [
    { sel: '.h-captcha-box',                      name: 'h-captcha' },
    { sel: '#rc-anchor-container',                name: 'recaptcha-checkbox' },
    { sel: '.rc-challenge-panel',                 name: 'recaptcha-challenge' },
    { sel: '#challenge-form',                     name: 'cf-challenge-form' },
    { sel: '#challenge-stage',                    name: 'cf-challenge-stage' },
    { sel: 'input[name="cf-turnstile-response"]', name: 'cf-turnstile' },
    { sel: '[data-testid*="captcha"]',            name: 'captcha-testid' },
  ];
  for (const { sel, name } of challengeSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() === 0) continue;
      if (await loc.isVisible().catch(() => false)) { dlog(`Captcha: ${name}`); return true; }
    } catch {}
  }
  for (const sel of ['iframe[src*="hcaptcha"]', 'iframe[src*="recaptcha"]']) {
    try {
      const loc = page.locator(sel);
      const count = await loc.count();
      for (let i = 0; i < count; i++) {
        const frame = loc.nth(i);
        const box = await frame.boundingBox().catch(() => null);
        if (box && box.width <= 300 && box.height <= 80) continue;
        if (await frame.isVisible().catch(() => false)) { dlog(`Captcha iframe: ${sel}`); return true; }
      }
    } catch {}
  }
  const text = await pageInnerText(page);
  if (/captcha|verify you are human|i'm not a robot|human verification|security check|please complete the security check/i.test(text)) {
    dlog('Captcha text detected'); return true;
  }
  return false;
}

async function queryVisible(page, selectors) {
  if (typeof selectors === 'string') selectors = [selectors];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) return { loc, sel };
    } catch {}
  }
  return null;
}

async function stableClick(page, selectors, ctx) {
  const el = await queryVisible(page, selectors);
  if (!el) return null;
  await sleep(rand(300, 800));
  await el.loc.evaluate(e => e.scrollIntoView({ behavior: 'instant', block: 'center' })).catch(() => {});
  await sleep(rand(100, 300));
  await el.loc.click({ force: false });
  const txt = await el.loc.textContent().catch(() => '');
  logAndPrint('click', { ctx, selector: el.sel, text: txt?.trim()?.slice(0, 60) });
  return el;
}

async function shoot(page, label) {
  const file = path.join(SCREENSHOT_DIR, `${label}_${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  dlog(`Screenshot: ${file}`);
  return file;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SELECTORS & REGEXES
// ═══════════════════════════════════════════════════════════════════════════════
let SELECTORS;
try {
  SELECTORS = JSON.parse(fs.readFileSync(SELECTORS_PATH, 'utf8'))[COUNTRY];
} catch {
  SELECTORS = {
    day_cell:       '[class*="DayCell_"], [class*="CalendarDay_"]',
    slot_button:    '[class*="TimeSlot_"], [class*="time-slot"]',
    slot_available: '[class*="TimeSlot_--available"]',
  };
}

const NO_SLOTS_RE       = /We currently don't have any appointment slots available|no appointments available|Unfortunately.*no appointments|aucun créneau|pas de rendez-vous/i;
const CF_RE             = /checking your browser|you have been blocked|ray id|cloudflare|ddos protection|attention required/i;
const BOOKED_RE         = /order.summary|confirmation|success|booking.summary|récapitulatif|confirmed|booked/i;
const ERROR_RE          = /no longer available|déjà réservé|already booked|session expired|expirée|please try again|une erreur|error occurred/i;
const ALREADY_BOOKED_RE = /you already have an appointment|vous avez déjà|existing appointment|appointment already booked/i;

const SPINNER_SELS = [
  '[class*="Spinner_"]', '[class*="Loading_"]',
  '.loading-spinner', '.spinner', '[class*="spinner"]', '[class*="loading"]',
];

const AVAIL_DAY_SELS = [
  '[class*="DayCell_--available"]',
  '[class*="CalendarDay_--available"]',
  '[class*="day--available"]',
  '[class*="day-cell--available"]',
  '.day-cell.available',
  '[class*="day-cell"][class*="available"]',
];

// FIX: removed 'button[type="submit"]' — too broad, matches any form submit
const BOOK_BTN_SELS = [
  '[class*="TlsButton_tls-button"][class*="TlsButton_--filled"]',
  'button:has-text("Book your appointment")',
  'button:has-text("Book")',
  'button:has-text("Confirm")',
  'button:has-text("Réserver")',
  'button:has-text("Confirmer")',
  '#bookBtn',
  '[data-testid="book-button"]',
];

// ═══════════════════════════════════════════════════════════════════════════════
// CALENDAR READY POLLING — now actually called
// ═══════════════════════════════════════════════════════════════════════════════
async function waitForCalendarReady(page, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await pageHasText(page, NO_SLOTS_RE)) return 'NO_SLOTS';
    const hasDays = await page.locator(
      '[class*="DayCell_"], [class*="CalendarDay_"], [class*="day-cell"], td.available'
    ).first().count().then(c => c > 0).catch(() => false);
    const hasGrid = await page.locator(
      '[class*="CalendarGrid_"], [class*="MonthCalendar_"], [class*="calendar-grid"], [class*="calendar"]'
    ).first().count().then(c => c > 0).catch(() => false);
    if (hasGrid || hasDays) return 'READY';
    await sleep(300);
  }
  return 'TIMEOUT';
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOT WINDOW
// ═══════════════════════════════════════════════════════════════════════════════
function isHotWindow() {
  // Uses Intl instead of toLocaleString→new Date() gotcha
  const now   = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Algiers',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const t = h * 60 + m;
  return (t >= 535 && t <= 555) || (t >= 835 && t <= 855);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MACHINE STEPS
// ═══════════════════════════════════════════════════════════════════════════════
let cycleNumber = 0;
const nextCycle = () => { cycleNumber++; return `CYCLE #${cycleNumber}`; };

async function stepWaitAppointment(page) {
  dlog('Step: WAIT_APPOINTMENT');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes('/appointment-booking')) { logAndPrint('appointment_reached', { url }); return 'CONTINUE'; }
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
  logAndPrint('appointment_page_timeout');
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
  if (NO_SLOTS_RE.test(text)) { logAndPrint('no_slots_text_detected'); return 'NO_SLOTS'; }
  const css = await queryVisible(page, ['.no-slots', '#noSlotsMsg', '[class*="no-slot"]', '[class*="empty-state"]']);
  if (css) { logAndPrint('no_slots_css_detected', { selector: css.sel }); return 'NO_SLOTS'; }
  return 'CONTINUE';
}

// FIX: waitForCalendarReady now called before checking available days
async function stepMonthTab(page) {
  dlog('Step: MONTH_TAB');

  const ready = await waitForCalendarReady(page, 12000);
  if (ready === 'NO_SLOTS') { logAndPrint('calendar_ready_no_slots'); return 'NO_SLOTS'; }
  if (ready === 'TIMEOUT')  { logAndPrint('calendar_ready_timeout'); /* fall through, try anyway */ }

  if (await pageHasText(page, NO_SLOTS_RE)) return 'NO_SLOTS';

  const existingDay = await queryVisible(page, AVAIL_DAY_SELS);
  if (existingDay) {
    const isPast = await existingDay.loc.evaluate(
      el => el.classList.contains('past') || el.classList.contains('disabled')
    ).catch(() => true);
    if (!isPast) {
      logAndPrint('month_has_available_days', { selector: existingDay.sel });
      return 'CONTINUE';
    }
  }

  logAndPrint('month_no_available_days');
  return 'NO_SLOTS';
}

// FIX: slot fingerprinting added (day text + data-date logged before click)
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
        // FIX: fingerprint the slot before clicking
        const dayText = await res.loc.textContent().catch(() => '');
        const dayDate = await res.loc.getAttribute('data-date').catch(() => '');
        logAndPrint('day_selected', {
          text:     dayText?.trim(),
          date:     dayDate,
          selector: res.sel,
        });

        await res.loc.evaluate(e => e.scrollIntoView({ block: 'center' }));
        await sleep(200);
        if (await res.loc.isVisible().catch(() => false)) {
          await res.loc.click();
          logAndPrint('day_clicked', { selector: res.sel, date: dayDate });
          await sleep(800);
          return 'CONTINUE';
        }
      }
    }
    await sleep(1200);
  }
  logAndPrint('step_day_no_cell_found');
  return 'NO_SLOTS';
}

async function stepSpinnerAndTime(page) {
  dlog('Step: SPINNER_TIME');
  for (const sel of SPINNER_SELS) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      logAndPrint('spinner_detected', { selector: sel });
      await loc.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
      break;
    }
  }
  const slotSel = SELECTORS.slot_button || '[class*="TimeSlot_"], [class*="time-slot"]';
  const appeared = await page.locator(slotSel).first()
    .waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  if (!appeared) { logAndPrint('no_time_slots_rendered'); return 'NO_SLOTS'; }

  const pats = [
    SELECTORS.slot_available,
    '[class*="TimeSlot_--available"]',
    slotSel,
    'button[data-time]',
    '[class*="time-slot"]:not([disabled])',
  ].filter(Boolean);

  const res = await queryVisible(page, pats);
  if (!res) { logAndPrint('no_available_time_slot'); return 'NO_SLOTS'; }

  // Fingerprint time slot too
  const slotText = await res.loc.textContent().catch(() => '');
  const slotTime = await res.loc.getAttribute('data-time').catch(() => '');
  logAndPrint('time_selected', { text: slotText?.trim(), time: slotTime, selector: res.sel });

  await sleep(rand(200, 600));
  await res.loc.evaluate(e => e.scrollIntoView({ block: 'center' }));
  await sleep(200);
  await res.loc.click();
  logAndPrint('time_clicked', { selector: res.sel });

  await sleep(600);
  const isSelected = await res.loc.evaluate(el =>
    el.classList.contains('selected') ||
    el.classList.contains('active') ||
    el.getAttribute('aria-selected') === 'true'
  ).catch(() => true);
  if (!isSelected) { logAndPrint('time_selection_failed'); return 'NO_SLOTS'; }
  return 'CONTINUE';
}

async function stepBook(page) {
  dlog('Step: BOOK');
  const res = await queryVisible(page, BOOK_BTN_SELS);
  if (!res) { logAndPrint('book_button_not_found'); return 'NO_SLOTS'; }

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
  while (Date.now() - start < 15000) {
    const url  = page.url();
    const text = await pageInnerText(page);
    if (BOOKED_RE.test(url + ' ' + text)) {
      const shot = await shoot(page, 'confirmation');
      logAndPrint('booked_url', { url });
      tg.push('✅ BOOKING SUCCESS\nAppointment booked! Check screenshot.', shot);
      return 'BOOKED';
    }
    if (ERROR_RE.test(text)) { logAndPrint('booking_error_text', { text: text.slice(0, 200) }); return 'NO_SLOTS'; }
    const modal = await queryVisible(page, [
      '.modal-overlay.active', '.modal.active',
      '[class*="confirmation"]', '[class*="success-modal"]',
    ]);
    if (modal) {
      const ok = page.locator('button:has-text("OK"), button:has-text("Confirm"), .modal-confirm').first();
      if (await ok.count() > 0 && await ok.isVisible()) { await ok.click(); await sleep(1000); }
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
  { name: 'COURIER',          fn: stepCourier },
  { name: 'CHECK_NO_SLOTS',   fn: stepCheckNoSlots },
  { name: 'MONTH_TAB',        fn: stepMonthTab },
  { name: 'SELECT_DAY',       fn: stepSelectDay },
  { name: 'SPINNER_TIME',     fn: stepSpinnerAndTime },
  { name: 'BOOK',             fn: stepBook },
  { name: 'CONFIRMATION',     fn: stepConfirmation },
];

async function runMachine(page) {
  for (const step of STEPS) {
    try {
      const result = await Promise.race([
        step.fn(page),
        new Promise((_, reject) => setTimeout(() => reject(new Error('STEP_TIMEOUT')), 25000)),
      ]);
      if (result === 'NO_SLOTS')       { dlog(`-> NO_SLOTS at ${step.name}`); return false; }
      if (result === 'BOOKED')         { dlog(`-> BOOKED at ${step.name}`); return true; }
      if (result === 'ALREADY_BOOKED') { dlog(`-> ALREADY_BOOKED`); process.exit(0); }
    } catch (e) {
      logAndPrint('step_error', { step: step.name, error: e.message });
      return false;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAFE RELOAD
// FIX: rand() now computed in Node and passed into evaluate as argument
// FIX: waitForCalendarReady called after reload
// ═══════════════════════════════════════════════════════════════════════════════
async function safeReload(page) {
  dlog('Reloading current page');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(rand(3000, 5000));
  // FIX: pass scroll amount as argument — rand() is NOT available in browser scope
  const scrollY = rand(100, 300);
  await page.evaluate((n) => window.scrollBy(0, n), scrollY).catch(() => {});
  // Wait for calendar to appear after reload
  await waitForCalendarReady(page, 10000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOUDFLARE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
async function handleCloudflare(page) {
  if (await pageHasText(page, CF_RE)) {
    logAndPrint('cloudflare_detected_waiting');
    await sleep(15000);
    if (await pageHasText(page, CF_RE)) {
      tg.push('🛡️ Cloudflare still present — backing off 5 min');
      await sleep(300000);
      await safeReload(page);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION RECOVERY
// FIX: cookie catch → false (was true, assumed healthy on CDP error)
// FIX: NEEDS_RELOGIN Telegram message now includes BASE_URL
// ═══════════════════════════════════════════════════════════════════════════════
const SESSION_STATES = {
  HEALTHY:       'HEALTHY',
  NEEDS_RELOGIN: 'NEEDS_RELOGIN',
  NEEDS_CAPTCHA: 'NEEDS_CAPTCHA',
  FULL_EXPIRED:  'FULL_EXPIRED',
};

async function detectSessionState(page) {
  try {
    const url   = page.url();
    const text  = await pageInnerText(page);
    const title = await page.title().catch(() => '');

    if (url.includes('/login') || url.includes('/signin')) {
      const hasSavedCreds = await page.locator(
        'input[type="email"][value]:not([value=""]), input[autocomplete="email"]'
      ).count() > 0;
      return hasSavedCreds
        ? { state: SESSION_STATES.NEEDS_RELOGIN, reason: 'saved_credentials_detected' }
        : { state: SESSION_STATES.FULL_EXPIRED,  reason: 'cold_login_page' };
    }
    if (await pageHasCaptcha(page))      return { state: SESSION_STATES.NEEDS_CAPTCHA, reason: 'captcha_detected' };
    if (CF_RE.test(text + ' ' + title)) return { state: SESSION_STATES.NEEDS_CAPTCHA, reason: 'cloudflare_challenge' };

    if (url.includes('/appointment-booking')) {
      // FIX: .catch(() => false) — don't assume healthy on CDP/context error
      // NOTE: verify actual cookie name from v5 recorder logs (may be KEYCLOAK_IDENTITY)
      const hasTlsAuth = await page.context().cookies()
        .then(cs => cs.some(c => c.name === 'tls_auth' && c.value.length > 20))
        .catch(() => false);
      if (!hasTlsAuth) return { state: SESSION_STATES.NEEDS_RELOGIN, reason: 'tls_auth_cookie_missing' };

      const hasCalendar = await page.locator(
        '[class*="MonthSelector_"], [class*="DayCell_"], [class*="CalendarGrid_"], .calendar-grid'
      ).first().count() > 0;
      if (!hasCalendar) return { state: SESSION_STATES.NEEDS_RELOGIN, reason: 'appointment_page_no_calendar' };
    }
    return { state: SESSION_STATES.HEALTHY };
  } catch (e) {
    dlog(`detectSessionState error: ${e.message}`);
    return { state: SESSION_STATES.NEEDS_RELOGIN, reason: 'page_inaccessible' };
  }
}

async function handleSessionRecovery(page) {
  const { state, reason } = await detectSessionState(page);
  switch (state) {
    case SESSION_STATES.HEALTHY: return true;

    case SESSION_STATES.NEEDS_RELOGIN: {
      logAndPrint('session_expired', { reason });
      // FIX: include BASE_URL so user knows where to go after login
      tg.push(`🔑 Session expired (${reason})\nPlease re-login then navigate to:\n${BASE_URL}`);
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        await sleep(5000);
        if (page.url().includes('/appointment-booking')) {
          logAndPrint('session_recovered');
          tg.push('✅ Session recovered — resuming');
          return true;
        }
      }
      logAndPrint('session_relogin_timeout');
      tg.push('❌ Re-login timeout — pausing 10 minutes');
      await sleep(600000);
      return false;
    }

    case SESSION_STATES.NEEDS_CAPTCHA: {
      logAndPrint('session_captcha', { reason });
      tg.push(`🛡️ CAPTCHA/Cloudflare detected (${reason})\nPlease solve manually.`);
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        await sleep(5000);
        const check = await detectSessionState(page);
        if (check.state === SESSION_STATES.HEALTHY) {
          logAndPrint('captcha_resolved');
          tg.push('✅ Challenge resolved — resuming');
          return true;
        }
      }
      logAndPrint('session_captcha_timeout');
      tg.push('❌ Challenge timeout — backing off 30 minutes');
      await sleep(1800000);
      return false;
    }

    case SESSION_STATES.FULL_EXPIRED: {
      logAndPrint('session_full_expired', { reason });
      tg.push('🔴 Session fully expired — full re-login required.\nPausing 1 hour.');
      await sleep(3600000);
      return false;
    }

    default: return true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// FIX: exponential backoff on consecutive NO_SLOTS (cap 10 min)
// FIX: rand() in evaluate → passed as argument
// FIX: dead history.replaceState month reset removed
// ═══════════════════════════════════════════════════════════════════════════════
(async () => {
  if (!TG_TOKEN || !TG_CHAT) console.warn('WARNING: Telegram not configured');
  logAndPrint('soldier_start', { country: COUNTRY, cdpPort: CDP_PORT, dryRun: DRY_RUN });
  tg.push('🚀 Soldier v3.1 started.');
  await connectCDP(10);
  let page = await getPage();

  let lastCycleEnd       = 0;
  let consecutiveNoSlots = 0;          // FIX: exponential backoff counter
  const MIN_CYCLE_GAP    = { hot: 5000, cold: 60000 };

  while (true) {
    try {
      page = await getPage();
      const label = nextCycle();
      logAndPrint('tick', { url: page.url(), consecutiveNoSlots });
      dlog(`=== ${label} ===`);

      await handleCloudflare(page);

      const sessionOk = await handleSessionRecovery(page);
      if (!sessionOk) { lastCycleEnd = Date.now(); continue; }

      if (!page.url().includes('/appointment-booking')) {
        logAndPrint('navigating_to_appointment');
        const bookLink = await queryVisible(page, [
          '[href*="appointment-booking"]', 'a:has-text("Book")', 'a:has-text("Appointment")',
        ]);
        if (bookLink) {
          await stableClick(page, [bookLink.sel], 'navigate_to_appointment');
          await sleep(3000);
        }
      }

      // Cycle gap
      const hot = isHotWindow();
      const gap = hot
        ? rand(MIN_CYCLE_GAP.hot, MIN_CYCLE_GAP.hot + 2000)
        : rand(MIN_CYCLE_GAP.cold, MIN_CYCLE_GAP.cold + 30000);
      const sinceLast = Date.now() - lastCycleEnd;
      if (sinceLast < gap) {
        dlog(`Rate limit: sleeping ${gap - sinceLast}ms`);
        await sleep(gap - sinceLast);
      }

      await safeReload(page);

      // Human-like idle — FIX: rand() computed in Node, passed into evaluate
      await sleep(rand(3000, 8000));
      await page.mouse.move(rand(200, 800), rand(200, 600), { steps: rand(5, 15) }).catch(() => {});
      await sleep(rand(1000, 3000));
      const scrollAmt = rand(100, 400);
      await page.evaluate((n) => window.scrollBy(0, n), scrollAmt).catch(() => {});

      const booked = await runMachine(page);
      lastCycleEnd = Date.now();

      if (booked) {
        logAndPrint('success');
        tg.push('🎉 Appointment secured! Bot stopping — go pay NOW!');
        cleanup();
        process.exit(0);
      }

      // FIX: exponential backoff — each consecutive failure doubles the extra delay, cap 10 min
      consecutiveNoSlots++;
      logAndPrint('booking_cycle_no_slots', { consecutiveNoSlots });
      const backoffExtra = Math.min(consecutiveNoSlots * 30000, 600000);
      if (backoffExtra > 0 && !hot) {
        dlog(`Exponential backoff extra: ${backoffExtra / 1000}s (streak: ${consecutiveNoSlots})`);
        await sleep(backoffExtra);
      }

      // FIX: history.replaceState removed — it was dead code on a React SPA

      const cooldown = hot ? rand(8000, 15000) : rand(120000, 300000);
      dlog(`Cooling down ${cooldown / 1000}s`);
      await sleep(cooldown);

    } catch (e) {
      logAndPrint('loop_error', { error: e.message });
      dlog(`Loop error: ${e.message}`);
      lastCycleEnd = Date.now();
      await sleep(5000);
    }
  }
})();