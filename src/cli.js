#!/usr/bin/env node
// CLI entrypoint: parse args, load config, run crawl, write reports.
import { loadConfig } from './config.js';
import { crawl } from './crawler.js';
import { writeReports } from './report.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { _: [], cliOverrides: {}, configPath: null };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--config' || a === '-c') {
      out.configPath = args[++i];
    } else if (a === '--max-pages') {
      out.cliOverrides.maxPages = Number(args[++i]);
    } else if (a === '--max-depth') {
      out.cliOverrides.maxDepth = Number(args[++i]);
    } else if (a === '--concurrency') {
      out.cliOverrides.concurrency = Number(args[++i]);
    } else if (a === '--include-subdomains') {
      out.cliOverrides.includeSubdomains = true;
    } else if (a === '--no-external') {
      out.cliOverrides.checkExternalLinks = false;
    } else if (a === '--no-sitemap') {
      out.cliOverrides.useSitemap = false;
    } else if (a === '--full-site') {
      out.cliOverrides.fullSite = true;
    } else if (a === '--home-links') {
      out.cliOverrides.scanMode = 'homeAllLinks';
    } else if (a === '--ai-key') {
      out.cliOverrides.ai = out.cliOverrides.ai || {};
      out.cliOverrides.ai.enabled = true;
      out.cliOverrides.ai.apiKey = args[++i];
    } else if (a === '--ai-model') {
      out.cliOverrides.ai = out.cliOverrides.ai || {};
      out.cliOverrides.ai.model = args[++i];
    } else if (a === '--headed') {
      out.cliOverrides.headless = false;
    } else if (a === '--out') {
      out.cliOverrides.outputDir = args[++i];
    } else if (a === '--login') {
      out.cliOverrides.login = out.cliOverrides.login || {};
      out.cliOverrides.login.enabled = true;
    } else if (a === '--login-url') {
      out.cliOverrides.login = out.cliOverrides.login || {};
      out.cliOverrides.login.loginUrl = args[++i];
    } else if (a === '--username') {
      out.cliOverrides.login = out.cliOverrides.login || {};
      out.cliOverrides.login.username = args[++i];
    } else if (a === '--password') {
      out.cliOverrides.login = out.cliOverrides.login || {};
      out.cliOverrides.login.password = args[++i];
    } else if (a === '--post-login') {
      out.cliOverrides.postLoginStart = true;
    } else if (a === '--click') {
      out.cliOverrides.clickMode = true;
    } else if (a === '--max-clicks') {
      out.cliOverrides.maxClicksPerPage = Number(args[++i]);
    } else if (a.startsWith('--')) {
      console.warn(`Unknown flag ignored: ${a}`);
    } else {
      out._.push(a);
    }
  }

  if (out._[0]) out.cliOverrides.baseUrl = out._[0];
  return out;
}

const HELP = `
QA Crawler - automated website QA crawler + reporter

Usage:
  node src/cli.js <url> [options]
  node src/cli.js --config qa.config.json

Options:
  -c, --config <path>       Load settings from a JSON config file
      --max-pages <n>       Max pages to crawl (default 100)
      --max-depth <n>       Max link depth (default 4)
      --concurrency <n>     Parallel pages (default 3)
      --include-subdomains  Crawl subdomains of the root domain too
      --no-external         Skip external link reachability checks
      --no-sitemap          Do not read sitemap.xml (link-crawl only)
      --full-site           Check ALL URLs: raise limits + use sitemap
      --home-links          Home page only: check ALL its links (header+footer+body)
      --ai-key <key>        OpenAI API key (enables AI report summary)
      --ai-model <model>    AI model name (default: gpt-4o-mini)
      --headed              Run browser with a visible window
      --out <dir>           Output directory for reports (default ./reports)
      --login               Enable login flow (needs login-url/username/password)
      --login-url <url>     Login page URL
      --username <user>     Login username (login fields auto-detected)
      --password <pass>     Login password
      --post-login          Start crawl from the post-login page (check only the
                            authenticated area)
      --click               Click mode: physically click every anchor/button on
                            each page and record the result (slower, more thorough)
      --max-clicks <n>      Max elements to click per page (default 60)
  -h, --help                Show this help

Examples:
  node src/cli.js https://example.com
  node src/cli.js https://example.com --max-pages 50 --max-depth 3
  node src/cli.js https://app.example.com --login --login-url https://app.example.com/login --username me --password secret
  node src/cli.js --config qa.config.json
`;

async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.help || (!parsed.cliOverrides.baseUrl && !parsed.configPath)) {
    console.log(HELP);
    process.exit(parsed.help ? 0 : 1);
  }

  let cfg;
  try {
    cfg = loadConfig({ configPath: parsed.configPath, cliOverrides: parsed.cliOverrides });
  } catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
  }

  console.log(`\n🔎 QA Crawler starting on ${cfg.baseUrl}`);
  console.log(`   maxPages=${cfg.maxPages} maxDepth=${cfg.maxDepth} concurrency=${cfg.concurrency} login=${cfg.login?.enabled ? 'on' : 'off'}\n`);

  const report = await crawl(cfg, (m) => console.log(m));
  const { jsonPath, htmlPath } = writeReports(report, cfg);

  const s = report.summary;
  console.log('\n===== QA SUMMARY =====');
  console.log(`Pages crawled:        ${s.pagesCrawled}`);
  console.log(`Pages with errors:    ${s.pagesWithErrors}`);
  console.log(`Pages with warnings:  ${s.pagesWithWarnings}`);
  console.log(`Clean pages:          ${s.cleanPages}`);
  console.log(`Total issues:         ${s.totalIssues}`);
  console.log(`Broken external links:${s.brokenExternalLinks}`);
  if (s.clicksTotal > 0) {
    console.log(`Elements clicked:     ${s.clicksTotal}`);
    console.log(`Dead clicks:          ${s.clicksDead}`);
    console.log(`Clicks w/ JS error:   ${s.clicksJsError}`);
  }
  console.log('======================');
  if (report.aiSummary) {
    console.log('\n===== 🤖 AI SUMMARY =====');
    console.log(report.aiSummary);
    console.log('=========================');
  }
  console.log(`\n📄 HTML report: ${htmlPath}`);
  console.log(`📄 JSON report: ${jsonPath}\n`);

  // Exit non-zero if any page had errors (useful for CI).
  process.exit(s.pagesWithErrors > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
