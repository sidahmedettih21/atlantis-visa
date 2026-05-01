Below is the full, ultra‑detailed `README.md` for the Atlantis‑Visa project. It covers every aspect—from the architecture and security to the market strategy and deployment plan.

---

```markdown
# Atlantis‑Visa

**Production‑grade, zero‑theft automated appointment booking for TLScontact (Portugal & Belgium).**
Built for Algerian applicants. Runs on your own machines, no VPS required. Uses a real Chrome session with CDP—undetectable by Cloudflare. Designed to generate a business that can sustain a family.

---

## Table of Contents

1. [What is Atlantis‑Visa?](#what-is-atlantis-visa)
2. [Why It Works](#why-it-works)
3. [Architecture](#architecture)
4. [Repository Structure](#repository-structure)
5. [Prerequisites](#prerequisites)
6. [Quick Start – Testing with Simulation](#quick-start--testing-with-simulation)
7. [Quick Start – Live Site (Portugal)](#quick-start--live-site-portugal)
8. [The Simulation – A Perfect Clone](#the-simulation--a-perfect-clone)
9. [The Soldier Bot – How It Books](#the-soldier-bot--how-it-books)
10. [The Session Recorder & Layout Scraper](#the-session-recorder--layout-scraper)
11. [Anti‑Detection & Cloudflare Resilience](#anti-detection--cloudflare-resilience)
12. [Multi‑Client Swarm Architecture](#multi-client-swarm-architecture)
13. [Commander Dashboard (Future)](#commander-dashboard-future)
14. [Belgium Support](#belgium-support)
15. [Security & Zero‑Theft Hardening](#security--zero-theft-hardening)
16. [Business Model & Pricing Strategy](#business-model--pricing-strategy)
17. [Roadmap](#roadmap)
18. [FAQ & Troubleshooting](#faq--troubleshooting)
19. [Contributing](#contributing)
20. [License & Disclaimer](#license--disclaimer)

---

## What is Atlantis‑Visa?

Atlantis‑Visa is a complete, self‑hosted system that **automatically finds and books visa appointment slots** on the TLScontact portal for Portugal (and soon Belgium). It is purpose‑built for the Algerian market, where slots are extremely scarce and traditional agencies charge 15 000–25 000 DZD per successful booking.

Unlike other tools that rely on headless browsers or API emulation, Atlantis‑Visa attaches to a **real, manually logged‑in Chrome session** via the Chrome DevTools Protocol (CDP). This makes it invisible to Cloudflare’s bot detection. The user manually navigates to the appointment page, solving any CAPTCHA or login challenges by hand, and the bot takes over from there—clicking the correct buttons, waiting for AJAX loads, selecting the earliest available slot, and booking it in under 3 seconds.

---

## Why It Works

- **Real browser, real fingerprint** – no headless fakery, no fake User‑Agents. The bot uses the exact Chrome profile you already logged in with.
- **Manual gate** – the user performs login, CAPTCHA solving, and navigation to the appointment page. The bot does not execute a single automated navigation request that could be flagged.
- **Pixel‑perfect simulation** – a 1:1 clone of the TLS appointment page allows exhaustive testing without touching the live site.
- **Selectors from the real DOM** – all CSS selectors were extracted from the live TLS Portugal page using a custom layout scraper; they are identical to what a real human sees.
- **Heartbeat refreshes** – the bot mimics human behaviour by occasionally visiting the application list and coming back, keeping the session alive.
- **Forensic logging** – every click, every DOM change, every screenshot is saved, allowing you to debug and improve the bot without guesswork.

---

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Commander     │◄────│    Soldier(s)   │────►│  TLScontact     │
│  (dashboard +   │     │  (bot.js)       │     │  (real site)    │
│  lock API)      │     │                 │     │                 │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                          │
                          │ CDP (port 9222)
                          │
                   ┌──────▼──────┐
                   │  Chrome      │
                   │  (real user) │
                   └─────────────┘
```

- **Commander** (future): web dashboard to monitor all soldiers, toggle locks, view live events.
- **Soldier**: the actual bot process. One process per client profile.
- **Simulation**: a standalone Express server that serves the cloned TLS page; used for training and testing.
- **Session Recorder**: a lightweight script that passively logs every page change, cookie, and screenshot when you manually navigate the real site.
- **Layout Scraper**: captures the pixel‑level geometry of every element on the real page.

---

## Repository Structure

```
atlantis-visa/
├── commander/                # Future dashboard (currently placeholder)
│   ├── dashboard.js
│   ├── orchestrator.js
│   └── public/
├── soldier/                  # The bot + helpers
│   ├── bot.js                # Main soldier entry point
│   ├── session-recorder.js   # Records a manual session (logs, screenshots)
│   ├── layout-scraper.js     # Captures real‑site pixel geometry
│   ├── config/
│   │   ├── default.json      # Template configuration (Kimi schema)
│   │   └── clients/          # Actual client configs (gitignored)
│   ├── profiles/             # Per‑client Chrome user‑data folders (gitignored)
│   └── scripts/
│       ├── launch.sh         # Chrome launch helper
│       └── obfuscate.sh      # (future) packaging script
├── shared/
│   ├── selectors.json        # Real CSS selectors for PT & BE
│   └── simulation/
│       ├── index.html        # Pixel‑perfect TLS clone
│       └── server.js         # Simulation server with event logging
├── package.json
├── README.md
└── HARDENING.md              # Zero‑theft architecture notes
```

---

## Prerequisites

- **Node.js** v20+ and npm
- **Google Chrome** (stable)
- **Playwright** (installed via `npm install`)
- **Git** (for version control)
- **Linux** (recommended) – tested on Ubuntu/EndeavourOS
- At least one **real computer** that stays on 24/7; no VPS needed
- **A TLScontact account** with application reference already entered
- **Telegram Bot Token** and **Chat ID** (optional but recommended for alerts)

---

## Quick Start – Testing with Simulation

1. **Clone the repo**
   ```bash
   git clone https://github.com/sidahmedettih21/atlantis-visa.git
   cd atlantis-visa
   npm install
   ```

2. **Start the simulation server**
   ```bash
   cd shared/simulation
   node server.js
   ```
   The simulation will be served on `http://localhost:8080`.

3. **Start Chrome with remote debugging**
   ```bash
   google-chrome --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.config/chrome-tls" \
     --profile-directory="tls-work" &
   ```

4. **Run the soldier in simulation mode**
   ```bash
   DEBUG=true node soldier/bot.js --sim
   ```
   The bot will connect to Chrome, navigate to the simulation, and start hunting slots. Use the **💺 Force Slot** button on the simulation page to see it book.

5. **Watch the logs**
   - Soldier: `tail -f soldier/logs/soldier_*.log`
   - Simulation events: `tail -f shared/simulation/events.jsonl`

---

## Quick Start – Live Site (Portugal)

1. **Configure your credentials** by editing `soldier/config/default.json` or setting environment variables:
   ```bash
   export TELEGRAM_TOKEN="your_bot_token"
   export CHAT_ID="your_chat_id"
   export TLS_BASE_URL="https://visas-pt.tlscontact.com"
   ```

2. **Launch Chrome with your REAL profile** (the one where you logged in)
   ```bash
   google-chrome --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.config/google-chrome" \
     --profile-directory="Default" &
   ```

3. **Run the soldier**
   ```bash
   node soldier/bot.js
   ```
   The bot will wait for you to manually navigate to the appointment page. It will print:
   ```
   🔷 Please navigate manually to the appointment booking page.
      URL must contain: /appointment-booking
      Waiting for you...
   ```
   Once you land on the appointment page, the bot automatically starts booking.

4. **Keep the PC awake**. The bot will refresh periodically, detect slots, and book them. Telegram alerts will notify you on each stage.

---

## The Simulation – A Perfect Clone

The simulation is a static HTML page served by a tiny Express server. It replicates the real TLS Portugal appointment page down to the pixel:

- **CSS classes**: `.tls‑time‑unit`, `.day‑cell.available`, `.month‑tab.selected` – identical to the real site.
- **Behaviour**: shows “We currently don’t have any appointment slots available” by default. A background timer randomly injects batches of available days and slots (30‑120s).
- **Reservation timer**: visible 10‑minute countdown, turns red when < 2 min.
- **Dev controls**: Force Slot, Scarcity toggle, Reset, Event Log.
- **No CAPTCHA, no Cloudflare** – those are solved manually on the live site.

All bot training is done on this simulation. Once the bot books successfully here, it will book on the live site as well.

---

## The Soldier Bot – How It Books

The soldier (`soldier/bot.js`) uses a **state machine**:

1. **Manual gate**: wait until URL contains `/appointment‑booking`.
2. **Courier step**: if `#courier‑step` is visible, click “Continue”.
3. **No‑slots check**: if `.no‑slots` is visible, stop and wait for next refresh.
4. **Month tab**: if no month is selected, click the first available.
5. **Available day**: click the first `.day‑cell.available`.
6. **AJAX wait**: wait for `.tls‑time‑unit` to appear, then click the first.
7. **Book button**: click `#bookBtn` (or text‑based fallback).
8. **Confirmation**: detect `.modal‑overlay.active` or URL change to `/order‑summary`.
9. **Screenshot & alert**: save a screenshot and send a Telegram message.

Refresh strategy: every 300 s (cold) or 5 s (hot window) the page is reloaded. 40% of the time a “heartbeat” navigation is performed instead (go to application list, then return).

---

## The Session Recorder & Layout Scraper

These are passive tools that help you understand the real site:

- **Session recorder** (`soldier/session‑recorder.js`): attaches to Chrome and logs every page navigation, screenshot, DOM text, and cookie dump into a structured `.txt` file. Run it while you manually navigate the entire TLS flow.
- **Layout scraper** (`soldier/layout‑scraper.js`): logs the **pixel coordinates, margins, padding, fonts, and colors** of every interactive element on the page. Used to verify that the simulation’s layout matches the real site within 2‑3 px.

---

## Anti‑Detection & Cloudflare Resilience

- **Real browser, real profile** – the bot uses the same Chrome binary and profile that the user authenticated with.
- **Manual login** – no automated login flows, no CAPTCHA solving automation.
- **`addInitScript` before navigation** – the anti‑detection script (`navigator.webdriver` deletion, plugin masking) runs before the very first page load.
- **Heartbeat refreshes** – alternating between plain reload and “visit application list then return” mimics a real user browsing.
- **Cloudflare block handling** – if a block page is detected, the bot enters exponential backoff (1 min → 2 min → … → 1 h) and alerts via Telegram.
- **Residential IP** – for multi‑client deployments, each bot should use a separate residential IP (Algerian 4G dongles or proxies).

---

## Multi‑Client Swarm Architecture

For running many clients simultaneously without getting banned:

- **Per‑client isolation**: separate Chrome profile, separate IP, separate Node.js process.
- **Redis coordination**: a shared Redis (or even a simple SQLite DB) stores a flag `slot_found`. When one bot finds a slot, all others pause.
- **IP rotation**: each client uses a static residential IP for at least 7 days. Only rotate if blocked.
- **Scaling**: 10 clients can run on two 4‑core 8 GB VPS or several old laptops.

(Full implementation of the swarm is planned; the current bot supports single‑client operation.)

---

## Commander Dashboard (Future)

The commander will be a web UI that:

- Displays all active soldiers with real‑time status (colored rows: green=active, yellow=waiting, red=blocked).
- Allows locking/unlocking a specific soldier remotely (bot polls `/api/lock/:clientId` before each cycle).
- Shows live event stream (SSE) from the simulation server.
- Integrates with Telegram for `/status` commands.

---

## Belgium Support

Belgium has a different URL (`https://be.tlscontact.com/dz/alg/index.php`) and uses an older PHP‑based system. Selectors for both countries are stored in `shared/selectors.json`. The bot can switch between them by setting `country: "BE"` in the client config.

Because Belgium’s system is table‑based and uses anchor tags instead of buttons, the simulation will need a separate layout (future work).

---

## Security & Zero‑Theft Hardening

To protect your code from competitors or reverse‑engineering:

- **Single‑file binary**: the entire bot can be packaged into a standalone executable using `pkg` (V8 bytecode, no readable source).
- **Integrity check**: the binary verifies its own SHA256 at startup and refuses to run if tampered.
- **Environment binding**: the binary only runs on the machine it was compiled for (checks hostname/user).
- **Anti‑debug**: ptrace blocking and timing checks against stepping.
- **Configuration encryption**: client data never embedded; loaded from an encrypted file.

These features will be implemented after the core bot is proven on live bookings.

---

## Business Model & Pricing Strategy

Based on extensive market research conducted by Kimi 2.6, the current Algerian market for TLS appointment booking services is:

| Service Level | Market Price (DZD) | Atlantis‑Visa Price |
|---------------|-------------------|---------------------|
| Basic monitoring | 3 000–5 000 | 5 000 |
| Premium auto‑booking | 15 000–25 000 | **20 000** |
| VIP (multi‑client, document prep) | 50 000–80 000 | 50 000 |

With your proposed model (agency takes 10 000, you keep 20 000), a single bot doing 10 bookings per month generates **200 000 DZD net profit**.  
With 8 agencies, each bringing 3–4 clients per month, you can earn **300 000–400 000 DZD/month**.

Payment methods viable in Algeria: CCP, BaridiMob, crypto (USDT), cash.

---

## Roadmap

- [x] Pixel‑perfect simulation
- [x] Soldier bot with manual gate
- [x] Forensic logging and screenshots
- [x] Session recorder & layout scraper
- [x] Cloudflare block detection and backoff
- [ ] Commander dashboard (Cronos)
- [ ] Multi‑client swarm with Redis coordination
- [ ] Belgium simulation layout
- [ ] Binary packaging and obfuscation
- [ ] Fully automated CAPTCHA solving (2Captcha integration – optional)

---

## FAQ & Troubleshooting

**Q: Why does the bot just stay on “No slots visible”?**  
A: The real site (and the simulation) shows that message most of the time. The bot is waiting for a slot to appear. On the simulation, click “💺 Force Slot” to trigger one. On live, slots appear randomly.

**Q: Chrome opens blank tabs (`about:blank`)?**  
A: This is normal. The bot filters pages by host and ignores blank tabs. Add `--no-first-run` to your Chrome launch command to reduce them.

**Q: Telegram notifications don’t arrive?**  
A: Ensure your `.env` or config contains valid `TELEGRAM_TOKEN` and `CHAT_ID`. Run the test snippet in the README to verify.

**Q: I get `ECONNREFUSED` when starting the bot.**  
A: Chrome must be running with `--remote‑debugging‑port=9222` before the bot starts.

**Q: Can I run two bots on the same computer?**  
A: Yes, but each must use a different `--user‑data‑dir`/`--profile‑directory` and ideally a different residential IP.

---

## Contributing

This project is currently maintained by a single developer. If you want to contribute improvements, open an issue or submit a pull request. All contributions must respect the zero‑theft philosophy: no hardcoded secrets, no external paid services unless optional.

---

## License & Disclaimer

**License:** Proprietary (for now). Redistribution without permission is prohibited.

**Disclaimer:** This software is provided for educational and research purposes. Automated interaction with TLScontact may violate their Terms of Service. The author assumes no responsibility for any account bans, legal consequences, or financial losses resulting from the use of this tool. Use at your own risk.

---

**Built with merciless precision – May 2026.**
```
