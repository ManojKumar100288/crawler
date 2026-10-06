// Core BFS crawler engine: orchestrates login, page inspection, and link discovery.
import { chromium } from 'playwright';
import { normalizeUrl, isInScope, isIgnored } from './urls.js';
import { login } from './auth.js';
import { inspectPage, checkLinkStatus } from './checks.js';
import { collectSitemapUrls } from './sitemap.js';
import { generateAiSummary } from './ai-summary.js';

/**
 * Run a full crawl + QA pass.
 * @param {object} cfg normalized config
 * @param {(msg: string) => void} log logger
 * @returns {Promise<object>} aggregated report data
 */
export async function crawl(cfg, log = console.log) {
  const startedAt = new Date();
  const browser = await chromium.launch({ headless: cfg.headless });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  context.setDefaultTimeout(cfg.navTimeoutMs);

  const report = {
    baseUrl: cfg.baseUrl,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    auth: { attempted: false, ok: false, message: 'not attempted' },
    pages: [],
    externalLinks: [],
    summary: {},
  };

  // 1. Optional login.
  if (cfg.login?.enabled) {
    report.auth.attempted = true;
    const res = await login(context, cfg, log);
    report.auth.ok = res.ok;
    report.auth.message = res.message;
    log(`[auth] ${res.message}`);
    if (!res.ok) {
      log('[auth] WARNING: continuing without authenticated session; post-login pages may be inaccessible.');
    }
  }

  // Special mode: only the home page, but check ALL its links
  // (header + footer + body/main).
  if (cfg.scanMode === 'homeAllLinks' || cfg.scanMode === 'headerFooterHome') {
    await runHomeAllLinks(context, cfg, report, log);
    await context.close();
    await browser.close();
    const finishedAtHF = new Date();
    report.finishedAt = finishedAtHF.toISOString();
    report.durationMs = finishedAtHF - startedAt;
    report.summary = summarize(report);
    report.aiSummary = await generateAiSummary(report, cfg, log);
    return report;
  }

  // 2. BFS crawl.
  const start = normalizeUrl(cfg.baseUrl, cfg.baseUrl);
  const queue = [{ url: start, depth: 0 }];
  const enqueued = new Set([start]);
  const visited = new Set();
  const externalToCheck = new Set();

  // 2a. Seed from sitemap(s) so orphan / unlinked pages are also covered.
  report.sitemap = { used: false, sitemapsChecked: [], urlsFound: 0, urlsSeeded: 0 };
  if (cfg.useSitemap) {
    log('[sitemap] discovering sitemap URLs…');
    try {
      const { urls, sitemapsChecked } = await collectSitemapUrls(context, cfg, log);
      report.sitemap.used = true;
      report.sitemap.sitemapsChecked = sitemapsChecked;
      report.sitemap.urlsFound = urls.length;
      let seeded = 0;
      for (const u of urls) {
        if (
          !enqueued.has(u) &&
          isInScope(u, cfg) &&
          !isIgnored(u, cfg) &&
          enqueued.size < cfg.maxPages
        ) {
          enqueued.add(u);
          // depth 1: sitemap URLs are treated as direct entry points.
          queue.push({ url: u, depth: 1 });
          seeded++;
        }
      }
      report.sitemap.urlsSeeded = seeded;
      log(`[sitemap] seeded ${seeded} in-scope URLs from sitemap (found ${urls.length} total)`);
    } catch (err) {
      log(`[sitemap] skipped (error: ${err.message})`);
    }
  }

  async function processOne(item) {
    if (visited.has(item.url)) return;
    visited.add(item.url);
    log(`[crawl] (${visited.size}/${cfg.maxPages}) depth=${item.depth} ${item.url}`);

    const pageResult = await inspectPage(context, item.url, cfg);
    pageResult.depth = item.depth;
    report.pages.push(pageResult);

    if (item.depth >= cfg.maxDepth) return;

    for (const link of pageResult.links) {
      if (link.type === 'external') {
        if (cfg.checkExternalLinks) externalToCheck.add(link.url);
        continue;
      }
      if (
        !enqueued.has(link.url) &&
        isInScope(link.url, cfg) &&
        !isIgnored(link.url, cfg) &&
        enqueued.size < cfg.maxPages
      ) {
        enqueued.add(link.url);
        queue.push({ url: link.url, depth: item.depth + 1 });
      }
    }
  }

  // Process queue with bounded concurrency.
  while (queue.length > 0 && visited.size < cfg.maxPages) {
    const batch = [];
    while (queue.length > 0 && batch.length < cfg.concurrency && visited.size + batch.length < cfg.maxPages) {
      batch.push(queue.shift());
    }
    await Promise.all(batch.map((item) => processOne(item)));
  }

  // 3. External link checks (reachability).
  if (cfg.checkExternalLinks && externalToCheck.size > 0) {
    log(`[links] checking ${externalToCheck.size} external links`);
    const ext = [...externalToCheck];
    for (let i = 0; i < ext.length; i += cfg.concurrency) {
      const slice = ext.slice(i, i + cfg.concurrency);
      const results = await Promise.all(slice.map((u) => checkLinkStatus(context, u, cfg)));
      report.externalLinks.push(...results);
    }
  }

  await context.close();
  await browser.close();

  // 4. Summarize.
  const finishedAt = new Date();
  report.finishedAt = finishedAt.toISOString();
  report.durationMs = finishedAt - startedAt;
  report.summary = summarize(report);
  report.aiSummary = await generateAiSummary(report, cfg, log);

  return report;
}

/**
 * Home-page mode: inspect only the home page, then check EVERY link found on it
 * — header, footer, and body/main — for reachability. No further crawling.
 */
async function runHomeAllLinks(context, cfg, report, log) {
  const home = normalizeUrl(cfg.baseUrl, cfg.baseUrl);
  log(`[home] inspecting home page: ${home}`);
  const homeResult = await inspectPage(context, home, cfg);
  homeResult.depth = 0;
  report.pages.push(homeResult);

  // All links on the home page, tagged by region (header / footer / main).
  const allLinks = homeResult.links;
  const byRegion = { header: 0, footer: 0, main: 0 };
  for (const l of allLinks) byRegion[l.region] = (byRegion[l.region] || 0) + 1;
  log(`[home] found ${allLinks.length} links total — header:${byRegion.header} footer:${byRegion.footer} body:${byRegion.main}`);

  report.homeLinks = {
    total: allLinks.length,
    header: byRegion.header,
    footer: byRegion.footer,
    body: byRegion.main,
    checked: [],
  };

  // Check each link's reachability (status code), internal + external alike.
  for (let i = 0; i < allLinks.length; i += cfg.concurrency) {
    const slice = allLinks.slice(i, i + cfg.concurrency);
    const results = await Promise.all(
      slice.map(async (l) => {
        const status = await checkLinkStatus(context, l.url, cfg);
        return { ...l, status: status.status, ok: status.ok, blocked: status.blocked, error: status.error };
      })
    );
    for (const r of results) {
      report.homeLinks.checked.push(r);
      const regionLabel = r.region === 'main' ? 'BODY' : r.region.toUpperCase();
      const bodyRegion = r.region === 'main' ? 'body' : r.region;
      if (r.ok) {
        log(`[link] ✅ ${regionLabel} ${r.status} ${r.url}`);
      } else if (r.blocked) {
        // Server blocked the automated request (403/401/429). The link most
        // likely works in a real browser — flag as info, not an error.
        log(`[link] 🔒 ${regionLabel} ${r.status} (blocked by site, likely OK in browser) ${r.url}`);
        homeResult.issues.push({
          severity: 'info',
          type: 'blocked-link',
          message: `Likely OK — this ${regionLabel.toLowerCase()} link returned HTTP ${r.status} to the automated checker because the site blocks bots. It usually works in a normal browser. Please open it manually to confirm: ${r.url}${r.text ? ' [' + r.text + ']' : ''}`,
        });
      } else {
        log(`[link] ❌ ${regionLabel} ${r.status ?? 'FAIL'} ${r.url}`);
        homeResult.issues.push({
          severity: 'error',
          type: `broken-${bodyRegion}-link`,
          message: `Broken ${regionLabel.toLowerCase()} link (${r.status ?? r.error}): ${r.url}${r.text ? ' [' + r.text + ']' : ''}`,
        });
      }
    }
  }

  // Feed external results into the summary. "blocked" links count as ok=true so
  // they are NOT reported as broken (they work in a real browser).
  report.externalLinks = report.homeLinks.checked
    .filter((r) => r.type === 'external')
    .map((r) => ({ url: r.url, status: r.status, ok: r.ok || r.blocked, blocked: r.blocked, error: r.error }));
}

function summarize(report) {
  let errorPages = 0;
  let warnPages = 0;
  let totalIssues = 0;
  const byType = {};
  let brokenExternal = 0;

  for (const p of report.pages) {
    const hasError = p.issues.some((i) => i.severity === 'error');
    const hasWarn = p.issues.some((i) => i.severity === 'warning');
    if (hasError) errorPages++;
    else if (hasWarn) warnPages++;
    for (const issue of p.issues) {
      totalIssues++;
      byType[issue.type] = (byType[issue.type] || 0) + 1;
    }
  }
  for (const l of report.externalLinks) {
    if (!l.ok) brokenExternal++;
  }

  // Count blocked (bot-protected) links across home-links checks.
  let blockedLinks = 0;
  if (report.homeLinks) {
    blockedLinks = report.homeLinks.checked.filter((r) => r.blocked).length;
  }

  return {
    pagesCrawled: report.pages.length,
    pagesWithErrors: errorPages,
    pagesWithWarnings: warnPages,
    cleanPages: report.pages.length - errorPages - warnPages,
    totalIssues,
    issuesByType: byType,
    externalLinksChecked: report.externalLinks.length,
    brokenExternalLinks: brokenExternal,
    sitemapUsed: report.sitemap ? report.sitemap.used : false,
    sitemapUrlsFound: report.sitemap ? report.sitemap.urlsFound : 0,
    homeLinksTotal: report.homeLinks ? report.homeLinks.total : 0,
    homeHeaderLinks: report.homeLinks ? report.homeLinks.header : 0,
    homeFooterLinks: report.homeLinks ? report.homeLinks.footer : 0,
    homeBodyLinks: report.homeLinks ? report.homeLinks.body : 0,
    blockedLinks,
  };
}
