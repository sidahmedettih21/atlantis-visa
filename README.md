Got you — the content itself is strong, it just needed tightening, consistency, and less “chaotic energy.” I cleaned wording, fixed formatting, removed repetition, and made it read like a serious production project instead of a brainstorm dump.

Here’s the **clean, professional, single-piece README**:

---

```markdown
# Atlantis-Visa

**Production-grade automated appointment booking for TLScontact (Portugal & Belgium).**  
Built for Algerian applicants. Runs locally on your own machine using a real Chrome session via CDP. No VPS required.

---

## Table of Contents

1. What is Atlantis-Visa?
2. Why It Works
3. Architecture
4. Repository Structure
5. Prerequisites
6. Quick Start – Simulation
7. Quick Start – Live Site
8. Simulation System
9. Soldier Bot Logic
10. Session Recorder & Layout Scraper
11. Anti-Detection Strategy
12. Multi-Client Architecture
13. Commander Dashboard (Planned)
14. Belgium Support
15. Security Hardening
16. Business Model
17. Roadmap
18. FAQ
19. Contributing
20. License & Disclaimer

---

## What is Atlantis-Visa?

Atlantis-Visa is a self-hosted automation system that **detects and books TLScontact visa appointment slots**.

It connects to a **real Chrome browser session** (already logged in by the user) using the Chrome DevTools Protocol (CDP).  
The user handles login and CAPTCHA manually. Once on the appointment page, the bot takes over and completes the booking process automatically.

---

## Why It Works

- Uses a **real browser session** (no headless automation)
- No fake fingerprints or spoofed user agents
- **Manual login gate** avoids detection
- Operates only inside already-authenticated sessions
- Includes a **full simulation environment** for safe testing
- Logs every action for debugging and reliability

---

## Architecture

```

Commander (future dashboard)
│
▼
Soldier Bot (Node.js)
│
▼
Chrome (real user session via CDP)
│
▼
TLScontact Website

```

---

## Repository Structure

```

atlantis-visa/
├── commander/        # Future dashboard
├── soldier/          # Main bot logic
│   ├── bot.js
│   ├── session-recorder.js
│   ├── layout-scraper.js
│   ├── config/
│   ├── profiles/
│   └── scripts/
├── shared/
│   ├── selectors.json
│   └── simulation/
├── package.json
├── README.md
└── HARDENING.md

````

---

## Prerequisites

- Node.js v20+
- Google Chrome (stable)
- Playwright
- Linux (recommended)
- TLScontact account
- Optional: Telegram bot for alerts

---

## Quick Start – Simulation

```bash
git clone https://github.com/sidahmedettih21/atlantis-visa.git
cd atlantis-visa
npm install
````

Start simulation server:

```bash
cd shared/simulation
node server.js
```

Launch Chrome:

```bash
google-chrome --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.config/chrome-tls" &
```

Run bot:

```bash
node soldier/bot.js --sim
```

---

## Quick Start – Live Site

Set environment variables:

```bash
export TLS_BASE_URL="https://visas-pt.tlscontact.com"
export TELEGRAM_TOKEN="your_token"
export CHAT_ID="your_chat_id"
```

Launch Chrome with your real profile:

```bash
google-chrome --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.config/google-chrome" &
```

Run bot:

```bash
node soldier/bot.js
```

Then manually navigate to the appointment page — the bot will take over automatically.

---

## Simulation System

A local clone of the TLS appointment page used for testing.

Features:

* Identical CSS structure
* Simulated slot availability
* Event logging
* Manual slot trigger
* No CAPTCHA or Cloudflare

---

## Soldier Bot Logic

The bot follows a simple state flow:

1. Wait for `/appointment-booking`
2. Handle courier step
3. Check for no slots
4. Select month
5. Select available day
6. Select time slot
7. Confirm booking
8. Capture screenshot + notify

Refresh strategy:

* Slow mode: ~300s
* Fast mode: ~5s
* Random “human-like” navigation

---

## Session Recorder & Layout Scraper

### Session Recorder

Logs:

* Navigation
* Screenshots
* Cookies
* DOM content

### Layout Scraper

Captures:

* Element positions
* Styles
* Layout accuracy

Used to ensure simulation matches the real site.

---

## Anti-Detection Strategy

* Real Chrome profile (no headless)
* Manual authentication
* No automated login requests
* Human-like navigation patterns
* Controlled refresh timing
* Backoff system for blocking

---

## Multi-Client Architecture

Planned scaling model:

* One bot per client
* Separate Chrome profiles
* Separate IP per instance
* Shared coordination (Redis or DB)

---

## Commander Dashboard (Planned)

Future web UI to:

* Monitor bots
* View status in real-time
* Control bot states
* Stream events
* Integrate Telegram commands

---

## Belgium Support

* Different TLS system (older PHP interface)
* Separate selectors
* Future simulation planned

---

## Security Hardening

Planned protections:

* Binary packaging (no readable source)
* Integrity verification
* Machine binding
* Anti-debugging checks
* Encrypted configuration

---

## Business Model

Typical market pricing:

| Service      | Price (DZD) |
| ------------ | ----------- |
| Monitoring   | 3k–5k       |
| Auto-booking | 15k–25k     |
| VIP service  | 50k+        |

Suggested model:

* Charge ~20,000 DZD per booking
* Scale via agencies or direct clients

---

## Roadmap

* [x] Simulation system
* [x] Booking bot
* [x] Logging tools
* [x] Detection handling
* [ ] Dashboard
* [ ] Multi-client system
* [ ] Belgium support
* [ ] Binary packaging

---

## FAQ

**Bot does nothing?**
No slots available. Wait or simulate.

**Chrome issues?**
Ensure remote debugging is enabled.

**Telegram not working?**
Check token and chat ID.

**Multiple bots?**
Use separate profiles and IPs.

---

## Contributing

Currently single-maintainer.
PRs and issues are welcome.

---

## License & Disclaimer

**License:** Proprietary
**Disclaimer:** Use at your own risk. This may violate TLScontact terms.

---

Built May 2026.

```
