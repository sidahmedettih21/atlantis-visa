#!/usr/bin/env node
console.log(`
//      /$$$$$$  /$$$$$$$$ /$$        /$$$$$$  /$$   /$$ /$$$$$$$$ /$$$$$$  /$$$$$$ 
//     /$$__  $$|__  $$__/| $$       /$$__  $$| $$$ | $$|__  $$__/|_  $$_/ /$$__  $$
//    | $$  \\ $$   | $$   | $$      | $$  \\ $$| $$$$| $$   | $$     | $$  | $$  \\__/
//    | $$$$$$$$   | $$   | $$      | $$$$$$$$| $$ $$ $$   | $$     | $$  |  $$$$$$ 
//    | $$__  $$   | $$   | $$      | $$__  $$| $$  $$$$   | $$     | $$   \\____  $$
//    | $$  | $$   | $$   | $$      | $$  | $$| $$\\  $$$   | $$     | $$   /$$  \\ $$
//    | $$  | $$   | $$   | $$$$$$$$| $$  | $$| $$ \\  $$   | $$    /$$$$$$|  $$$$$$/
//    |__/  |__/   |__/   |________/|__/  |__/|__/  \\__/   |__/   |______/ \\______/ 
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

// THE critical regex – used in two places to halt all clicks when TLS says no slots.
// Covers: current EN text, possible variations, and "Unfortunately…" pattern.
const NO_SLOTS_RE = /We currently don.t have any appointment slots available|no appointments available|Unfortunately.*no appointments/i;

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

// Next-month navigation – broad net across all known TLScontact markup variants
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

// Available day selectors – progressively less strict, first match wins
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
const logFile   = path.join(LOG_DIR, `bot_${Date.now()}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(msg, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), msg, ...data }) + '\n';
  logStream.write(line);
  console.log(`[BOT] ${msg}`, Object.keys(data).length ? data : '');
}

// ── Telegram ──────────────────────────────────────────────────────────────────
const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT  = process.env.CHAT_ID        || '';

// Binary-safe multipart photo send – header and footer as Buffers,
// raw image bytes untouched between them.
function sendTelegram(text, shot) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    if (shot && fs.existsSync(shot)) {
      const photoData = fs.readFileSync(shot);  // raw PNG – never re-encode
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
      req.on('error', () => {});
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
      req.on('error', () => {});
      req.write(payload);
      req.end();
    }
  } catch {}
}

// ── CDP manager ───────────────────────────────────────────────────────────────
let browser;

async function connectCDP(retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      log('cdp_connected');
      return;
    } catch (e) {
      if (i === retries - 1) {
        console.error('❌ Cannot connect to Chrome after retries. Exiting.');
        process.exit(1);
      }
      log('cdp_retrying', { attempt: i + 1, error: e.message });
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
  // Prefer the TLScontact tab; fall back to first tab
  return pages.find(p => p.url().includes('tlscontact')) || pages[0];
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

// Returns the full visible text of the page body (no timeout risk).
async function pageInnerText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

// Returns true if the page is currently showing a "no slots available" message.
async function pageHasNoSlots(page) {
  const text = await pageInnerText(page);
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
  return true;
}

async function shoot(page, label) {
  const file = path.join(SCREENSHOT_DIR, `${label}_${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

// ── Selectors (loaded from shared/selectors.json or inline fallback) ──────────
let SELECTORS;
try { SELECTORS = JSON.parse(fs.readFileSync(SELECTORS_PATH, 'utf8')).PT; }
catch {
  SELECTORS = {
    month_tab:      'a[href*="month="]',
    day_cell:       '.day-cell',
    slot_button:    '.tls-time-unit',
    slot_available: '.tls-time-unit.available',
    no_slots_text:  "We currently don't have any appointment slots available.",
  };
}

// ── State machine steps ───────────────────────────────────────────────────────

// STEP 1 – Wait until the browser is on the appointment-booking page.
// Hard 25 s wall-clock deadline; the outer 30 s race is the final safety net.
async function stepWaitForAppointmentPage(page) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes('/appointment-booking')) {
      log('appointment_reached', { url });
      return 'CONTINUE';
    }
    // Handle the intermediate service-level page without leaving
    if (url.includes('/service-level')) {
      log('service_level_detected');
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
  return 'NO_SLOTS';  // triggers a reload and retry, not a real "no slots"
}

// STEP 2 – Dismiss the courier upsell modal if present, otherwise no-op.
async function stepCourierModal(page) {
  const modal = await queryVisible(page,
    ['#courier-step', '[id*="courier"]', '.modal:has-text("Courier")', '.modal:has-text("courier")'],
    'courier_modal'
  );
  if (modal) {
    await clickVisible(page,
      ['button:has-text("Continue")', 'a:has-text("Continue")', 'button:has-text("Next")'],
      'courier_dismiss'
    );
  }
  return 'CONTINUE';
}

// STEP 3 – Check full page text for "no slots" patterns via regex.
// If found: return NO_SLOTS immediately — no further steps, no clicks.
async function stepCheckNoSlots(page) {
  // Primary: regex over full page body text
  if (await pageHasNoSlots(page)) {
    log('no_slots_text_detected_by_regex');
    return 'NO_SLOTS';
  }

  // Secondary: look for CSS-based no-slot indicators
  const cssPats = [
    '.no-slots', '#noSlotsMsg',
    '[class*="no-slot"]', '[class*="empty-state"]',
    SELECTORS.no_slots_text ? `text="${SELECTORS.no_slots_text}"` : null,
  ].filter(Boolean);

  const cssHit = await queryVisible(page, cssPats, 'no_slots_css');
  if (cssHit) {
    log('no_slots_css_detected', { selector: cssHit.sel });
    return 'NO_SLOTS';
  }

  return 'CONTINUE';
}

// STEP 4 – Month navigation.
// ─────────────────────────────────────────────────────────────────────────────
// GUARD: If the page text matches NO_SLOTS_RE, return NO_SLOTS immediately –
//        zero clicks. This is the defence-in-depth check in case an AJAX load
//        updated the DOM between STEP 3 and now.
//
// Otherwise: check current month for available day cells.
//   • Found  → return CONTINUE (let stepDay click one)
//   • None   → try clicking the next-month button (up to 3 times, 1.5-2.5 s wait)
//              Re-check after each click.
//   After 3 failed month advances with no available days → return CONTINUE
//   (stepDay will confirm there's nothing and return NO_SLOTS cleanly).
// ─────────────────────────────────────────────────────────────────────────────
async function stepMonthTab(page) {
  // ── GUARD: never click anything when TLS is telling us there are no slots ──
  if (await pageHasNoSlots(page)) {
    log('stepMonthTab_guard_no_slots_text');
    return 'NO_SLOTS';
  }

  // Give the calendar a moment to finish its initial render
  await sleep(rand(600, 1_200));

  for (let attempt = 0; attempt < 4; attempt++) {
    // Re-check the no-slots text on every iteration —
    // it could appear after an AJAX month change.
    if (await pageHasNoSlots(page)) {
      log('stepMonthTab_mid_loop_no_slots_text', { attempt });
      return 'NO_SLOTS';
    }

    // Check if the current calendar view has any bookable day
    const availDay = await queryVisible(page, AVAIL_DAY_SELS, 'avail_day_check');
    if (availDay) {
      log('month_has_available_days', { attempt, selector: availDay.sel });
      return 'CONTINUE';
    }

    log('month_no_available_days', { attempt });

    // After 3 unsuccessful month advances, hand off to stepDay
    if (attempt >= 3) break;

    // Attempt to advance one month
    const nextBtn = await queryVisible(page, NEXT_MONTH_SELS, 'next_month_btn');
    if (!nextBtn) {
      // No navigation control found — calendar might use a different widget.
      // Proceed; stepDay will confirm whether anything is clickable.
      log('next_month_button_not_found', { attempt });
      break;
    }

    await sleep(rand(300, 700));
    try {
      await nextBtn.loc.click();
      log('next_month_clicked', { attempt, selector: nextBtn.sel });
    } catch (e) {
      log('next_month_click_error', { attempt, error: e.message });
      break;
    }

    // Wait for the AJAX calendar update to settle
    await sleep(rand(1_500, 2_500));
  }

  // Fell through – return CONTINUE so stepDay makes the final determination
  return 'CONTINUE';
}

// STEP 5 – Click the first available day cell.
async function stepDay(page) {
  const pats = [
    ...AVAIL_DAY_SELS,
    `${SELECTORS.day_cell}:not(.disabled)`,
    SELECTORS.day_cell,
  ];
  const res = await queryVisible(page, pats, 'day_cell');
  if (!res) { log('step_day_no_cell_found'); return 'NO_SLOTS'; }
  await sleep(rand(200, 700));
  await res.loc.click();
  log('day_clicked', { selector: res.sel });
  await sleep(500);
  return 'CONTINUE';
}

// STEP 6 – Wait for spinner to clear, then click an available time slot.
async function stepSpinnerAndTime(page) {
  // Clear any loading overlay first
  for (const sel of SPINNER_SELS) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      log('spinner_detected', { selector: sel });
      await loc.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
      break;
    }
  }

  // Wait for at least one slot element to appear
  const slotSel    = SELECTORS.slot_button || '.tls-time-unit';
  const firstSlot  = page.locator(slotSel).first();
  const appeared   = await firstSlot
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true).catch(() => false);

  if (!appeared) { log('no_time_slots_rendered'); return 'NO_SLOTS'; }

  // Pick the first available/enabled slot
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
  if (!res) { log('no_available_time_slot'); return 'NO_SLOTS'; }
  await sleep(rand(200, 700));
  await res.loc.click();
  log('time_clicked', { selector: res.sel });
  return 'CONTINUE';
}

// STEP 7 – Click the booking / confirmation button.
async function stepBook(page) {
  const textPats = BOOK_TEXTS.map(t => `button:has-text("${t}")`);
  const pats = [
    ...textPats,
    '#bookBtn',
    '[data-testid="book-button"]',
    'button[type="submit"]',
    'input[type="submit"]',
  ];
  const res = await queryVisible(page, pats, 'book_button');
  if (!res) { log('book_button_not_found'); return 'NO_SLOTS'; }
  await sleep(rand(200, 700));
  await res.loc.click();
  log('book_clicked', { selector: res.sel });
  await sleep(1_000);
  return 'CONTINUE';
}

// STEP 8 – Detect the confirmation screen or modal; return BOOKED on success.
async function stepConfirmation(page) {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const url = page.url();
    // All known TLScontact confirmation URL suffixes
    if (
      url.includes('/order-summary')  ||
      url.includes('/confirmation')   ||
      url.includes('/success')        ||
      url.includes('/booking-summary')
    ) {
      const shot = await shoot(page, 'confirmation');
      log('booking_success_url', { url, screenshot: shot });
      sendTelegram('<b>✅ BOOKING SUCCESS</b>\nAppointment booked! Check the screenshot.', shot);
      return 'BOOKED';
    }

    const modal = await queryVisible(page, [
      '.modal-overlay.active', '.modal.active',
      '[class*="confirmation"]', '[class*="success-modal"]',
      'text="Appointment confirmed"', 'text="Booking confirmed"',
    ], 'confirmation_modal');

    if (modal) {
      const confirmBtn = page
        .locator('button:has-text("Confirm"), button:has-text("OK"), button:has-text("Submit"), .modal-confirm')
        .first();
      if (await confirmBtn.count() > 0 && await confirmBtn.isVisible()) {
        await sleep(rand(200, 600));
        await confirmBtn.click();
        log('confirm_button_clicked');
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
      if (result === 'NO_SLOTS') return false;
      if (result === 'BOOKED')   return true;
      // 'CONTINUE' → next step
    } catch (e) {
      log(`step_${step.name}_error`, { error: e.message });
      return false;
    }
  }
  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function safeReload(page) {
  log('page_reload');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
  // Wait until we can see the "no slots" message OR the calendar has loaded
  try {
    await page.waitForSelector('.no-slots, #noSlotsMsg, .day-cell, .month-tab', { timeout: 10_000 });
    await sleep(1_000); // extra breathing room for text to populate
  } catch {
    // if neither appears, that's okay; we'll check again on the next cycle
  }
  await sleep(rand(2_000, 4_000));
}

// Detect Cloudflare challenge pages; back off exponentially, then reload.
async function handleCloudflare(page) {
  let backoff = 60_000;
  while (true) {
    const body    = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const title   = await page.title().catch(() => '');
    const combined = (body + ' ' + title).toLowerCase();
    if (!CF_TERMS.some(t => combined.includes(t))) break;
    log('cloudflare_block', { backoffMs: backoff });
    sendTelegram(`⚠️ Cloudflare block – waiting ${backoff / 1000}s before retry`);
    await sleep(backoff);
    await safeReload(page);
    backoff = Math.min(backoff * 2, 3_600_000);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
(async () => {
  await connectCDP(10);
  let page = await getPage();

  log('soldier_start');
  sendTelegram('🚀 Soldier started – navigate to the appointment page when ready');

  let lastRefresh = Date.now();

  while (true) {
    try {
      page = await getPage();
      const url = page.url();
      log('tick', { url });

      // Check for Cloudflare challenge before doing anything else
      await handleCloudflare(page);

      // Session expired
      if (url.includes('/login')) {
        log('session_expired');
        sendTelegram('🔑 Session expired – please log in again');
        await sleep(30_000);
        continue;
      }

      // ── Refresh timing ──────────────────────────────────────────────────────
      // Hot windows (slots most likely to appear):
      //   08:55–09:15 and 13:55–14:15 Algeria time  →  5–8 s interval
      // Cold (all other times):
      //   300–600 s (5–10 min) randomised             →  safe, quiet floor
      const isHot = (() => {
        const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Algiers' }));
        const m = d.getHours() * 60 + d.getMinutes();
        return (m >= 535 && m <= 555) || (m >= 835 && m <= 855);
      })();

      const refreshInterval = isHot
        ? rand(5_000,   8_000)    // hot: 5–8 s
        : rand(300_000, 600_000); // cold: 5–10 min

      if (Date.now() - lastRefresh > refreshInterval) {
        await safeReload(page);
        lastRefresh = Date.now();
      }

      // ── Run the booking state machine ───────────────────────────────────────
      const booked = await runStateMachine(page);

      if (booked) {
        log('booking_cycle_success');
        sendTelegram('🎉 Appointment secured! Bot is stopping. Go complete payment NOW!');
        // Exit immediately – do not reload or re-run the state machine.
        cleanupLock();
        process.exit(0);
      }

      log('booking_cycle_no_slots');
      // Small pause between state-machine runs (does not affect reload timer)
      await sleep(rand(3_000, 6_000));

    } catch (e) {
      log('loop_error', { error: e.message });
      await sleep(5_000);
    }
  }
})();