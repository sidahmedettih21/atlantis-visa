// dump-month-selector.js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('tlscontact')) || ctx.pages()[0];

  const result = await page.evaluate(() => {
    // Get the full month selector HTML
    const container = document.querySelector('[class*="MonthSelector"]');
    if (!container) return { error: 'MonthSelector not found', bodySnippet: document.body.innerHTML.slice(0, 2000) };

    const buttons = [...container.querySelectorAll('button, [role="tab"], [class*="button"], [class*="tab"]')];
    return {
      containerHTML: container.outerHTML,
      buttons: buttons.map(b => ({
        text: b.textContent.trim(),
        classes: b.className,
        disabled: b.disabled,
        ariaSelected: b.getAttribute('aria-selected'),
        ariaDisabled: b.getAttribute('aria-disabled'),
      }))
    };
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();