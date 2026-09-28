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
  // Each link is tagged with the page region it came from: header / footer / main.
  try {
    const rawLinks = await page.$$eval('a[href]', (as) =>
      as.map((a) => {
        // Walk up the DOM to find the nearest structural region.
        let region = 'main';
        let el = a;
        while (el && el !== document.body) {
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          const role = (el.getAttribute && el.getAttribute('role')) || '';
          const cls = (el.className && typeof el.className === 'string' ? el.className : '').toLowerCase();
          const id = (el.id || '').toLowerCase();
          if (tag === 'header' || role === 'banner' || /(^|[^a-z])header([^a-z]|$)|navbar|site-head|top-nav/.test(cls + ' ' + id)) {
            region = 'header';
            break;
          }
          if (tag === 'footer' || role === 'contentinfo' || /(^|[^a-z])footer([^a-z]|$)|site-foot|bottom-nav/.test(cls + ' ' + id)) {
            region = 'footer';
            break;
          }
          el = el.parentElement;
        }
        return { href: a.getAttribute('href'), region, text: (a.textContent || '').trim().slice(0, 80) };
      })
    );
    const seen = new Set();
    for (const raw of rawLinks) {
      const abs = normalizeUrl(raw.href, url);
      if (!abs || seen.has(abs)) continue;
      if (isIgnored(abs, cfg)) continue;
      seen.add(abs);
      result.links.push({ url: abs, type: classifyLink(abs, cfg), region: raw.region, text: raw.text });
    }
  } catch {
    /* ignore */
  }

  await page.close().catch(() => {});
  return result;
}

// Browser-like headers so bot-protected sites (social media, gov portals) don't
// reject our reachability checks with 403/400 for a link that actually works.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Status codes that mean "the server blocked our automated request", NOT that the
// link is broken. These are treated as "blocked/protected", not errors.
const BLOCKED_STATUSES = new Set([401, 403, 405, 429]);

// Domains known to aggressively block bots (they return odd codes like 400/999
// to automated requests, but work fine in a real browser). Any non-2xx from
// these is treated as "blocked", not broken.
const BOT_HOSTILE_HOSTS = [
  'facebook.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'linkedin.com',
  'threads.net',
];

function isBotHostileHost(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return BOT_HOSTILE_HOSTS.some((d) => h === d || h.endsWith('.' + d));
  } catch {
    return false;
  }
}

/**
 * Check a link's reachability. Returns:
 *   { url, status, ok, blocked, error }
 * - ok: true if status < 400 (link works)
 * - blocked: true if the server rejected the automated request (401/403/429/…)
 *   — the link is likely fine in a real browser, so we don't count it as broken.
 */
export async function checkLinkStatus(context, url, cfg) {
  try {
    const res = await context.request.get(url, {
      timeout: cfg.navTimeoutMs,
      maxRedirects: 5,
      headers: BROWSER_HEADERS,
    });
    const status = res.status();
    if (res.ok()) return { url, status, ok: true, blocked: false };
    if (BLOCKED_STATUSES.has(status) || isBotHostileHost(url)) {
      // Server actively blocked the bot — not a broken link.
      return { url, status, ok: false, blocked: true };
    }
    return { url, status, ok: false, blocked: false };
  } catch (err) {
    return { url, status: null, ok: false, blocked: false, error: err.message };
  }
}

// Old signature kept for the full-crawl external-link path.
export async function _legacyCheckLinkStatus(context, url, cfg) {
  try {
    const res = await context.request.get(url, { timeout: cfg.navTimeoutMs, maxRedirects: 5 });
    return { url, status: res.status(), ok: res.ok() };
  } catch (err) {
    return { url, status: null, ok: false, error: err.message };
  }
}
