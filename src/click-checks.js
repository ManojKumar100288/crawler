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

  // Build a stable list of clickable descriptors we can re-find after each
  // navigation (clicking may navigate away, so we re-locate by index each time).
  const descriptors = await collectClickables(page, cfg);
  result.clickable = descriptors.length;
  log(`[click] ${url} -> ${descriptors.length} clickable element(s) to test`);

  const startUrl = page.url();

  for (let i = 0; i < descriptors.length && i < (cfg.maxClicksPerPage || 60); i++) {
    const d = descriptors[i];
    const jsErrBefore = jsErrors.length;

    // Make sure we're back on the start page before each click.
    if (page.url() !== startUrl) {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    const outcome = await clickOne(page, context, d, cfg);

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

  const nav = result.results.filter((r) => r.status === 'navigated').length;
  const newTab = result.results.filter((r) => r.status === 'new-tab').length;
  const dead = result.results.filter((r) => r.status === 'dead').length;
  const jsErr = result.results.filter((r) => r.status === 'js-error').length;
  const failed = result.results.filter((r) => r.status === 'click-failed').length;
  log(`[click] ${url} -> navigated:${nav} new-tab:${newTab} same-page:${result.results.filter(r=>r.status==='same-page').length} dead:${dead} js-error:${jsErr} failed:${failed}`);

  await page.close().catch(() => {});
  return result;
}

// Collect clickable element descriptors with enough info to re-find & report them.
async function collectClickables(page, cfg) {
  return page.$$eval(
    'a, button, [role=button], [onclick]',
    (els, ignorePatternsStr) => {
      const ignoreRes = JSON.parse(ignorePatternsStr).map((p) => new RegExp(p, 'i'));
      const out = [];
      let idx = 0;
      for (const el of els) {
        idx++;
        const tag = el.tagName.toLowerCase();
        const href = el.getAttribute && el.getAttribute('href');
        const text = (el.textContent || '').trim().slice(0, 60);
        // Skip obvious non-navigation anchors we intentionally ignore.
        if (href && ignoreRes.some((re) => re.test(href))) continue;
        // Skip elements that are not visible.
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        if (!visible) continue;
        out.push({ index: idx - 1, tag, href: href || null, text });
      }
      return out;
    },
    JSON.stringify(cfg.ignorePatterns || [])
  );
}

// Click a single element (located fresh by its index) and classify the outcome.
async function clickOne(page, context, d, cfg) {
  const base = { selector: `${d.tag}#${d.index}`, text: d.text, href: d.href, status: 'same-page', detail: '' };

  // Re-locate the element by index among the same element set.
  const locator = page.locator('a, button, [role=button], [onclick]').nth(d.index);
  if (!(await locator.count().catch(() => 0))) {
    return { ...base, status: 'click-failed', detail: 'element no longer present' };
  }
  if (!(await locator.isVisible({ timeout: 800 }).catch(() => false))) {
    return { ...base, status: 'click-failed', detail: 'element not visible' };
  }

  const urlBefore = page.url();
  let newPage = null;

  // Listen for a possible new tab opened by the click.
  const popupPromise = context
    .waitForEvent('page', { timeout: 2500 })
    .then((p) => { newPage = p; return p; })
    .catch(() => null);

  try {
    await locator.click({ timeout: 4000 });
  } catch (err) {
    await popupPromise.catch(() => {});
    if (newPage) { await newPage.close().catch(() => {}); return { ...base, status: 'new-tab', detail: 'opened new tab' }; }
    return { ...base, status: 'click-failed', detail: err.message.split('\n')[0].slice(0, 120) };
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
