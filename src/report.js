// Report generation: writes JSON + a human-readable HTML QA report.
import fs from 'node:fs';
import path from 'node:path';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

/**
 * Write JSON + HTML reports to disk. Returns { jsonPath, htmlPath }.
 */
export function writeReports(report, cfg) {
  const outDir = path.resolve(cfg.outputDir);
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `qa-report-${stamp}.json`);
  const htmlPath = path.join(outDir, `qa-report-${stamp}.html`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(htmlPath, renderHtml(report, cfg), 'utf8');

  return { jsonPath, htmlPath };
}

function badge(severity) {
  const colors = { error: '#d33', warning: '#e6a100', info: '#0a7', clean: '#2a2' };
  return `<span style="background:${colors[severity] || '#888'};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px">${esc(severity)}</span>`;
}

function renderHtml(report, cfg) {
  const s = report.summary;

  const sortedPages = [...report.pages].sort((a, b) => {
    const aErr = a.issues.some((i) => i.severity === 'error') ? 0 : a.issues.some((i) => i.severity === 'warning') ? 1 : 2;
    const bErr = b.issues.some((i) => i.severity === 'error') ? 0 : b.issues.some((i) => i.severity === 'warning') ? 1 : 2;
    return aErr - bErr;
  });

  const pageRows = sortedPages
    .map((p, idx) => {
      const worst = p.issues.reduce(
        (acc, i) => Math.min(acc, SEVERITY_ORDER[i.severity] ?? 3),
        p.issues.length ? 3 : 4
      );
      const status =
        worst === 0 ? 'error' : worst === 1 ? 'warning' : worst === 2 ? 'info' : 'clean';
      const issuesHtml = p.issues.length
        ? `<ul>${p.issues
            .map((i) => `<li>${badge(i.severity)} <b>${esc(i.type)}</b>: ${esc(i.message)}</li>`)
            .join('')}</ul>`
        : '<em>No issues</em>';
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>${badge(status)}</td>
          <td>${esc(p.status ?? '-')}</td>
          <td>${p.loadMs ?? '-'}ms</td>
          <td style="max-width:420px;word-break:break-all"><a href="${esc(p.url)}" target="_blank">${esc(p.url)}</a><br><small>${esc(p.title || '')}</small></td>
          <td>${issuesHtml}</td>
        </tr>`;
    })
    .join('');

  const brokenExt = report.externalLinks.filter((l) => !l.ok);
  const brokenExtHtml = brokenExt.length
    ? `<table><thead><tr><th>Status</th><th>URL</th><th>Error</th></tr></thead><tbody>${brokenExt
        .map((l) => `<tr><td>${esc(l.status ?? 'FAIL')}</td><td style="word-break:break-all">${esc(l.url)}</td><td>${esc(l.error || '')}</td></tr>`)
        .join('')}</tbody></table>`
    : '<em>No broken external links found.</em>';

  const typeRows = Object.entries(s.issuesByType || {})
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `<tr><td>${esc(t)}</td><td>${c}</td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA Report - ${esc(report.baseUrl)}</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:0;background:#f6f7f9;color:#1a1a1a}
  header{background:#1f2937;color:#fff;padding:20px 28px}
  header h1{margin:0 0 4px;font-size:20px}
  header small{color:#cbd5e1}
  .wrap{padding:20px 28px;max-width:1200px;margin:0 auto}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;min-width:130px}
  .card b{display:block;font-size:26px}
  .card span{color:#6b7280;font-size:13px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;margin:12px 0}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top;font-size:14px}
  th{background:#f3f4f6}
  ul{margin:4px 0;padding-left:18px}
  h2{margin-top:28px}
</style></head>
<body>
<header>
  <h1>Automated QA Report</h1>
  <small>${esc(report.baseUrl)} &middot; ${esc(report.startedAt)} &middot; duration ${(report.durationMs / 1000).toFixed(1)}s</small><br>
  <small>Auth: ${report.auth.attempted ? (report.auth.ok ? '✅ ' : '⚠️ ') + esc(report.auth.message) : 'not used'}</small>
</header>
<div class="wrap">
  <div class="cards">
    <div class="card"><b>${s.pagesCrawled}</b><span>Pages crawled</span></div>
    <div class="card"><b style="color:#d33">${s.pagesWithErrors}</b><span>Pages with errors</span></div>
    <div class="card"><b style="color:#e6a100">${s.pagesWithWarnings}</b><span>Pages with warnings</span></div>
    <div class="card"><b style="color:#2a2">${s.cleanPages}</b><span>Clean pages</span></div>
    <div class="card"><b>${s.totalIssues}</b><span>Total issues</span></div>
    <div class="card"><b style="color:#d33">${s.brokenExternalLinks}</b><span>Broken external links</span></div>
  </div>

  <h2>Issues by type</h2>
  <table><thead><tr><th>Type</th><th>Count</th></tr></thead><tbody>${typeRows || '<tr><td colspan=2><em>None</em></td></tr>'}</tbody></table>

  <h2>Pages (${report.pages.length})</h2>
  <table>
    <thead><tr><th>#</th><th>Result</th><th>HTTP</th><th>Load</th><th>URL / Title</th><th>Issues</th></tr></thead>
    <tbody>${pageRows}</tbody>
  </table>

  <h2>Broken external links (${brokenExt.length})</h2>
  ${brokenExtHtml}
</div>
</body></html>`;
}
