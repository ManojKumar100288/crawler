// Per-page QA checks: load a page, capture errors, and run health checks.
import { normalizeUrl, classifyLink, isIgnored } from './urls.js';

/**
 * Visit one page and run all QA checks.
 * Returns a rich result object with status, timings, issues, and discovered links.
 */
export async function inspectPage(context, url, cfg) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text().slice(0, 500));
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(String(err.message || err).slice(0, 500));
  });
  page.on('requestfailed', (req) => {
    const failure = req.failure();
    // Ignore intentional aborts (common for analytics/ads).
    if (failure && /aborted/i.test(failure.errorText)) return;
    failedRequests.push({
      url: req.url().slice(0, 300),
      method: req.method(),
      error: failure ? failure.errorText : 'unknown',
    });
  });

  const result = {
    url,
    status: null,
    ok: false,
    loadMs: null,
    title: null,
    issues: [],
    links: [],
    consoleErrors,
    pageErrors,
    failedRequests,
  };

  const started = Date.now();
  let response;
  try {
    response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: cfg.navTimeoutMs,
    });
    await page.waitForLoadState('networkidle', { timeout: cfg.navTimeoutMs }).catch(() => {});
  } catch (err) {
    result.loadMs = Date.now() - started;
    result.issues.push({ severity: 'error', type: 'navigation', message: `Failed to load: ${err.message}` });
    await page.close().catch(() => {});
    return result;
  }

  result.loadMs = Date.now() - started;

  // HTTP status.
  if (response) {
    result.status = response.status();
    result.ok = response.ok();
    if (result.status >= 400) {
      result.issues.push({
        severity: 'error',
        type: 'http',
        message: `HTTP ${result.status} returned for page`,
      });
    } else if (result.status >= 300) {
      result.issues.push({
        severity: 'info',
        type: 'redirect',
        message: `HTTP ${result.status} redirect`,
      });
    }
  }

  // Title check.
  try {
    result.title = (await page.title())?.trim() || '';
    if (!result.title) {
      result.issues.push({ severity: 'warning', type: 'seo', message: 'Missing or empty <title>' });
    }
  } catch {
    /* ignore */
  }

  // Slow load check.
  if (result.loadMs > cfg.slowPageMs) {
    result.issues.push({
      severity: 'warning',
      type: 'performance',
      message: `Slow page load: ${result.loadMs}ms (threshold ${cfg.slowPageMs}ms)`,
    });
  }

  // Console + JS errors -> issues.
  for (const e of consoleErrors) {
    result.issues.push({ severity: 'warning', type: 'console', message: e });
  }
  for (const e of pageErrors) {
    result.issues.push({ severity: 'error', type: 'js-exception', message: e });
  }
  for (const fr of failedRequests) {
    result.issues.push({
      severity: 'warning',
      type: 'failed-request',
      message: `${fr.method} ${fr.url} -> ${fr.error}`,
    });
  }

  // Broken images.
  try {
    const brokenImages = await page.$$eval('img', (imgs) =>
      imgs
        .filter((img) => img.complete && img.naturalWidth === 0 && img.getAttribute('src'))
        .map((img) => img.currentSrc || img.src)
        .slice(0, 50)
    );
    for (const src of brokenImages) {
      result.issues.push({ severity: 'warning', type: 'broken-image', message: `Broken image: ${src}` });
    }
  } catch {
    /* ignore */
  }

  // Collect links (for crawling + broken-link checks).
  try {
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
    const seen = new Set();
    for (const href of hrefs) {
      const abs = normalizeUrl(href, url);
      if (!abs || seen.has(abs)) continue;
      if (isIgnored(abs, cfg)) continue;
      seen.add(abs);
      result.links.push({ url: abs, type: classifyLink(abs, cfg) });
    }
  } catch {
    /* ignore */
  }

  await page.close().catch(() => {});
  return result;
}

/**
 * Lightweight HEAD/GET check for a link's reachability (used for external + broken-link checks).
 * Uses the browser context's request API so cookies/session are shared.
 */
export async function checkLinkStatus(context, url, cfg) {
  try {
    const res = await context.request.get(url, { timeout: cfg.navTimeoutMs, maxRedirects: 5 });
    return { url, status: res.status(), ok: res.ok() };
  } catch (err) {
    return { url, status: null, ok: false, error: err.message };
  }
}
