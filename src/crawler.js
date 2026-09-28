// Core BFS crawler engine: orchestrates login, page inspection, and link discovery.
import { chromium } from 'playwright';
import { normalizeUrl, isInScope, isIgnored } from './urls.js';
import { login } from './auth.js';
import { inspectPage, checkLinkStatus } from './checks.js';

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

  // 2. BFS crawl.
  const start = normalizeUrl(cfg.baseUrl, cfg.baseUrl);
  const queue = [{ url: start, depth: 0 }];
  const enqueued = new Set([start]);
  const visited = new Set();
  const externalToCheck = new Set();

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

  return report;
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

  return {
    pagesCrawled: report.pages.length,
    pagesWithErrors: errorPages,
    pagesWithWarnings: warnPages,
    cleanPages: report.pages.length - errorPages - warnPages,
    totalIssues,
    issuesByType: byType,
    externalLinksChecked: report.externalLinks.length,
    brokenExternalLinks: brokenExternal,
  };
}
