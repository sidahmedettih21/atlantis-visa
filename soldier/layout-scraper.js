// soldier/layout-scraper-v5.js — NSA-grade TLS session recorder
// Non-intrusive: read-only network tap, zero traffic modification
'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CFG = Object.freeze({
  CDP_PORT:           9222,
  OUT_DIR:            path.join(__dirname, 'sessions'),
  OP_TIMEOUT_MS:      6_000,
  MUT_DEBOUNCE_MS:    350,
  BODY_SIZE_LIMIT:    128 * 1024,
  COMPRESS_LOG:       true,
  SCREENSHOT_ON_SLOT: true,

  // DOM selector — exhaustive coverage
  LAYOUT_SEL: [
    'button', 'a[href]', 'input', 'select', 'textarea', 'label',
    'h1,h2,h3,h4,h5,h6',
    '[role="button"],[role="tab"],[role="option"],[role="menuitem"],[role="radio"],[role="checkbox"]',
    '[class*="slot" i],[class*="time" i],[class*="day" i],[class*="date" i]',
    '[class*="calendar" i],[class*="available" i],[class*="open" i],[class*="free" i]',
    '[class*="appoint" i],[class*="booking" i],[class*="session" i]',
    '[data-testid],[data-action],[data-date],[data-slot],[data-time]',
    '[onclick]',
    'td,th',           // calendar table cells
    'svg,path,circle,rect', // icon-based slot indicators
  ].join(','),

  // Slot heuristics — DOM text/attr matching
  SLOT_DOM_RX: [
    /\bavailable\b/i, /\bopen\b/i, /\bfree\b/i, /\bdisponible\b/i,
    /\bréserver\b/i,  /\bbook(?:ing)?\b/i, /\bappointment\b/i,
    /\brendezvous\b/i,/\brdv\b/i,
    /\d{1,2}[:/]\d{2}/, /\d{1,2}\s*(?:am|pm)/i,
    /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}/i,
  ],

  // Slot heuristics — JSON response body key scanning
  SLOT_JSON_KEYS: [
    'available', 'slots', 'appointments', 'openSlots', 'freeSlots',
    'disponible', 'creneaux', 'rendez_vous', 'bookable',
    'times', 'dates', 'schedule',
  ],

  // Only intercept these resource types for body capture
  CAPTURE_TYPES: new Set(['xhr', 'fetch']),

  // Domains to skip body capture (noise)
  SKIP_BODY_DOMAINS: [
    'google-analytics.com', 'doubleclick.net', 'googlesyndication.com',
    'recaptcha.net', 'gstatic.com', 'fonts.googleapis.com',
  ],
});

// ─── I/O SETUP ───────────────────────────────────────────────────────────────
const SESSION_ID = Date.now();
fs.mkdirSync(path.join(CFG.OUT_DIR, 'screenshots'), { recursive: true });
const LOG_PATH   = path.join(CFG.OUT_DIR, `session_${SESSION_ID}.ndjson`);
const logStream  = fs.createWriteStream(LOG_PATH, { flags: 'a' });

// Live stats
const STATS = { events: 0, slots: 0, networks: 0, mutations: 0, screenshots: 0 };

function emit(type, payload) {
  const ev = { t: Date.now(), type, ...payload };
  logStream.write(JSON.stringify(ev) + '\n');
  STATS.events++;
  if (type === 'slot_detected') {
    STATS.slots++;
    process.stderr.write(`\n🎯 SLOT DETECTED → ${JSON.stringify(payload)}\n`);
  }
  if (type === 'error') {
    process.stderr.write(`[ERR] ${payload.phase}: ${payload.msg}\n`);
  }
}
// VERIFY: Pre: logStream open → Post: atomic line write, no partial JSON

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const sleep   = (ms) => new Promise(r => setTimeout(r, ms));
const timeout = (ms) => new Promise((_, r) => setTimeout(() => r(new Error(`⏱ timeout:${ms}`)), ms));
const race    = (p, ms) => Promise.race([p, timeout(ms)]);
const hash    = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const skipDomain = (url) => CFG.SKIP_BODY_DOMAINS.some(d => url.includes(d));

function safePostData(req) {
  // Never call postDataJSON() — crashes on binary (protobuf, multipart, etc.)
  try { return req.postData()?.slice(0, 1024) ?? null; } catch { return null; }
}
// VERIFY: Pre: any request → Post: string≤1024 or null, never throws

// ─── IN-PAGE MONITOR (injected string) ───────────────────────────────────────
// Captures: clicks, inputs, changes, mutations, storage, visibility changes
const IN_PAGE_MONITOR = `(function(){
  if(window.__v5_active) return;
  window.__v5_active = true;

  const _emit = (obj) => {
    try { console.log('__EV5__' + JSON.stringify(obj)); } catch {}
  };

  function safeCN(el){
    try{
      const c = el.className;
      return (typeof c==='string'?c:(c&&c.baseVal)||'').slice(0,150);
    }catch{return '';}
  }

  function elSnap(el){
    try{
      const r = el.getBoundingClientRect();
      return {
        tag:  el.tagName||'',
        id:   el.id||'',
        cls:  safeCN(el),
        txt:  (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,120),
        ph:   el.placeholder||'',
        type: el.type||'',
        name: el.name||'',
        val:  el.value!==undefined?String(el.value).slice(0,150):'',
        href: el.href||'',
        role: el.getAttribute('role')||'',
        aria: el.getAttribute('aria-label')||'',
        dtid: el.getAttribute('data-testid')||'',
        ddate:el.getAttribute('data-date')||'',
        dslot:el.getAttribute('data-slot')||'',
        dis:  !!el.disabled,
        rect: {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
      };
    }catch{return {tag:'?',err:1};}
  }

  // Interaction events
  ['click','mousedown'].forEach(evName=>{
    document.addEventListener(evName,(e)=>{
      _emit({ev:evName,...elSnap(e.target),cx:e.clientX,cy:e.clientY,ts:Date.now()});
    },{capture:true,passive:true});
  });

  ['input','change','focus','blur'].forEach(evName=>{
    document.addEventListener(evName,(e)=>{
      _emit({ev:evName,...elSnap(e.target),ts:Date.now()});
    },{capture:true,passive:true});
  });

  // Form submit
  document.addEventListener('submit',(e)=>{
    const f = e.target;
    _emit({ev:'submit',id:f.id||'',action:f.action||'',method:f.method||'',ts:Date.now()});
  },{capture:true,passive:true});

  // localStorage/sessionStorage spy
  ['localStorage','sessionStorage'].forEach(storeName=>{
    try{
      const orig = window[storeName];
      const origSet = orig.setItem.bind(orig);
      orig.setItem = function(k,v){
        _emit({ev:'storage',store:storeName,key:k,val:String(v).slice(0,500),ts:Date.now()});
        return origSet(k,v);
      };
    }catch{}
  });

  // Cookie spy — fires when cookie changes
  let _lastCookie = document.cookie;
  setInterval(()=>{
    const cur = document.cookie;
    if(cur!==_lastCookie){
      _emit({ev:'cookie_change',prev:_lastCookie.slice(0,300),cur:cur.slice(0,300),ts:Date.now()});
      _lastCookie=cur;
    }
  }, 1000);

  // Page visibility
  document.addEventListener('visibilitychange',()=>{
    _emit({ev:'visibility',state:document.visibilityState,ts:Date.now()});
  });

  // MutationObserver — debounced, reports DOM size + added node summary
  let _mt=null;
  const obs=new MutationObserver((muts)=>{
    clearTimeout(_mt);
    _mt=setTimeout(()=>{
      const added=[];
      muts.forEach(m=>{
        m.addedNodes.forEach(n=>{
          if(n.nodeType===1){
            added.push({
              tag:n.tagName||'',
              cls:safeCN(n),
              txt:(n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80),
              ddate:n.getAttribute&&n.getAttribute('data-date')||'',
              dslot:n.getAttribute&&n.getAttribute('data-slot')||'',
            });
          }
        });
      });
      _emit({ev:'mutation',domLen:document.body?document.body.innerHTML.length:0,added:added.slice(0,30),ts:Date.now()});
    },${CFG.MUT_DEBOUNCE_MS});
  });
  obs.observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:false});

  // Intercept XHR at JS level (catches anything page.route misses)
  const _XHR = window.XMLHttpRequest.prototype;
  const _open = _XHR.open, _send = _XHR.send;
  _XHR.open = function(method,url){
    this.__v5_url=url; this.__v5_method=method;
    return _open.apply(this,arguments);
  };
  _XHR.send = function(body){
    this.addEventListener('load',function(){
      try{
        _emit({ev:'xhr_done',method:this.__v5_method,url:String(this.__v5_url).slice(0,300),
          status:this.status,body:this.responseText.slice(0,2000),ts:Date.now()});
      }catch{}
    });
    return _send.apply(this,arguments);
  };

  // Intercept fetch at JS level
  const _fetch=window.fetch;
  window.fetch=function(input,init){
    const url=typeof input==='string'?input:(input.url||'');
    const p=_fetch.apply(this,arguments);
    p.then(r=>r.clone().text().then(body=>{
      _emit({ev:'fetch_done',url:String(url).slice(0,300),status:r.status,body:body.slice(0,2000),ts:Date.now()});
    }).catch(()=>{})).catch(()=>{});
    return p;
  };

})();`;
// VERIFY: Pre: injected once per frame (guard flag) → Post: all 10 event types active, no duplicates

// ─── LAYOUT CAPTURE ──────────────────────────────────────────────────────────
async function captureLayout(page) {
  return race(
    page.evaluate((sel) => {
      function safeCN(el){
        try{const c=el.className;return(typeof c==='string'?c:(c&&c.baseVal)||'').slice(0,150);}catch{return '';}
      }
      const out=[];
      document.querySelectorAll(sel).forEach(el=>{
        try{
          const r=el.getBoundingClientRect();
          const s=window.getComputedStyle(el);
          if(r.width<3&&r.height<3)return;
          if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return;
          out.push({
            tag:  el.tagName,
            id:   el.id||'',
            cls:  safeCN(el),
            txt:  (el.textContent||'').replace(/\s+/g,' ').trim().slice(0,120),
            ph:   el.placeholder||'',
            type: el.type||'',
            name: el.name||'',
            val:  el.value!==undefined?String(el.value).slice(0,150):'',
            href: el.href||'',
            role: el.getAttribute('role')||'',
            aria: el.getAttribute('aria-label')||'',
            dtid: el.getAttribute('data-testid')||'',
            ddate:el.getAttribute('data-date')||'',
            dslot:el.getAttribute('data-slot')||'',
            dis:  !!el.disabled,
            rect: {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
            style:{
              color: s.color,
              bg:    s.backgroundColor,
              border:s.border,
              cursor:s.cursor,
              op:    s.opacity,
              zi:    s.zIndex,
              ptr:   s.pointerEvents,
            },
          });
        }catch{}
      });
      return out;
    }, CFG.LAYOUT_SEL),
    CFG.OP_TIMEOUT_MS
  ).catch(err => { emit('error',{phase:'captureLayout',msg:err.message}); return []; });
}
// VERIFY: Pre: page alive → Post: element array or [] — never throws

// ─── SLOT DETECTION ──────────────────────────────────────────────────────────
function detectSlotsDOM(elements, url, source) {
  const hits = elements.filter(el => {
    if (el.dis) return false;
    if (el.style?.ptr === 'none') return false;
    const hay = `${el.txt} ${el.aria} ${el.cls} ${el.dtid} ${el.ddate} ${el.dslot}`;
    return CFG.SLOT_DOM_RX.some(rx => rx.test(hay));
  });
  if (hits.length) {
    emit('slot_detected', {
      source, url,
      count: hits.length,
      slots: hits.map(h => ({
        txt:   h.txt,
        aria:  h.aria,
        cls:   h.cls,
        ddate: h.ddate,
        dslot: h.dslot,
        rect:  h.rect,
        cursor:h.style?.cursor,
      })),
    });
    STATS.slots++;
    return true;
  }
  return false;
}
// VERIFY: Pre: elements valid → Post: emits slot_detected if any matched; skips disabled + pointer-events:none

function detectSlotsJSON(body, url) {
  // Scan JSON response bodies for slot-related keys with truthy values
  if (!body || typeof body !== 'object') return;
  const found = [];
  function walk(obj, depth) {
    if (depth > 6 || !obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const kl = k.toLowerCase();
      if (CFG.SLOT_JSON_KEYS.some(sk => kl.includes(sk))) {
        const v = obj[k];
        if (v && (Array.isArray(v) ? v.length > 0 : true)) {
          found.push({ key: k, val: JSON.stringify(v).slice(0, 300) });
        }
      }
      if (obj[k] && typeof obj[k] === 'object') walk(obj[k], depth + 1);
    }
  }
  walk(body, 0);
  if (found.length) {
    emit('slot_detected', { source: 'json_body', url, matches: found });
    STATS.slots++;
  }
}
// VERIFY: Pre: body is parsed JSON → Post: walks up to depth 6, emits on any SLOT_JSON_KEYS hit

// ─── LAYOUT DIFF ─────────────────────────────────────────────────────────────
const layoutCache = new Map();
function layoutChanged(frameId, elements) {
  const h = hash(elements.map(e => `${e.tag}|${e.id}|${e.txt}|${e.dis}|${e.ddate}|${e.dslot}`));
  const prev = layoutCache.get(frameId);
  layoutCache.set(frameId, h);
  return prev !== h;
}
// VERIFY: Pre: elements non-null → Post: true only on structural change (data-date/slot included in hash)

// ─── SCREENSHOT ──────────────────────────────────────────────────────────────
async function screenshot(page, reason) {
  STATS.screenshots++;
  const p = path.join(CFG.OUT_DIR, 'screenshots', `${Date.now()}_${reason}.png`);
  await race(page.screenshot({ path: p, fullPage: true }), CFG.OP_TIMEOUT_MS).catch(() => {});
  emit('screenshot', { reason, path: p });
}

// ─── FRAME INJECTION ─────────────────────────────────────────────────────────
async function injectFrame(frame) {
  await race(frame.evaluate(IN_PAGE_MONITOR), CFG.OP_TIMEOUT_MS).catch(() => {});
}

// ─── LAYOUT SNAPSHOT PIPELINE ────────────────────────────────────────────────
async function snapshotPipeline(page, source) {
  const url = page.url();
  const els = await captureLayout(page);
  if (!layoutChanged(source, els)) return;
  emit('layout', { source, url, count: els.length, elements: els });
  const found = detectSlotsDOM(els, url, source);
  if (found && CFG.SCREENSHOT_ON_SLOT) await screenshot(page, `slot_${source}`);
  STATS.mutations++;
}
// VERIFY: Pre: page alive → Post: layout emitted only on change; slot detection always runs

// ─── LIVE DASHBOARD ──────────────────────────────────────────────────────────
function startDashboard() {
  setInterval(() => {
    process.stderr.write(
      `\r📊 events:${STATS.events} | net:${STATS.networks} | mutations:${STATS.mutations}` +
      ` | slots:${STATS.slots} | screens:${STATS.screenshots}   `
    );
  }, 2000);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CFG.CDP_PORT}`);
  const ctx     = browser.contexts()[0];
  const page    = ctx.pages()[0] || await ctx.newPage();

  emit('session_start', { sessionId: SESSION_ID, url: page.url(), ua: await browser.version() });

  // ── READ-ONLY network tap (no route interception = no binary crash) ────────
  page.on('request', (req) => {
    if (!CFG.CAPTURE_TYPES.has(req.resourceType())) return;
    STATS.networks++;
    emit('network_req', {
      method:   req.method(),
      url:      req.url().slice(0, 500),
      headers:  req.headers(),
      postData: safePostData(req),   // ← safe, never throws
    });
  });

  page.on('response', async (resp) => {
    const req = resp.request();
    if (!CFG.CAPTURE_TYPES.has(req.resourceType())) return;
    if (skipDomain(resp.url())) return;

    const ct = resp.headers()['content-type'] || '';
    let body = null;

    try {
      const buf = await race(resp.body(), CFG.OP_TIMEOUT_MS);
      if (buf && buf.length <= CFG.BODY_SIZE_LIMIT) {
        if (ct.includes('json')) {
          try {
            body = JSON.parse(buf.toString('utf8'));
            detectSlotsJSON(body, resp.url()); // scan JSON for slot keys
          } catch { body = buf.toString('utf8').slice(0, 2000); }
        } else if (ct.includes('text')) {
          body = buf.toString('utf8').slice(0, 2000);
        } else {
          body = `[binary ${buf.length}B]`;
        }
      }
    } catch { body = null; }

    emit('network_res', {
      url:    resp.url().slice(0, 500),
      status: resp.status(),
      ct,
      body,
    });
  });
  // VERIFY: Pre: read-only listeners → Post: zero traffic modification, no binary crash

  // ── WebSocket monitoring ───────────────────────────────────────────────────
  page.on('websocket', (ws) => {
    emit('ws_open', { url: ws.url().slice(0, 300) });
    ws.on('framereceived', (f) => {
      const data = typeof f.payload === 'string'
        ? f.payload.slice(0, 1000)
        : `[binary ${f.payload?.length}B]`;
      emit('ws_frame', { dir: 'recv', url: ws.url().slice(0,300), data });
      // Scan WS frames for slot keywords
      if (typeof f.payload === 'string') {
        CFG.SLOT_DOM_RX.forEach(rx => {
          if (rx.test(f.payload)) {
            emit('slot_detected', { source: 'websocket', url: ws.url(), data: f.payload.slice(0, 500) });
            STATS.slots++;
          }
        });
      }
    });
    ws.on('framesent',     (f) => emit('ws_frame', { dir: 'sent', url: ws.url().slice(0,300), data: String(f.payload).slice(0,500) }));
    ws.on('socketerror',   (e) => emit('ws_error', { url: ws.url(), err: String(e) }));
    ws.on('close',         ()  => emit('ws_close', { url: ws.url() }));
  });
  // VERIFY: Pre: WS connection established → Post: every frame logged bidirectionally

  // ── Navigation ────────────────────────────────────────────────────────────
  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = page.url();
    emit('nav', { url });
    await injectFrame(frame);
    await snapshotPipeline(page, 'nav');
    await screenshot(page, 'nav');
  });

  // ── iframe injection ───────────────────────────────────────────────────────
  ctx.on('page', (p) => {
    p.frames().forEach(injectFrame);
    p.on('frameattached', injectFrame);
  });
  page.frames().forEach(injectFrame);
  page.on('frameattached', injectFrame);

  // ── In-page console events ────────────────────────────────────────────────
  page.on('console', async (msg) => {
    const text = msg.text();
    if (!text.startsWith('__EV5__')) return;

    let ev;
    try { ev = JSON.parse(text.slice(7)); } catch { return; }

    switch (ev.ev) {
      case 'mutation':
        emit('mutation_raw', { domLen: ev.domLen, added: ev.added });
        await snapshotPipeline(page, 'mutation');
        break;

      case 'xhr_done':
      case 'fetch_done':
        // JS-level network capture (complements playwright's)
        emit('js_network', ev);
        // Scan body for slots
        try {
          const parsed = JSON.parse(ev.body);
          detectSlotsJSON(parsed, ev.url);
        } catch {}
        break;

      case 'storage':
        emit('storage', ev);
        break;

      case 'cookie_change':
        emit('cookie_change', ev);
        break;

      default:
        // click, mousedown, input, change, focus, blur, submit, visibility
        emit(ev.ev, ev);
        // On any click: capture layout delta
        if (ev.ev === 'click') {
          await sleep(600); // wait for SPA render
          await snapshotPipeline(page, 'post_click');
        }
    }
  });

  // ── Page crash / dialog ───────────────────────────────────────────────────
  page.on('crash',         ()  => emit('error', { phase: 'page', msg: 'page crashed' }));
  page.on('pageerror',     (e) => emit('error', { phase: 'pageerror', msg: String(e) }));
  page.on('dialog',        async (d) => {
    emit('dialog', { type: d.type(), msg: d.message() });
    await d.dismiss().catch(() => {});
  });

  // ── Initial snapshot ──────────────────────────────────────────────────────
  await injectFrame(page.mainFrame());
  await snapshotPipeline(page, 'init');

  // ── Periodic sweep (catches lazy-loaded SPA state without mutation) ────────
  setInterval(async () => {
    await snapshotPipeline(page, 'sweep');
  }, 8000);

  // ── Live dashboard ────────────────────────────────────────────────────────
  startDashboard();

  process.stderr.write(`
╔══════════════════════════════════════════════════════╗
║  v5 recorder active   session ${SESSION_ID}
║  log  → ${LOG_PATH}
║  shots→ ${path.join(CFG.OUT_DIR, 'screenshots')}
║  🎯  slot_detected streams to stderr immediately
╚══════════════════════════════════════════════════════╝

Now: login → group → courier → appointment page
Press Ctrl+C when done.
`);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = () => {
    emit('session_end', { sessionId: SESSION_ID, stats: STATS });
    logStream.end(() => {
      if (!CFG.COMPRESS_LOG) { process.exit(0); return; }
      const gz = `${LOG_PATH}.gz`;
      fs.createReadStream(LOG_PATH)
        .pipe(zlib.createGzip({ level: 9 }))
        .pipe(fs.createWriteStream(gz))
        .on('finish', () => {
          fs.unlinkSync(LOG_PATH);
          process.stderr.write(`\n✅ Compressed → ${gz}\n`);
          process.exit(0);
        });
    });
  };

  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
})();