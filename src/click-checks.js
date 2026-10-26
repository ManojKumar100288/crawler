// Click-mode checking.
//
// Instead of only reading each anchor's href and requesting the URL, this module
// PHYSICALLY CLICKS each clickable element (anchor, button, role=button) in a
// real browser and records what happened:
//   - navigated      : the click took us to a new URL (success)
//   - new-tab        : the click opened a new tab/window
//   - same-page      : URL didn't change (in-page action / JS handler / anchor)
//   - js-error       : the click triggered a JavaScript error
//   - click-failed   : the element could not be clicked (hidden/blocked/detached)
//
// This catches click-based / JavaScript navigation that a plain href check misses
// (e.g. <a href="#" onclick=...>, buttons, SPA router links).

/**
 * Click every clickable element on a page and record the outcome of each.
 * @param {import('playwright').BrowserContext} context
 * @param {string} url - the page to test
 * @param {object} cfg
 * @param {(msg:string)=>void} log
 * @returns {Promise<{url, clickable, results, issues}>}
 */
export async function clickCheckPage(context, url, cfg, log = () => {}) {
  const page = await context.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e.message || e).slice(0, 200)));

  const result = { url, clickable: 0, results: [], issues: [] };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: cfg.navTimeoutMs }).catch(() => {});
  } catch (err) {
    result.issues.push({ severity: 'error', type: 'navigation', message: `Failed to load page for click check: ${err.message}` });
    await page.close().catch(() => {});
    return result;
  }

  // Dismiss any overlay/popup/modal that would intercept clicks (podcast promo,
  // cookie banner, ad, etc.). Without this, every click times out because the
  // overlay sits on top of the page.
  await dismissOverlays(page, log).catch(() => {});

  // Reveal hover/click dropdown menus so their sub-links are also captured
  // (nav menus like "Quiz & Challenges ⌄" only show children after hover).
  await revealMenus(page).catch(() => {});

  // Everything below is wrapped so a closed/navigated page can never crash the
  // whole crawl — any failure just ends the click-check for this page cleanly.
  try {
    // Build a stable list of clickable descriptors we can re-find after each
    // navigation (clicking may navigate away, so we re-locate by index each time).
    const descriptors = await collectClickables(page, cfg);
    result.clickable = descriptors.length;
    log(`[click] ${url} -> ${descriptors.length} clickable element(s) to test`);

    const startUrl = page.url();

    for (let i = 0; i < descriptors.length && i < (cfg.maxClicksPerPage || 60); i++) {
      // Stop if the page/context got closed for any reason.
      if (page.isClosed()) break;

      const d = descriptors[i];
      const jsErrBefore = jsErrors.length;

      // Make sure we're back on the start page before each click.
      try {
        if (page.url() !== startUrl) {
          await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs }).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        }
      } catch {
        break; // page gone — stop cleanly
      }

      let outcome;
      try {
        outcome = await clickOne(page, context, d, cfg);
      } catch (err) {
        // A single click blew up (often a navigation/closed page) — record and continue.
        outcome = { selector: `${d.tag}#${d.index}`, text: d.text, href: d.href, status: 'click-failed', detail: String(err.message || err).split('\n')[0].slice(0, 120) };
      }

      // Attribute any JS error that fired during this click.
      if (jsErrors.length > jsErrBefore) {
        outcome.status = outcome.status === 'click-failed' ? outcome.status : 'js-error';
        outcome.detail = (outcome.detail ? outcome.detail + '; ' : '') + jsErrors.slice(jsErrBefore).join(' | ');
      }

      result.results.push(outcome);

      // Record issues for problematic outcomes.
      if (outcome.status === 'js-error') {
        result.issues.push({
          severity: 'error',
          type: 'click-js-error',
          message: `Clicking "${outcome.text || outcome.selector}" caused a JavaScript error: ${outcome.detail}`,
        });
      } else if (outcome.status === 'click-failed') {
        result.issues.push({
          severity: 'warning',
          type: 'click-failed',
          message: `Could not click "${outcome.text || outcome.selector}": ${outcome.detail}`,
        });
      } else if (outcome.status === 'dead') {
        result.issues.push({
          severity: 'warning',
          type: 'dead-click',
          message: `Clicking "${outcome.text || outcome.selector}" did nothing (no navigation, no new tab, no visible change) — possible broken button/link`,
        });
      }
    }
  } catch (err) {
    // Click-check failed for this page, but the crawl must continue.
    log(`[click] ${url} -> click check stopped: ${String(err.message || err).split('\n')[0]}`);
  }

  const nav = result.results.filter((r) => r.status === 'navigated').length;
  const newTab = result.results.filter((r) => r.status === 'new-tab').length;
  const dead = result.results.filter((r) => r.status === 'dead').length;
  const jsErr = result.results.filter((r) => r.status === 'js-error').length;
  const failed = result.results.filter((r) => r.status === 'click-failed').length;
  log(`[click] ${url} -> navigated:${nav} new-tab:${newTab} same-page:${result.results.filter(r=>r.status==='same-page').length} dead:${dead} js-error:${jsErr} failed:${failed}`);

  await page.close().catch(() => {});
  return result;
}

// The CSS selector covering all clickable element TYPES we test.
// Includes: anchors, buttons, ARIA buttons/links/menuitems/tabs, onclick elements,
// and common interactive roles. Plus (in JS below) any element with cursor:pointer.
const CLICKABLE_SELECTOR =
  'a, button, [role=button], [role=link], [role=menuitem], [role=tab], [onclick], input[type=button], input[type=submit], summary, label[for]';

// The FULL element set we scan (indexes are computed against this exact set, so
// clickOne must re-locate using the same selector to stay in sync).
const SCAN_SELECTOR = CLICKABLE_SELECTOR + ', div, span, li, img';

// Close/dismiss blocking overlays & modal popups so clicks aren't intercepted.
async function dismissOverlays(page, log) {
  const closeSelectors = [
    '.modal.show button.close',
    '.modal.show [data-dismiss=modal]',
    '.modal.show [data-bs-dismiss=modal]',
    '[class*=modal][class*=show] button[aria-label=Close i]',
    'button[aria-label=Close i]',
    'button.close',
    '.close-button',
    '[class*=popup] [class*=close]',
    '[class*=modal] [class*=close]',
    '[id*=popup] [class*=close]',
  ];
  let closed = 0;
  for (const sel of closeSelectors) {
    try {
      const els = page.locator(sel);
      const n = await els.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = els.nth(i);
        if (await el.isVisible({ timeout: 200 }).catch(() => false)) {
          await el.click({ force: true, timeout: 1500 }).catch(() => {});
          closed++;
        }
      }
    } catch { /* ignore */ }
  }
  // Press Escape a couple of times to close any remaining modal.
  await page.keyboard.press('Escape').catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  // Remove leftover full-screen overlay/backdrop elements that still intercept clicks.
  await page.evaluate(() => {
    const kill = (el) => { try { el.remove(); } catch {} };
    document.querySelectorAll('.modal-backdrop, .modal.show, [class*=overlay], [class*=backdrop]').forEach((el) => {
      const s = getComputedStyle(el);
      // Only remove elements that actually cover the viewport.
      const r = el.getBoundingClientRect();
      if ((s.position === 'fixed' || s.position === 'absolute') && r.width > window.innerWidth * 0.6 && r.height > window.innerHeight * 0.6) {
        kill(el);
      }
    });
    // Restore scroll in case a modal locked the body.
    document.body.style.overflow = '';
  }).catch(() => {});
  if (closed > 0 && log) log(`[click] dismissed ${closed} overlay/popup element(s) before clicking`);
}

// Hover over (and briefly focus) likely dropdown-menu parents so their hidden
// sub-menu links become visible and get included in the clickable list.
async function revealMenus(page) {
  const menuParents = page.locator(
    'nav [aria-haspopup], nav .dropdown, nav .has-submenu, [class*=dropdown] > a, [class*=menu-item-has-children] > a, li:has(ul) > a'
  );
  const n = Math.min(await menuParents.count().catch(() => 0), 20);
  for (let i = 0; i < n; i++) {
    const p = menuParents.nth(i);
    if (await p.isVisible({ timeout: 200 }).catch(() => false)) {
      await p.hover({ timeout: 800 }).catch(() => {});
      await page.waitForTimeout(150);
    }
  }
}

// Collect clickable element descriptors with enough info to re-find & report them.
async function collectClickables(page, cfg) {
  return page.$$eval(
    SCAN_SELECTOR,
    (els, args) => {
      const { ignorePatternsStr, selector } = args;
      const ignoreRes = JSON.parse(ignorePatternsStr).map((p) => new RegExp(p, 'i'));
      const out = [];
      let idx = 0;
      for (const el of els) {
        idx++;
        const tag = el.tagName.toLowerCase();
        const href = el.getAttribute && el.getAttribute('href');
        const text = (el.textContent || '').trim().slice(0, 60);

        // Decide whether this element is actually "clickable".
        // 1. It matches a known clickable selector (a/button/role/onclick/etc.), OR
        // 2. It is a div/span/li/img that visually behaves as clickable
        //    (cursor:pointer) and has a click-ish listener hint.
        const isKnown = el.matches(selector);
        let isPointer = false;
        if (!isKnown) {
          const style = window.getComputedStyle(el);
          // cursor:pointer is the strongest generic signal of a clickable element.
          if (style.cursor === 'pointer') isPointer = true;
          // Skip plain divs/spans that merely contain other clickables (avoid noise):
          if (isPointer) {
            const hasClickableChild = el.querySelector('a, button, [role=button], [onclick]');
            if (hasClickableChild) isPointer = false;
          }
        }
        if (!isKnown && !isPointer) continue;

        // Skip anchors whose href matches the ignore list (assets, logout, etc.).
        if (href && ignoreRes.some((re) => re.test(href))) continue;

        // Skip invisible elements.
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        if (!visible) continue;

        out.push({
          index: idx - 1,
          tag,
          href: href || null,
          text,
          kind: isKnown ? 'standard' : 'pointer',
        });
      }
      return out;
    },
    { ignorePatternsStr: JSON.stringify(cfg.ignorePatterns || []), selector: CLICKABLE_SELECTOR }
  );
}

// Click a single element (located fresh by its index) and classify the outcome.
async function clickOne(page, context, d, cfg) {
  const base = { selector: `${d.tag}#${d.index}`, text: d.text, href: d.href, status: 'same-page', detail: '' };

  // Re-locate the element by index among the SAME element set used to collect it.
  const locator = page.locator(SCAN_SELECTOR).nth(d.index);
  if (!(await locator.count().catch(() => 0))) {
    return { ...base, status: 'click-failed', detail: 'element no longer present' };
  }
  if (!(await locator.isVisible({ timeout: 800 }).catch(() => false))) {
    return { ...base, status: 'click-failed', detail: 'element not visible' };
  }

  const urlBefore = page.url();
  let newPage = null;

  // Bring the element into view so it can be clicked.
  await locator.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});

  // Listen for a possible new tab opened by the click.
  const popupPromise = context
    .waitForEvent('page', { timeout: 2500 })
    .then((p) => { newPage = p; return p; })
    .catch(() => null);

  // Try a normal click first; if it times out (e.g. an overlay intercepts it),
  // dismiss overlays and retry with a forced click so we don't falsely report
  // "click-failed".
  let clickErr = null;
  try {
    await locator.click({ timeout: 3000 });
  } catch {
    await dismissOverlays(page, null).catch(() => {});
    try {
      await locator.click({ force: true, timeout: 2500 });
    } catch (err2) {
      clickErr = err2;
    }
  }
  if (clickErr) {
    await popupPromise.catch(() => {});
    if (newPage) { await newPage.close().catch(() => {}); return { ...base, status: 'new-tab', detail: 'opened new tab' }; }
    return { ...base, status: 'click-failed', detail: clickErr.message.split('\n')[0].slice(0, 120) };
  }

  // Give the click a moment to cause navigation / a new tab / DOM change.
  await page.waitForTimeout(600);
  await popupPromise.catch(() => {});

  if (newPage) {
    const nu = newPage.url();
    await newPage.close().catch(() => {});
    return { ...base, status: 'new-tab', detail: `opened new tab: ${nu}` };
  }

  const urlAfter = page.url();
  if (urlAfter !== urlBefore) {
    return { ...base, status: 'navigated', detail: `-> ${urlAfter}` };
  }

  // URL didn't change. If it's a real link with a non-hash href, that's a "dead"
  // click (nothing happened though a destination was expected). Pure "#" or
  // button actions are treated as same-page (likely intended JS behavior).
  const isRealHref = d.href && !/^#/.test(d.href) && !/^javascript:/i.test(d.href);
  if (isRealHref) {
    return { ...base, status: 'dead', detail: `href="${d.href}" but click caused no navigation` };
  }
  return { ...base, status: 'same-page', detail: 'in-page action (no URL change)' };
}
