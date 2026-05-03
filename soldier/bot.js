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
`);

// Atlantis-Visa – Live-only, ultra-stable soldier
// CDP-attached to real Chrome (--remote-debugging-port=9222)
// NEVER navigates away – only page.reload().

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const os   = require('os');

// ── Config ────────────────────────────────────────────────────────────────────
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const BASE_DIR = process.env.ATLANTIS_HOME || path.join(os.homedir(), 'atlantis-visa');
const COUNTRY  = process.env.ATLANTIS_COUNTRY || 'PT';

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

// ── Lock file (dashboard heartbeat) ──────────────────────────────────────────
const LOCK_FILE = path.join(os.tmpdir(), `atlantis-soldier-${process.pid}`);
fs.writeFileSync(LOCK_FILE, String(process.pid));
const cleanupLock = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} };
process.on('exit',   cleanupLock);
process.on('SIGINT',  () => { cleanupLock(); process.exit(0); });
process.on('SIGTERM', () => { cleanupLock(); process.exit(0); });

// ── Constants ─────────────────────────────────────────────────────────────────
const NO_SLOTS_RE = /We currently don't have any appointment slots available|no appointments available|Unfortunately.*no appointments/i;

const SPINNER_SELS = [
  '.loading-spinner', '.spinner', '[class*="spinner"]',
  '[class*="loading"]', '.ajax-loader', '[class*="loader"]', '.tls-loader',
];

const BOOK_TEXTS = [
  'Book your appointment', 'Confirm', 'Submit', 'Book',
  'Réserver', 'Confirmer', 'Valider',
];

const CF_TERMS = [
  'checking your browser', 'you have been blocked', 'ray id',
  'cloudflare', 'please wait', 'ddos protection', 'attention required',
];

const NEXT_MONTH_SELS = [
  '.tls-calendar .next',
  '.calendar-nav-next',
  '[class*="calendar"] [class*="next"]',
  '[class*="month-nav"] [class*="next"]',
  'button[aria-label*="next" i]',
  'button[aria-label*="suivant" i]',
  'button[aria-label*="próximo" i]',
  'button[aria-label*="siguiente" i]',
  '.fc-next-button',
  '.btn-next-month',
  '.tls-next-month',
  '[data-direction="next"]',
  'button:has-text("›")',
  'button:has-text(">")',
  'button:has-text("»")',
  'a[href*="month="]',
];

const AVAIL_DAY_SELS = [
  '.day-cell.available',
  '.day-cell.day--available',
  '[class*="day-cell"][class*="available"]',
  '.day-cell:not(.disabled):not(.past):not(.other-month)',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;

// ── Logger ────────────────────────────────────────────────────────────────────
fs.mkdirSync(LOG_DIR,        { recursive: true });
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
const logFile       = path.join(LOG_DIR, `bot_${Date.now()}.log`);
const detailedFile  = path.join(LOG_DIR, `detailed_${Date.now()}.log`);
const logStream     = fs.createWriteStream(logFile, { flags: 'a' });
const detailedStream= fs.createWriteStream(detailedFile, { flags: 'a' });

function log(msg, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), msg, ...data }) + '\n';
  logStream.write(line);
  console.log(`[BOT] ${msg}`, Object.keys(data).length ? data : '');
}

function detailed(msg) {
  const ts = new Date().toISOString().replace('T',' ').substring(0,23);
  const line = `[${ts}] ${msg}\n`;
  detailedStream.write(line);
}

// ── Telegram ──────────────────────────────────────────────────────────────────
const TG_TOKEN = process.env.TELEGRAM_TOKEN || 'AAFWYAozBBlsZM2aNvPTy10KLdjo5G-qDWE';
const TG_CHAT  = process.env.CHAT_ID        || '8362293388';

function sendTelegram(text, shot) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    if (shot && fs.existsSync(shot)) {
      const photoData = fs.readFileSync(shot);
      const boundary  = '----AtlantisBoundary' + Date.now();
      const header = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="chat_id"\r\n\r\n${TG_CHAT}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="caption"\r\n\r\n${text}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="photo"; filename="shot.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`
      );
      const footer  = Buffer.from(`\r\n--${boundary}--\r\n`);
      const payload = Buffer.concat([header, photoData, footer]);
      const req = https.request({
        hostname: 'api.telegram.org',
        path:     `/bot${TG_TOKEN}/sendPhoto`,
        method:   'POST',
        headers: {
          'Content-Type':   `multipart/form-data; boundary=${boundary}`,
          'Content-Length': payload.length,
        },
      });
      req.on('error', (e) => log('telegram_error', { error: e.message }));
      req.write(payload);
      req.end();
    } else {
      const payload = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' });
      const req = https.request({
        hostname: 'api.telegram.org',
        path:     `/bot${TG_TOKEN}/sendMessage`,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      });
      req.on('error', (e) => log('telegram_error', { error: e.message }));
      req.write(payload);
      req.end();
    }
  } catch (e) {
    log('telegram_unexpected_error', { error: e.message });
  }
}

// ── CDP manager ───────────────────────────────────────────────────────────────
let browser;

async function connectCDP(retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      log('cdp_connected');
      detailed('CDP connected');
      return;
    } catch (e) {
      if (i === retries - 1) {
        console.error('Cannot connect to Chrome after retries. Exiting.');
        process.exit(1);
      }
      log('cdp_retrying', { attempt: i + 1, error: e.message });
      detailed(`CDP retry ${i+1}: ${e.message}`);
      await sleep(5_000);
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

// ── DOM helpers ───────────────────────────────────────────────────────────────
async function pageInnerText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function pageHasNoSlots(page) {
  const text = await pageInnerText(page);
  if (!text || text.length < 20) return false;
  return NO_SLOTS_RE.test(text);
}

async function pageHasCaptcha(page) {
  const url = page.url();
  if (url.includes('cloudflare') || url.includes('captcha') || url.includes('recaptcha')) return true;
  const body = await pageInnerText(page);
  return /not a robot|verify you are human/i.test(body);
}

async function queryVisible(page, selectors, ctx = '') {
  if (typeof selectors === 'string') selectors = [selectors];
  for (const sel of selectors) {
    try {
      const loc   = page.locator(sel).first();
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
  await sleep(rand(200, 600));
  await el.loc.click({ force: false });
  const txt = await el.loc.textContent().catch(() => '');
  log('click', { context: ctx, selector: el.sel, text: txt?.trim()?.slice(0, 50) });
  detailed(`Click [${ctx}] -> ${el.sel} (text: ${txt?.trim()?.slice(0,50)})`);
  return true;
}

async function shoot(page, label) {
  const file = path.join(SCREENSHOT_DIR, `${label}_${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  detailed(`Screenshot: ${file}`);
  return file;
}

// ── Selectors ─────────────────────────────────────────────────────────────────
let SELECTORS;
try {
  SELECTORS = JSON.parse(fs.readFileSync(SELECTORS_PATH, 'utf8'))[COUNTRY];
} catch {
  SELECTORS = {
    month_tab:      'a[href*="month="]',
    day_cell:       '.day-cell',
    slot_button:    '.tls-time-unit',
    slot_available: '.tls-time-unit.available',
    no_slots_text:  "We currently don't have any appointment slots available.",
  };
}

// ── Hot window ────────────────────────────────────────────────────────────────
function isHotWindow() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Algiers' }));
  const m = d.getHours() * 60 + d.getMinutes();
  return (m >= 535 && m <= 555) || (m >= 835 && m <= 855);
}

// ── Cycle counter ─────────────────────────────────────────────────────────────
let cycleNumber = 0;
function nextCycleLabel() {
  cycleNumber++;
  return `CYCLE #${cycleNumber}`;
}

// ── State machine steps ───────────────────────────────────────────────────────

async function stepWaitForAppointmentPage(page) {
  detailed(`Step WAIT_APPOINTMENT start`);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes('/appointment-booking')) {
      log('appointment_reached', { url });
      detailed(`  -> Appointment page reached: ${url}`);
      return 'CONTINUE';
    }
    if (url.includes('/service-level')) {
      log('service_level_detected');
      detailed(`  -> Service level page detected, clicking Standard`);
      await clickVisible(page,
        ['button:has-text("Standard")', 'a:has-text("Standard")', '[data-type="standard"]'],
        'service_standard'
      );
      await sleep(800);
      await clickVisible(page,
        ['button:has-text("Continue")', 'a:has-text("Continue")', 'button[type="submit"]'],
        'service_continue'
      );
      await sleep(2_000);
      continue;
    }
    await sleep(500);
  }
  log('appointment_page_timeout');
  detailed(`  -> Timeout waiting for appointment page`);
  return 'NO_SLOTS';
}

async function stepCourierModal(page) {
  detailed(`Step COURIER_MODAL start`);
  const modal = await queryVisible(page,
    ['#courier-step', '[id*="courier"]', '.modal:has-text("Courier")', '.modal:has-text("courier")'],
    'courier_modal'
  );
  if (modal) {
    await clickVisible(page,
      ['button:has-text("Continue")', 'a:has-text("Continue")', 'button:has-text("Next")'],
      'courier_dismiss'
    );
  } else {
    detailed(`  -> No courier modal`);
  }
  return 'CONTINUE';
}

async function stepCheckNoSlots(page) {
  detailed(`Step CHECK_NO_SLOTS start`);
  if (await pageHasNoSlots(page)) {
    log('no_slots_text_detected_by_regex');
    detailed(`  -> NO_SLOTS text detected (regex)`);
    return 'NO_SLOTS';
  }

  const cssPats = [
    '.no-slots', '#noSlotsMsg',
    '[class*="no-slot"]', '[class*="empty-state"]',
    SELECTORS.no_slots_text ? `text="${SELECTORS.no_slots_text}"` : null,
  ].filter(Boolean);

  const cssHit = await queryVisible(page, cssPats, 'no_slots_css');
  if (cssHit) {
    log('no_slots_css_detected', { selector: cssHit.sel });
    detailed(`  -> NO_SLOTS CSS element found: ${cssHit.sel}`);
    return 'NO_SLOTS';
  }

  detailed(`  -> Slots may be available`);
  return 'CONTINUE';
}

async function stepMonthTab(page) {
  detailed(`Step MONTH_TAB start`);
  if (await pageHasNoSlots(page)) {
    log('stepMonthTab_guard_no_slots_text');
    detailed(`  -> GUARD: no slots text, aborting`);
    return 'NO_SLOTS';
  }

  await sleep(rand(600, 1_200));

  for (let attempt = 0; attempt < 4; attempt++) {
    if (await pageHasNoSlots(page)) {
      log('stepMonthTab_mid_loop_no_slots_text', { attempt });
      detailed(`  -> Mid-loop no slots at attempt ${attempt}, aborting`);
      return 'NO_SLOTS';
    }

    const availDay = await queryVisible(page, AVAIL_DAY_SELS, 'avail_day_check');
    if (availDay) {
      log('month_has_available_days', { attempt, selector: availDay.sel });
      detailed(`  -> Month has available days (attempt ${attempt}), selector: ${availDay.sel}`);
      return 'CONTINUE';
    }

    log('month_no_available_days', { attempt });
    detailed(`  -> Month has NO available days, attempt ${attempt}`);

    if (attempt >= 3) break;

    const nextBtn = await queryVisible(page, NEXT_MONTH_SELS, 'next_month_btn');
    if (!nextBtn) {
      log('next_month_button_not_found', { attempt });
      detailed(`  -> Next month button not found (attempt ${attempt}), stopping month advance`);
      break;
    }

    await sleep(rand(300, 700));
    try {
      await nextBtn.loc.click();
      log('next_month_clicked', { attempt, selector: nextBtn.sel });
      detailed(`  -> Clicked next month (${nextBtn.sel})`);
    } catch (e) {
      log('next_month_click_error', { attempt, error: e.message });
      detailed(`  -> Error clicking next month: ${e.message}`);
      break;
    }

    // INCREASED: give AJAX more time to settle
    await sleep(rand(2_500, 4_000));
  }

  detailed(`  -> Month tab finished, handing off to stepDay`);
  return 'CONTINUE';
}

async function stepDay(page) {
  detailed(`Step SELECT_DAY start`);
  const pats = [
    ...AVAIL_DAY_SELS,
    `${SELECTORS.day_cell}:not(.disabled)`,
    SELECTORS.day_cell,
  ];

  // RETRY LOOP: calendar might still be rendering after month nav
  for (let retry = 0; retry < 3; retry++) {
    const res = await queryVisible(page, pats, 'day_cell');
    if (res) {
      await sleep(rand(200, 700));
      await res.loc.click();
      log('day_clicked', { selector: res.sel });
      detailed(`  -> Clicked day cell: ${res.sel}`);
      await sleep(500);
      return 'CONTINUE';
    }
    detailed(`  -> No day cell found, retry ${retry + 1}/3`);
    await sleep(1_000);
  }

  log('step_day_no_cell_found');
  detailed(`  -> No clickable day cell found after retries`);
  return 'NO_SLOTS';
}

async function stepSpinnerAndTime(page) {
  detailed(`Step WAIT_SPINNER_TIME start`);
  for (const sel of SPINNER_SELS) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      log('spinner_detected', { selector: sel });
      detailed(`  -> Spinner detected: ${sel}, waiting for hidden`);
      await loc.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
      break;
    }
  }

  const slotSel    = SELECTORS.slot_button || '.tls-time-unit';
  const firstSlot  = page.locator(slotSel).first();
  const appeared   = await firstSlot
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true).catch(() => false);

  if (!appeared) {
    log('no_time_slots_rendered');
    detailed(`  -> No time slots rendered`);
    return 'NO_SLOTS';
  }

  const pats = [
    SELECTORS.slot_available,
    slotSel,
    '.tls-time-unit.available',
    'button[data-time]',
    'a[data-time]',
    '[class*="time-slot"]',
    '[class*="slot"]:not([disabled])',
  ].filter(Boolean);

  const res = await queryVisible(page, pats, 'time_slot');
  if (!res) {
    log('no_available_time_slot');
    detailed(`  -> No available time slot`);
    return 'NO_SLOTS';
  }
  await sleep(rand(200, 700));
  await res.loc.click();
  log('time_clicked', { selector: res.sel });
  detailed(`  -> Clicked time slot: ${res.sel}`);
  return 'CONTINUE';
}

async function stepBook(page) {
  detailed(`Step CLICK_BOOK start`);
  const textPats = BOOK_TEXTS.map(t => `button:has-text("${t}")`);
  const pats = [
    ...textPats,
    '#bookBtn',
    '[data-testid="book-button"]',
    'button[type="submit"]',
    'input[type="submit"]',
  ];
  const res = await queryVisible(page, pats, 'book_button');
  if (!res) {
    log('book_button_not_found');
    detailed(`  -> Book button not found`);
    return 'NO_SLOTS';
  }
  await sleep(rand(200, 700));
  await res.loc.click();
  log('book_clicked', { selector: res.sel });
  detailed(`  -> Clicked book button: ${res.sel}`);
  await sleep(1_000);
  return 'CONTINUE';
}

async function stepConfirmation(page) {
  detailed(`Step DETECT_CONFIRMATION start`);
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const url = page.url();
    if (
      url.includes('/order-summary')  ||
      url.includes('/confirmation')   ||
      url.includes('/success')        ||
      url.includes('/booking-summary')
    ) {
      const shot = await shoot(page, 'confirmation');
      log('booking_success_url', { url, screenshot: shot });
      detailed(`  -> BOOKED! Confirmation URL: ${url}`);
      sendTelegram('<b>✅ BOOKING SUCCESS</b>\nAppointment booked! Check the screenshot.', shot);
      return 'BOOKED';
    }

    const modal = await queryVisible(page, [
      '.modal-overlay.active', '.modal.active',
      '[class*="confirmation"]', '[class*="success-modal"]',
      'text="Appointment confirmed"', 'text="Booking confirmed"',
    ], 'confirmation_modal');

    if (modal) {
      detailed(`  -> Confirmation modal detected`);
      const confirmBtn = page
        .locator('button:has-text("Confirm"), button:has-text("OK"), button:has-text("Submit"), .modal-confirm')
        .first();
      if (await confirmBtn.count() > 0 && await confirmBtn.isVisible()) {
        await sleep(rand(200, 600));
        await confirmBtn.click();
        log('confirm_button_clicked');
        detailed(`  -> Clicked confirm button`);
        await sleep(1_000);
      }
      const shot = await shoot(page, 'confirmation');
      log('booking_success_modal', { screenshot: shot });
      sendTelegram('<b>✅ BOOKING SUCCESS</b>\nAppointment booked! Check the screenshot.', shot);
      return 'BOOKED';
    }

    await sleep(500);
  }
  log('confirmation_timeout');
  detailed(`  -> Confirmation timeout`);
  return 'NO_SLOTS';
}

// ── State machine ─────────────────────────────────────────────────────────────
const STEPS = [
  { name: 'WAIT_APPOINTMENT',    fn: stepWaitForAppointmentPage },
  { name: 'COURIER_MODAL',       fn: stepCourierModal           },
  { name: 'CHECK_NO_SLOTS',      fn: stepCheckNoSlots           },
  { name: 'MONTH_TAB',           fn: stepMonthTab               },
  { name: 'SELECT_DAY',          fn: stepDay                    },
  { name: 'WAIT_SPINNER_TIME',   fn: stepSpinnerAndTime         },
  { name: 'CLICK_BOOK',          fn: stepBook                   },
  { name: 'DETECT_CONFIRMATION', fn: stepConfirmation           },
];

async function runStateMachine(page) {
  for (const step of STEPS) {
    try {
      const result = await Promise.race([
        step.fn(page),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('STEP_TIMEOUT')), 30_000)
        ),
      ]);
      if (result === 'NO_SLOTS') {
        detailed(`  -> State machine result: NO_SLOTS at step ${step.name}`);
        return false;
      }
      if (result === 'BOOKED') {
        detailed(`  -> State machine result: BOOKED at step ${step.name}`);
        return true;
      }
    } catch (e) {
      log(`step_${step.name}_error`, { error: e.message });
      detailed(`  -> Step ${step.name} ERROR: ${e.message}`);
      return false;
    }
  }
  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function safeReload(page) {
  const currentUrl = page.url();

  if (currentUrl.includes('month=')) {
    try {
      await page.evaluate(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete('month');
        history.replaceState(null, '', url.toString());
      });
      log('safeReload_resetting_month', { from: currentUrl });
      detailed(`Reload: stripped month param via history.replaceState`);
    } catch (e) {
      log('safeReload_month_reset_failed', { error: e.message });
      detailed(`Reload: month reset failed (${e.message})`);
    }
  }

  log('page_reload');
  detailed(`Reload: page.reload() on ${page.url()}`);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
  try {
    await page.waitForSelector(
      '.no-slots, #noSlotsMsg, .day-cell, .month-tab, .calendar-grid, [class*="calendar"]',
      { timeout: 10_000 }
    );
    await sleep(1_500);
    detailed(`Reload: calendar DOM ready`);
  } catch {
    detailed(`Reload: calendar selector did not appear within timeout`);
  }
  await sleep(rand(2_000, 4_000));
}

async function handleCloudflare(page) {
  let backoff = 60_000;
  const hot = isHotWindow();
  while (true) {
    const body    = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const title   = await page.title().catch(() => '');
    const combined = (body + ' ' + title).toLowerCase();
    if (!CF_TERMS.some(t => combined.includes(t))) break;

    const maxBackoff = hot ? 300_000 : 3_600_000;
    const effective = Math.min(backoff, maxBackoff);
    log('cloudflare_block', { backoffMs: effective, hot });
    detailed(`Cloudflare block detected, waiting ${effective/1000}s (hot=${hot})`);
    sendTelegram(`⚠️ Cloudflare block – waiting ${effective / 1000}s before retry`);
    await sleep(effective);
    await safeReload(page);
    backoff = Math.min(backoff * 2, 3_600_000);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
(async () => {
  await connectCDP(10);
  let page = await getPage();

  if (!TG_TOKEN || !TG_CHAT) {
    console.warn('Telegram not configured – alerts disabled');
    log('telegram_not_configured');
    detailed('Telegram not configured – alerts disabled');
  }
  log('config', { country: COUNTRY, cdpPort: CDP_PORT, baseDir: BASE_DIR });
  detailed(`Config: country=${COUNTRY}, cdpPort=${CDP_PORT}, baseDir=${BASE_DIR}`);

  log('soldier_start');
  detailed('Soldier started');
  sendTelegram('🚀 Soldier started – navigate to the appointment page when ready');

  // FIX: Start at 0 so first tick always reloads
  let lastRefresh = 0;

  while (true) {
    try {
      page = await getPage();
      const url = page.url();
      const cycleLabel = nextCycleLabel();
      log('tick', { url });
      detailed(`=== ${cycleLabel} ===`);
      detailed(`Page URL: ${url}`);

      await handleCloudflare(page);

      if (url.includes('/login')) {
        log('session_expired');
        detailed('Session expired');
        sendTelegram('🔑 Session expired – please log in again');
        await sleep(30_000);
        continue;
      }

      if (await pageHasCaptcha(page)) {
        log('captcha_detected');
        detailed('CAPTCHA detected, waiting for manual solve...');
        sendTelegram('🛡️ CAPTCHA detected – please solve it in the browser.');
        while (await pageHasCaptcha(page)) {
          await sleep(5_000);
        }
        log('captcha_resolved');
        detailed('CAPTCHA resolved');
        lastRefresh = 0;
        continue;
      }

      // ── Refresh timing: THE FIX ──────────────────────────────────────
      const isHot = isHotWindow();
      const refreshInterval = isHot
        ? rand(5_000,   8_000)    // hot: 5–8 s
        : rand(300_000, 600_000); // cold: 5–10 min

      const needsRefresh = (Date.now() - lastRefresh) > refreshInterval;

      if (needsRefresh) {
        detailed(`Refresh needed (${Date.now() - lastRefresh}ms since last refresh)`);
        await safeReload(page);
        lastRefresh = Date.now();
      } else {
        // FIX: If page is stale, SLEEP until refresh is due, then continue to top
        const remaining = refreshInterval - (Date.now() - lastRefresh);
        detailed(`Page is fresh (${Date.now() - lastRefresh}ms old). Sleeping ${remaining}ms until next refresh.`);
        await sleep(remaining);
        continue;  // Go back to top of loop — will reload on next iteration
      }

      // ── Run booking state machine ONLY on freshly reloaded pages ─────
      detailed(`Starting state machine on fresh page`);
      const booked = await runStateMachine(page);

      if (booked) {
        log('booking_cycle_success');
        detailed(`>>> BOOKING SUCCESS! <<<`);
        sendTelegram('🎉 Appointment secured! Bot is stopping. Go complete payment NOW!');
        cleanupLock();
        process.exit(0);
      }

      log('booking_cycle_no_slots');
      detailed(`Cycle result: NO_SLOTS`);

      // Reset month silently
      const cycleEndUrl = page.url();
      if (cycleEndUrl.includes('month=')) {
        try {
          await page.evaluate(() => {
            const url = new URL(window.location.href);
            url.searchParams.delete('month');
            history.replaceState(null, '', url.toString());
          });
          log('month_reset_replaceState', { from: cycleEndUrl });
          detailed(`Month param stripped via replaceState`);
        } catch (e) {
          detailed(`Month reset (replaceState) failed: ${e.message}`);
        }
      }

      // FIX: Do NOT touch lastRefresh here. Let the loop decide when to reload.
      detailed(`State machine complete. Waiting for next refresh interval.`);

    } catch (e) {
      log('loop_error', { error: e.message });
      detailed(`!!! Loop error: ${e.message}`);
      lastRefresh = 0;
      await sleep(5_000);
    }
  }
})();