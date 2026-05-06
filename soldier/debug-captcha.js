#!/usr/bin/env node
// debug-captcha.js — Run this while on the TLS appointment page
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];

  console.log('URL:', page.url());
  console.log('Title:', await page.title());
  console.log('');

  const selectors = [
    'iframe[src*="hcaptcha"]',
    'iframe[src*="recaptcha"]',
    '[class*="captcha"]',
    '[class*="h-captcha"]',
    '[class*="g-recaptcha"]',
    '#challenge-form',
    '#challenge-stage',
    'input[name="cf-turnstile-response"]',
  ];

  console.log('=== ELEMENT CHECKS ===');
  for (const sel of selectors) {
    const count = await page.locator(sel).count();
    if (count > 0) {
      const el = page.locator(sel).first();
      const visible = await el.isVisible().catch(() => false);
      const box = await el.boundingBox().catch(() => null);
      const html = await el.evaluate(e => e.outerHTML.substring(0, 200)).catch(() => 'error');
      console.log(`MATCH: ${sel}`);
      console.log(`  count=${count} visible=${visible} size=${box ? box.width + 'x' + box.height : 'none'}`);
      console.log(`  html: ${html}`);
    }
  }

  console.log('');
  console.log('=== TEXT CHECKS ===');
  const text = await page.evaluate(() => document.body?.innerText || '');
  const lines = text.split('\n').filter(l => /captcha|challenge|verify|human|security check/i.test(l));
  lines.forEach(l => console.log('  -', l.trim().substring(0, 120)));

  console.log('');
  console.log('=== COOKIES ===');
  const cookies = await ctx.cookies();
  cookies.forEach(c => console.log(`  ${c.name}: ${c.value.substring(0, 40)} (domain: ${c.domain})`));

  await browser.close();
})();