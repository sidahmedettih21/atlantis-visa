# Atlantis-Visa

1:1 TLScontact appointment booking swarm for Portugal & Belgium.
Uses real Chrome via CDP, zero-headless fraud, residential IP isolation.
Pricing info in MARKET.md.

**Quick start:**
- `npm install`
- copy soldier/config/default.json → soldier/config/clients/client1.json, fill details
- launch Chrome with `--remote-debugging-port=9222`
- `node soldier/bot.js`
