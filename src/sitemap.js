// Sitemap discovery + parsing, so the crawler can find ALL URLs (including
// pages that aren't linked from anywhere / orphan pages).
//
// Strategy:
//   1. Look at /robots.txt for "Sitemap:" lines.
//   2. Try common sitemap locations (/sitemap.xml, /sitemap_index.xml).
//   3. Parse each sitemap; if it's a <sitemapindex>, follow nested sitemaps.
//   4. Return the de-duplicated list of <loc> URLs.
//
// Uses the browser context's request API so it shares cookies/session (works
// for authenticated sitemaps too).

import { normalizeUrl } from './urls.js';

const COMMON_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];

// Extract all <loc>…</loc> values from an XML string.
function extractLocs(xml) {
  const locs = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    locs.push(m[1].trim());
  }
  return locs;
}

function looksLikeSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

async function fetchText(context, url, cfg) {
  try {
    const res = await context.request.get(url, { timeout: cfg.navTimeoutMs, maxRedirects: 5 });
    if (!res.ok()) return null;
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    // Accept xml or text; some servers mislabel sitemaps.
    const body = await res.text();
    if (!body) return null;
    // Quick sanity: must look like XML for a sitemap.
    if (!/<(urlset|sitemapindex|loc)[\s>]/i.test(body) && !ct.includes('xml')) return null;
    return body;
  } catch {
    return null;
  }
}

async function sitemapUrlsFromRobots(context, cfg) {
  const robotsUrl = new URL('/robots.txt', cfg.origin).toString();
  try {
    const res = await context.request.get(robotsUrl, { timeout: cfg.navTimeoutMs, maxRedirects: 5 });
    if (!res.ok()) return [];
    const body = await res.text();
    const out = [];
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (m) out.push(m[1].trim());
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Discover and collect all URLs from the site's sitemap(s).
 * @returns {Promise<{urls: string[], sitemapsChecked: string[]}>}
 */
export async function collectSitemapUrls(context, cfg, log = () => {}) {
  const sitemapQueue = [];
  const seenSitemaps = new Set();
  const urls = new Set();

  // Seed from robots.txt + common paths.
  const fromRobots = await sitemapUrlsFromRobots(context, cfg);
  for (const s of fromRobots) sitemapQueue.push(s);
  for (const p of COMMON_PATHS) sitemapQueue.push(new URL(p, cfg.origin).toString());

  let guard = 0;
  const MAX_SITEMAPS = 200; // safety cap for huge nested sitemap indexes

  while (sitemapQueue.length > 0 && guard < MAX_SITEMAPS) {
    const smUrl = sitemapQueue.shift();
    const norm = normalizeUrl(smUrl, cfg.origin);
    if (!norm || seenSitemaps.has(norm)) continue;
    seenSitemaps.add(norm);
    guard++;

    const xml = await fetchText(context, norm, cfg);
    if (!xml) continue;

    const locs = extractLocs(xml);
    if (looksLikeSitemapIndex(xml)) {
      // Nested sitemaps -> queue them.
      log(`[sitemap] index found: ${norm} (${locs.length} child sitemaps)`);
      for (const child of locs) sitemapQueue.push(child);
    } else {
      log(`[sitemap] ${norm} -> ${locs.length} urls`);
      for (const u of locs) {
        const n = normalizeUrl(u, cfg.origin);
        if (n) urls.add(n);
      }
    }
  }

  return { urls: [...urls], sitemapsChecked: [...seenSitemaps] };
}
