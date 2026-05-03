#!/usr/bin/env node
// Atlantis-Visa — Production Soldier v2.2
// CDP-attached, real Chrome, zero-navigation, bulletproof state machine
// Fixes v2.2: pageHasCaptcha defined, handleSessionRecovery wired up,
//             real TLS selectors from layout scraper, month tab nav uses URL wait,
//             safeReload uses domcontentloaded, hot window gap tightened

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

const LOG_DIR        = path.join(BASE_DIR, 'logs');
const SCREENSHOT_DIR = path.join(LOG_DIR, 'screenshots');

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════
// LOCK FILE (dashboard heartbeat)
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

function jlog(msg, data = {})       { log.write({ msg, ...data }); }
function dlog(msg)                  { detailed.write({ raw: msg }); }
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
      dlog('CDP connected');
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

// FIX v2.2: pageHasCaptcha was called but never defined — fatal crash on every cycle
async function pageHasCaptcha(page) {
  const count = await page.locator(
    'iframe[src*="hcaptcha"], iframe[src*="recaptcha"], [class*="captcha"], #challenge-form, #challenge-stage'
  ).count().catch(() => 0);
  if (count > 0) return true;
  return pageHasText(page, /captcha|verify you are human|i.m not a robot|human verification|challenge/i);
}

async function queryVisible(page, selectors, ctx = '') {
  if (typeof selectors === 'string') selectors = [selectors];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      const count = await loc.count();
      if (count > 0 && await loc.isVisible().catch(() => false)) return { loc, sel };
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
// CALENDAR READY POLLING
// Note: month navigation on real TLS = full URL change (?month=MM-YYYY).
// After the URL settles, we poll for calendar content or the no-slots banner.
// ═══════════════════════════════════════════════════════════════════════════════
async function waitForCalendarReady(page, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await pageHasText(page, NO_SLOTS_RE)) return 'NO_SLOTS';

    // Day cells — real TLS uses CSS Modules; class prefix is stable, hash suffix can change.
    // Fallbacks cover any future redesign or simulation.
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
// SELECTORS
// ═══════════════════════════════════════════════════════════════════════════════
let SELECTORS;
try {
  SELECTORS = JSON.parse(fs.readFileSync(SELECTORS_PATH, 'utf8'))[COUNTRY];
} catch {
  SELECTORS = {
    month_tab:      '[class*="MonthSelector_month-selector_button"]',
    month_tab_next: '[class*="MonthSelector_--active"]',
    day_cell:       '[class*="DayCell_"], [class*="CalendarDay_"]',
    slot_button:    '[class*="TimeSlot_"], [class*="time-slot"]',
    slot_available: '[class*="TimeSlot_--available"]',
    no_slots_text:  "We currently don't have any appointment slots available.",
  };
}

const NO_SLOTS_RE     = /We currently don't have any appointment slots available|no appointments available|Unfortunately.*no appointments|aucun créneau|pas de rendez-vous/i;
const CF_RE           = /checking your browser|you have been blocked|ray id|cloudflare|ddos protection|attention required/i;
const BOOKED_RE       = /order.summary|confirmation|success|booking.summary|récapitulatif|confirmed|booked/i;
const ERROR_RE        = /no longer available|déjà réservé|already booked|session expired|expirée|please try again|une erreur|error occurred/i;
const ALREADY_BOOKED_RE = /you already have an appointment|vous avez déjà|existing appointment|appointment already booked/i;

const SPINNER_SELS = [
  '[class*="Spinner_"]', '[class*="Loading_"]',
  '.loading-spinner', '.spinner', '[class*="spinner"]', '[class*="loading"]',
  '.ajax-loader', '.tls-loader',
];

// FIX v2.2: Real TLS has no calendar nav arrows — next month = clicking the non-selected tab.
// Confirmed from layout scraper: class "MonthSelector_--active" = clickable future month tabs.
const NEXT_MONTH_SELS = [
  '[class*="MonthSelector_--active"]',                   // Real TLS: future month tabs (confirmed)
  '[class*="month-selector"][class*="active"]',          // Generic fallback
  '[class*="MonthSelector_month-selector_button"]:not([class*="--selected"])', // Any non-selected month tab
  // Legacy fallbacks (simulation / older TLS versions)
  '.tls-calendar .next', '.calendar-nav-next',
  '[class*="calendar"] [class*="next"]',
  'button[aria-label*="next" i]',
];

// FIX v2.2: Day cells — no slots were available during scraping so classes are inferred.
// Broad fallbacks ordered by specificity. Remove the dangerous :not() last-resort that matches ALL cells.
const AVAIL_DAY_SELS = [
  '[class*="DayCell_--available"]',
  '[class*="CalendarDay_--available"]',
  '[class*="day--available"]',
  '[class*="day-cell--available"]',
  '.day-cell.available',
  '.day-cell.day--available',
  '[class*="day-cell"][class*="available"]',
];

// FIX v2.2: Book button confirmed from layout scraper.
// TlsButton_tls-button__syUS5 TlsButton_--filled__1vb1H — use prefix matching (hash changes per deploy).
const BOOK_BTN_SELS = [
  '[class*="TlsButton_tls-button"][class*="TlsButton_--filled"]', // Confirmed from real site
  'button:has-text("Book your appointment")',                       // Confirmed text from real site
  'button:has-text("Book")',
  'button:has-text("Confirm")',
  'button:has-text("Réserver")',
  '#bookBtn',
  '[data-testid="book-button"]',
  'button[type="submit"]',
];

// ═══════════════════════════════════════════════════════════════════════════════
// HOT WINDOW (Algiers TZ = Portugal TZ in summer, both UTC+1)
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
  if (NO_SLOTS_RE.test(text)) {
    logAndPrint('no_slots_text_detected_by_regex');
    return 'NO_SLOTS';
  }
  const css = await queryVisible(page, ['.no-slots', '#noSlotsMsg', '[class*="no-slot"]', '[class*="empty-state"]']);
  if (css) {
    logAndPrint('no_slots_css_detected', { selector: css.sel });
    return 'NO_SLOTS';
  }
  return 'CONTINUE';
}

// FIX v2.2: NEXT_MONTH_SELS now target real TLS month tabs (not phantom nav arrows).
// After clicking a tab, wait for the URL to change (?month=MM-YYYY) before polling DOM.
// This eliminates the SPA transition race condition entirely.
async function stepMonthTab(page) {
  dlog('Step: MONTH_TAB');
  if (await pageHasText(page, NO_SLOTS_RE)) return 'NO_SLOTS';

  for (let attempt = 0; attempt < 4; attempt++) {
    if (await pageHasText(page, NO_SLOTS_RE)) return 'NO_SLOTS';

    const day = await queryVisible(page, AVAIL_DAY_SELS);
    if (day) {
      const isPast = await day.loc.evaluate(
        el => el.classList.contains('past') || el.classList.contains('disabled')
      ).catch(() => true);
      if (!isPast) {
        logAndPrint('month_has_available_days', { attempt, selector: day.sel });
        return 'CONTINUE';
      }
    }

    if (attempt >= 3) break;

    const next = await queryVisible(page, NEXT_MONTH_SELS);
    if (!next) { logAndPrint('next_month_button_not_found', { attempt }); break; }

    const prevUrl = page.url();
    await sleep(rand(400, 900));
    await next.loc.click();
    logAndPrint('next_month_clicked', { attempt, selector: next.sel });

    // FIX v2.2: Real TLS month navigation = URL change. Wait for it before polling DOM.
    // This completely sidesteps the race condition where old DOM is still visible.
    await page.waitForURL(u => u.toString() !== prevUrl, { timeout: 8000 }).catch(() => {
      dlog('waitForURL timeout after month click — proceeding anyway');
    });
    await sleep(300); // brief React hydration settle

    const ready = await waitForCalendarReady(page, 10000);
    if (ready === 'NO_SLOTS') {
      logAndPrint('month_no_available_days', { attempt });
      return 'NO_SLOTS';
    }
    if (ready === 'TIMEOUT') {
      logAndPrint('next_month_button_not_found', { attempt, reason: 'calendar_timeout' });
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
    if (ERROR_RE.test(text)) {
      logAndPrint('booking_error_text', { text: text.slice(0, 200) });
      return 'NO_SLOTS';
    }

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
      if (result === 'NO_SLOTS')      { dlog(`-> NO_SLOTS at ${step.name}`); return false; }
      if (result === 'BOOKED')        { dlog(`-> BOOKED at ${step.name}`); return true; }
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
// SAFE RELOAD
// FIX v2.2: networkidle hangs forever on Cloudflare challenge pages.
// domcontentloaded fires immediately; we already actively poll for calendar content.
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
  // FIX v2.2: was 'networkidle' — hangs 30s on Cloudflare. domcontentloaded is enough.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  const ready = await waitForCalendarReady(page, 15000);
  if (ready === 'NO_SLOTS') dlog('Reload detected no slots immediately');
  else if (ready === 'TIMEOUT') dlog('Reload calendar ready timeout — proceeding cautiously');
  else dlog('Calendar DOM ready after reload');

  await sleep(rand(1500, 2500));
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOUDFLARE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
async function handleCloudflare(page) {
  let backoff = 60000;
  while (true) {
    const bodyText  = await pageInnerText(page);
    const titleText = await page.title().catch(() => '');
    const combined  = (bodyText + ' ' + titleText).toLowerCase();
    if (!CF_RE.test(combined)) break;

    const hot  = isHotWindow();
    const wait = Math.min(backoff, hot ? 300000 : 3600000);
    logAndPrint('cloudflare_block', { waitMs: wait });
    tg.push(`⚠️ Cloudflare block — backing off ${wait / 1000}s`);
    await sleep(wait);
    await safeReload(page);
    backoff = Math.min(backoff * 2, 3600000);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION RECOVERY
// FIX v2.2: These were defined INSIDE the while(true) loop and never called.
// Moved to module scope; handleSessionRecovery is now actually called in the loop.
// ═══════════════════════════════════════════════════════════════════════════════
const SESSION_STATES = {
  HEALTHY:        'HEALTHY',
  NEEDS_RELOGIN:  'NEEDS_RELOGIN',
  NEEDS_CAPTCHA:  'NEEDS_CAPTCHA',
  FULL_EXPIRED:   'FULL_EXPIRED',
};

async function detectSessionState(page) {
  const url   = page.url();
  const text  = await pageInnerText(page);
  const title = await page.title().catch(() => '');

  if (url.includes('/login') || url.includes('/signin')) {
    const hasSavedCreds = await page.locator(
      'input[type="email"][value]:not([value=""]), input[autocomplete="email"]'
    ).count() > 0;
    if (hasSavedCreds) return { state: SESSION_STATES.NEEDS_RELOGIN, reason: 'saved_credentials_detected' };
    return { state: SESSION_STATES.FULL_EXPIRED, reason: 'cold_login_page' };
  }

  // FIX v2.2: pageHasCaptcha now exists — this no longer crashes
  if (await pageHasCaptcha(page)) {
    return { state: SESSION_STATES.NEEDS_CAPTCHA, reason: 'captcha_detected' };
  }
  if (CF_RE.test(text + ' ' + title)) {
    return { state: SESSION_STATES.NEEDS_CAPTCHA, reason: 'cloudflare_challenge' };
  }

  if (url.includes('/appointment-booking')) {
    // Session cookie check: tls_auth JWT presence (confirmed from session log)
    const hasTlsAuth = await page.context().cookies()
      .then(cookies => cookies.some(c => c.name === 'tls_auth' && c.value.length > 20))
      .catch(() => true); // if cookie check fails, assume healthy
    if (!hasTlsAuth) return { state: SESSION_STATES.NEEDS_RELOGIN, reason: 'tls_auth_cookie_missing' };

    const hasCalendar = await page.locator(
      '[class*="MonthSelector_"], [class*="DayCell_"], [class*="CalendarGrid_"], .calendar-grid'
    ).first().count() > 0;
    if (!hasCalendar) return { state: SESSION_STATES.NEEDS_RELOGIN, reason: 'appointment_page_no_calendar' };
  }

  return { state: SESSION_STATES.HEALTHY };
}

async function handleSessionRecovery(page) {
  const { state, reason } = await detectSessionState(page);

  switch (state) {
    case SESSION_STATES.HEALTHY:
      return true;

    case SESSION_STATES.NEEDS_RELOGIN: {
      logAndPrint('session_expired', { reason });
      tg.push(`🔑 Session warm — please re-login. Reason: ${reason}`);
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        await sleep(5000);
        if (page.url().includes('/appointment-booking')) {
          logAndPrint('session_recovered');
          tg.push('✅ Session recovered — bot resuming');
          return true;
        }
        if (Date.now() - deadline > -180000 && page.url().includes('/login')) {
          tg.push('⏳ Still waiting for re-login... 3 minutes remaining');
        }
      }
      logAndPrint('session_relogin_timeout');
      tg.push('❌ Re-login timeout — bot pausing for 10 minutes');
      await sleep(600000);
      return false;
    }

    case SESSION_STATES.NEEDS_CAPTCHA: {
      logAndPrint('session_captcha', { reason });
      tg.push(`🛡️ CAPTCHA/Challenge detected — please solve manually. Reason: ${reason}`);
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
      logAndPrint('session_captcha_timeout');
      tg.push('❌ Challenge timeout — bot backing off 30 minutes');
      await sleep(1800000);
      return false;
    }

    case SESSION_STATES.FULL_EXPIRED: {
      logAndPrint('session_expired', { reason });
      tg.push('🔴 Session fully expired — full re-login required. Bot pausing 1 hour.');
      await sleep(3600000);
      return false;
    }

    default:
      return true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════════════
(async () => {
  if (!TG_TOKEN || !TG_CHAT) console.warn('WARNING: Telegram not configured');
  logAndPrint('soldier_start', { country: COUNTRY, cdpPort: CDP_PORT, dryRun: DRY_RUN });
  tg.push('🚀 Soldier started. Navigate to appointment page when ready.');
  await connectCDP(10);
  let page = await getPage();

  let lastCycleEnd = 0;
  // FIX v2.2: hot window was 8s minimum — too slow, slots gone in ~10s.
  // Tightened to 5s. Cold window unchanged at 60s (slots appear rarely).
  const MIN_CYCLE_GAP = { hot: 5000, cold: 60000 };

  while (true) {
    try {
      page = await getPage();
      const label = nextCycle();
      logAndPrint('tick', { url: page.url() });
      dlog(`=== ${label} ===`);

      await handleCloudflare(page);

      // FIX v2.2: handleSessionRecovery was never called (was dead code inside loop).
      // Now properly called at module scope, returns false on unrecoverable state.
      const sessionOk = await handleSessionRecovery(page);
      if (!sessionOk) {
        lastCycleEnd = Date.now();
        continue; // skip reload + machine, wait for next cycle
      }

      // If not on appointment page after session recovery, try to navigate there
      if (!page.url().includes('/appointment-booking')) {
        logAndPrint('navigating_to_appointment');
        const bookLink = await queryVisible(page, [
          '[href*="appointment-booking"]',
          'a:has-text("Book")',
          'a:has-text("Appointment")',
        ]);
        if (bookLink) {
          await stableClick(page, [bookLink.sel], 'navigate_to_appointment');
          await sleep(3000);
        }
      }

      const hot     = isHotWindow();
      const gap     = hot
        ? rand(MIN_CYCLE_GAP.hot, MIN_CYCLE_GAP.hot + 2000)
        : rand(MIN_CYCLE_GAP.cold, MIN_CYCLE_GAP.cold + 30000);
      const sinceLast = Date.now() - lastCycleEnd;
      if (sinceLast < gap) {
        const wait = gap - sinceLast;
        dlog(`Rate limit: sleeping ${wait}ms`);
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

      logAndPrint('booking_cycle_no_slots');

      // Strip month param so next reload starts fresh on the default month
      if (page.url().includes('month=')) {
        try {
          await page.evaluate(() => {
            const u = new URL(window.location.href);
            u.searchParams.delete('month');
            history.replaceState(null, '', u.toString());
          });
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