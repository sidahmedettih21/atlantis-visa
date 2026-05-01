#!/usr/bin/env node
// ── Atlantis‑Visa Banner ───────────────────────────────────────────────
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
// Atlantis-Visa Production CDP Bot – v3.0 (manual navigation gate)
// Attach to a running Chrome, navigate manually to the appointment page,
// and the bot will start booking automatically.
// Use --sim for automatic navigation to the simulation server.

const { chromium } = require('playwright');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Constants ──────────────────────────────────────────────────────────
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const DEFAULT_CONFIG = path.join(__dirname, 'config', 'default.json');
const SELECTORS_FILE = path.join(__dirname, '..', 'shared', 'selectors.json');
const PROFILES_DIR = path.join(__dirname, 'profiles');

// ── CLI Args ───────────────────────────────────────────────────────────
const args = (() => {
  const argv = process.argv.slice(2);
  const result = { config: DEFAULT_CONFIG, sim: false, debug: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sim') result.sim = true;
    else if (argv[i] === '--debug') result.debug = true;
    else if (argv[i] === '--config' && argv[i+1]) {
      result.config = argv[i+1];
      i++;
    }
  }
  return result;
})();

// ── Logging ────────────────────────────────────────────────────────────
const logDir = path.join(__dirname, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logStream = fs.createWriteStream(path.join(logDir, `soldier_${Date.now()}.log`), { flags: 'a' });

function log(msg, data = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), msg, ...data }) + '\n';
  logStream.write(entry);
  console.log(`[SOLDIER] ${msg}`, Object.keys(data).length ? JSON.stringify(data) : '');
}

const DEBUG = process.env.DEBUG === 'true' || args.debug;
function debug(msg, data = {}) {
  if (!DEBUG) return;
  const entry = JSON.stringify({ ts: new Date().toISOString(), level: 'debug', msg, ...data }) + '\n';
  logStream.write(entry);
  console.debug(`[DEBUG] ${msg}`, data);
}

// ── Lock file ──────────────────────────────────────────────────────────
const lockFile = path.join(os.tmpdir(), `atlantis-soldier-${process.env.CLIENT_ID || 'default'}.lock`);
function acquireLock() {
  if (fs.existsSync(lockFile)) {
    const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
    try { process.kill(pid, 0); return false; } catch { fs.unlinkSync(lockFile); }
  }
  fs.writeFileSync(lockFile, String(process.pid));
  return true;
}
function releaseLock() { try { fs.unlinkSync(lockFile); } catch {} }

// ── Configuration ──────────────────────────────────────────────────────
function loadConfig() {
  let config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  if (process.env.TLS_BASE_URL) config.baseUrl = process.env.TLS_BASE_URL;
  if (process.env.TELEGRAM_TOKEN) config.telegram = config.telegram || {};
  if (process.env.TELEGRAM_TOKEN) config.telegram.bot_token = process.env.TELEGRAM_TOKEN;
  if (process.env.CHAT_ID) config.telegram.chat_id = process.env.CHAT_ID;
  if (process.env.CLIENT_ID) config.client_id = process.env.CLIENT_ID;
  config.client_id = config.client_id || 'default';
  config.country = config.country || 'PT';
  config.appointment_type = config.appointment_type || 'standard';
  config.fallback_chain = config.fallback_chain || ['standard'];
  config.target_date_ranges = config.target_date_ranges || [];
  config.preferred_times = config.preferred_times || ['08:00','08:15'];
  config.behavior = config.behavior || {};
  config.behavior.refresh_interval_seconds = config.behavior.refresh_interval_seconds || 300;
  config.behavior.click_delay_ms = config.behavior.click_delay_ms || { min: 200, max: 800 };
  config.behavior.page_transition_delay_ms = config.behavior.page_transition_delay_ms || { min: 1000, max: 3000 };
  config.behavior.ajax_timeout_ms = config.behavior.ajax_timeout_ms || 5000;
  config.behavior.slot_reservation_buffer_seconds = config.behavior.slot_reservation_buffer_seconds || 30;
  config.behavior.auto_reselect_on_expiry = config.behavior.auto_reselect_on_expiry ?? true;
  config.captcha = config.captcha || { service: 'manual', timeout_seconds: 120 };
  config.swarm = config.swarm || { enabled: false };
  if (args.sim) {
    config.baseUrl = 'http://localhost:8080';
    config.simulation = true;
  }
  return config;
}

function loadSelectors(country) {
  const raw = JSON.parse(fs.readFileSync(SELECTORS_FILE, 'utf8'));
  return raw[country] || raw['PT'];
}

// ── Telegram ───────────────────────────────────────────────────────────
let tgToken = '', tgChat = '';
function initTelegram(config) {
  tgToken = config.telegram?.bot_token || '';
  tgChat = config.telegram?.chat_id || '';
}
function sendTelegram(text, shotPath) {
  if (!tgToken || !tgChat) return;
  if (shotPath && fs.existsSync(shotPath)) {
    const boundary = 'boundary' + Date.now();
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${tgChat}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${text}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="screenshot.png"\r\nContent-Type: image/png\r\n\r\n`),
      fs.readFileSync(shotPath),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${tgToken}/sendPhoto`,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length }
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } else {
    const payload = JSON.stringify({ chat_id: tgChat, text });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${tgToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  }
}

// ── Human‑like Helpers ─────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function humanDelay(min, max) { return sleep(Math.floor(Math.random() * (max - min + 1) + min)); }
function clickDelay(cfg) { return humanDelay(cfg.behavior.click_delay_ms.min, cfg.behavior.click_delay_ms.max); }
function transitionDelay(cfg) { return humanDelay(cfg.behavior.page_transition_delay_ms.min, cfg.behavior.page_transition_delay_ms.max); }

// ── CDP Management ────────────────────────────────────────────────────
let browser;

async function connect() {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  log('cdp_connected');
}

async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    log('browser_disconnected_reconnecting');
    await connect();
  }
}

async function findOrCreatePage(targetUrl) {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('No browser contexts');
  let pages = ctx.pages();
  if (!pages.length) pages = [await ctx.newPage()];
  const hostname = new URL(targetUrl).hostname;
  return pages.find(p => p.url().includes(hostname)) || (await ctx.newPage());
}

async function setupStealth(page) {
  await page.addInitScript(() => {
    delete Object.getPrototypeOf(navigator).webdriver;
    delete window.__playwright;
    delete window.__pw_manual;
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = Object.create(PluginArray.prototype);
        const plugin = Object.create(Plugin.prototype);
        Object.defineProperty(plugin, 'name', { value: 'Chrome PDF Plugin' });
        arr[0] = plugin;
        return arr;
      }
    });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
}

// ── Wait for manual navigation to appointment page ────────────────────
async function waitForAppointmentPage(page, targetUrl) {
  const appointmentPath = targetUrl.includes('tlscontact.com') ? '/appointment-booking' : '/';
  console.log(`\n🔷 Please navigate manually to the appointment booking page.\n   URL must contain: ${appointmentPath}\n   Waiting for you...\n`);
  
  while (true) {
    try {
      const currentUrl = page.url();
      if (currentUrl.includes(appointmentPath)) {
        console.log('✅ Appointment page reached. Starting work...');
        log('appointment_page_detected', { url: currentUrl });
        sendTelegram('🤖 Appointment page detected – soldier starting.');
        return;
      }
    } catch {}
    await sleep(1000);
  }
}

// ── Booking State Machine ─────────────────────────────────────────────
// Automatically select Standard service level if we land on that page
async function autoServiceLevel(page) {
  const url = page.url();
  if (!url.includes('/service-level')) return false;

  // Wait briefly for the page to render
  await sleep(1000);

  // Try multiple real-world selectors for the "Standard" option
  const standardBtn = page.locator([
    'button:has-text("Standard")',
    'a:has-text("Standard")',
    '.service-level-btn[data-type="standard"]',
    'input[value="Standard"]'
  ].join(', ')).first();

  if (await standardBtn.count() > 0) {
    await standardBtn.click();
    log('auto_selected_standard_service');
    await sleep(500);
    // Look for a "Continue" or "Next" button after selecting
    const continueBtn = page.locator('button:has-text("Continue"), a:has-text("Continue")').first();
    if (await continueBtn.count() > 0 && await continueBtn.isVisible()) {
      await continueBtn.click();
      log('clicked_continue_after_service_selection');
    }
    return true;
  }
  log('standard_button_not_found_on_service_page');
  return false;
}
async function attemptBooking(page, selectors, config) {
  if (page.url().includes('/login')) {
    log('session_expired_on_login_page');
    return false;
  }

  // 1. Courier step – only if #courier-step is visible
  const courierContainer = page.locator('#courier-step').first();
  if (await courierContainer.count() > 0 && await courierContainer.isVisible()) {
    const courierBtn = courierContainer.locator('button:has-text("Continue")').first();
    if (await courierBtn.count() > 0 && await courierBtn.isVisible()) {
      debug('clicking_courier');
      await courierBtn.click();
      log('courier_step');
      await transitionDelay(config);
    }
  }

  // 2. No-slots message
  const noSlots = page.locator('.no-slots, #noSlotsMsg').first();
  if (await noSlots.count() > 0 && await noSlots.isVisible()) {
    log('no_slots_visible');
    return false;
  }

  // 3. Month tab
  const activeMonth = page.locator(`${selectors.month_tab}.active`).first();
  if (await activeMonth.count() === 0) {
    const tabs = page.locator(selectors.month_tab);
    if (await tabs.count() > 0) {
      await tabs.first().click();
      log('month_tab_clicked');
      await humanDelay(300, 600);
    }
  }

  // 4. Available day
  const dayBtn = page.locator(`${selectors.day_cell}.available`).first();
  if (await dayBtn.count() === 0) {
    log('no_available_days');
    return false;
  }
  await dayBtn.click();
  log('day_selected');
  await transitionDelay(config);

  // 5. Wait for slot buttons
  const slotBtn = page.locator('.tls-time-unit, button[data-time]').first();
  try {
    await slotBtn.waitFor({ state: 'visible', timeout: config.behavior.ajax_timeout_ms });
  } catch {
    log('slots_did_not_appear');
    return false;
  }
  await slotBtn.click();
  log('slot_selected');
  await clickDelay(config);

  // 6. Book button
  const bookBtn = page.locator('#bookBtn, button:has-text("Book your appointment")').first();
  if (await bookBtn.count() > 0 && await bookBtn.isEnabled()) {
    await bookBtn.click();
    log('book_clicked');
    
    // 7. Wait for confirmation
    try {
      const modal = page.locator('.modal-overlay.active');
      await modal.waitFor({ state: 'visible', timeout: 10000 });
      debug('confirmation_modal_detected');
    } catch {
      const ordered = await page.waitForURL('**/order-summary', { timeout: 5000 }).catch(() => false);
      if (!ordered) {
        log('confirmation_not_found');
        return false;
      }
    }
    
    const shotPath = path.join(logDir, `booking_${Date.now()}.png`);
    await page.screenshot({ path: shotPath, fullPage: true });
    log('booking_success');
    sendTelegram('✅ Appointment booked!', shotPath);
    return true;
  }
  
  log('booking_incomplete');
  return false;
}

// ── Refresh & Cloudflare ──────────────────────────────────────────────
async function safeReload(page, config) {
  log('page_reload');
  await page.reload({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  await transitionDelay(config);
}

async function isCloudflareBlock(page) {
  const txt = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  return /you have been blocked|checking your browser/i.test(txt);
}

async function handleBlock(page) {
  let backoff = 60000;
  while (await isCloudflareBlock(page)) {
    log('cloudflare_block_detected', { backoff });
    sendTelegram(`🚫 Cloudflare block – backing off ${backoff / 1000}s`);
    await sleep(backoff);
    await heartbeatRefresh(page, config);
    backoff = Math.min(backoff * 2, 3600000);
  }
}
async function heartbeatRefresh(page, config) {
  const action = Math.random();
  if (action < 0.4) {
    // Visit application list and return
    log('heartbeat_navigation');
    await page.goto('https://visas-pt.tlscontact.com', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await transitionDelay(config);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await transitionDelay(config);
  } else {
    // Simple reload
    log('page_reload');
    await page.reload({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    await transitionDelay(config);
  }
}
// ── Main Loop ─────────────────────────────────────────────────────────
async function run() {
  if (!acquireLock()) {
    console.error('Another instance is already running for this client. Exiting.');
    process.exit(1);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(); });

  const config = loadConfig();
  initTelegram(config);
  const selectors = loadSelectors(config.country);
  const targetUrl = config.simulation
    ? 'http://localhost:8080/'
    : config.baseUrl || 'https://visas-pt.tlscontact.com/en-us/388184/workflow/appointment-booking?location=dzALG2pt';

  log('soldier_start', { client: config.client_id, country: config.country, target: targetUrl, simulation: !!config.simulation });

  await connect();
  let page = await findOrCreatePage(targetUrl);
  await setupStealth(page);

  if (config.simulation) {
    // Simulation mode – auto‑navigate
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    log('simulation_auto_navigated');
  } else {
    // Production mode – wait for manual navigation
    // In the main loop, after we detect the user is on a TLS page:
    await autoServiceLevel(page);
    await waitForAppointmentPage(page, targetUrl);
  }

  let lastRefresh = Date.now();
  const refreshInterval = config.simulation ? 60000 : config.behavior.refresh_interval_seconds * 1000;

  while (true) {
    try {
      await ensureBrowser();
      page = await findOrCreatePage(targetUrl);

      if (await isCloudflareBlock(page)) {
        await handleBlock(page);
        lastRefresh = Date.now();
        continue;
      }

      // Refresh if needed
      if (Date.now() - lastRefresh > refreshInterval) {
        await safeReload(page, config);
        lastRefresh = Date.now();
      }

      // Attempt booking
      const booked = await attemptBooking(page, selectors, config);
      if (booked) {
        sendTelegram('🎉 Booking successful!');
        await sleep(30000);
        await safeReload(page, config);
        lastRefresh = Date.now();
      } else if (!args.sim) {
        await humanDelay(4000, 8000);
      }
      if (args.sim) await sleep(2000);
    } catch (err) {
      log('loop_error', { error: err.message });
      await sleep(5000);
    }
  }
}

run().catch((err) => {
  log('fatal_error', { error: err.message });
  sendTelegram(`❌ Soldier crashed: ${err.message}`);
  process.exit(1);
});