# QA Crawler

बस website का URL दो → software खुद website को crawl करता है → public और login के बाद वाले pages खोजता है → हर page/link को test करता है → errors ढूँढता है → और पूरी QA report देता है।

An automated website QA crawler. Give it a URL and it will:

1. Crawl every internal page (breadth-first, same-origin by default).
2. Optionally log in first, so it can reach authenticated / post-login pages.
3. Test each page for problems: HTTP errors, JS exceptions, console errors, failed network requests, broken images, missing `<title>`, slow loads.
4. Check external links for reachability (broken links).
5. Produce a full QA report as **HTML** (readable) and **JSON** (machine-readable).

## Install

```powershell
cd d:\D_Projects\Automation_MK\qa-crawler
npm install
npx playwright install chromium
```

## Easiest: one-click launcher (Windows)

Just **double-click `Start-QA-Crawler.bat`** in the `qa-crawler` folder.

It starts the server and opens the UI in your browser automatically. Keep the
black command window open while you use the tool; close it to stop the server.

## Run it from a UI (browser)

Prefer clicking over typing commands? Start the web UI:

```powershell
cd d:\D_Projects\Automation_MK\qa-crawler
npm run ui
```

Then open **http://localhost:5177** in your browser. You get a form to:

- Enter the website URL
- Set max pages / depth / concurrency
- Toggle "Include subdomains" and "Check external links"
- Optionally enable **Login** and fill in login URL, username, password, and form selectors

Click **Start Crawl**. You'll see **live progress** stream page-by-page, then a **summary** (pages, errors, warnings, clean, broken links) with buttons to **open the HTML/JSON report** right in the browser.

No extra dependencies — the UI uses Node's built-in HTTP server. Reports are still written to `./reports/`.

> Tip: change the port with `$env:PORT=8080; npm run ui` (PowerShell).

## Quick start (command line)

```powershell
# Simplest: just give a URL
node src/cli.js https://example.com

# Limit crawl size
node src/cli.js https://example.com --max-pages 50 --max-depth 3

# Crawl subdomains too, skip external link checks
node src/cli.js https://example.com --include-subdomains --no-external
```

## Post-login (authenticated) pages

Provide login details on the CLI:

```powershell
node src/cli.js https://app.example.com --login `
  --login-url https://app.example.com/login `
  --username myuser --password mypass
```

Or use a config file for full control over selectors (recommended for real sites):

```powershell
copy qa.config.example.json qa.config.json
# edit qa.config.json (baseUrl, login selectors, credentials, limits)
node src/cli.js --config qa.config.json
```

In `qa.config.json`, the `login` block lets you match the actual form:

```json
"login": {
  "enabled": true,
  "loginUrl": "https://app.example.com/login",
  "usernameSelector": "#email",
  "passwordSelector": "#password",
  "submitSelector": "button[type=submit]",
  "username": "myuser",
  "password": "mypass",
  "successUrlIncludes": "/dashboard",
  "waitAfterLoginMs": 2000
}
```

## Checking ALL URLs (full coverage)

By default the crawler follows links (BFS) AND reads the site's `sitemap.xml`, so it
also finds **orphan/unlinked pages** that a pure link-crawl would miss. It follows
nested sitemap indexes automatically.

To check the **whole site**, turn on **Full site** mode:

- In the UI: tick **"Full site — check ALL URLs"**.
- On the CLI: add `--full-site`.

Full-site mode raises the page/depth limits automatically and forces sitemap use.

```powershell
node src/cli.js https://example.com --full-site
```

Notes:
- Big sites can have tens of thousands of sitemap URLs (we've seen 100k+). Crawling
  every one takes a real browser visit per page, so it can be slow. Raise
  `--concurrency` and keep `--max-pages` sensible for a first run.
- Orphan pages that are in NO sitemap and linked from NO page cannot be discovered
  automatically — there's no way to know they exist. Feed them in directly if needed.
- Use `--no-sitemap` to do a link-crawl only.

## Options

| Flag | Meaning | Default |
|------|---------|---------|
| `--config <path>` | Load settings from JSON | — |
| `--max-pages <n>` | Max pages to crawl | 100 |
| `--max-depth <n>` | Max link depth | 4 |
| `--concurrency <n>` | Parallel pages | 3 |
| `--include-subdomains` | Crawl subdomains of the root domain | off |
| `--no-external` | Skip external link checks | off |
| `--headed` | Show the browser window | off |
| `--out <dir>` | Report output directory | `./reports` |
| `--login` / `--login-url` / `--username` / `--password` | Auth | off |

## Output

Reports are written to `./reports/`:

- `qa-report-<timestamp>.html` — open in a browser for a readable dashboard.
- `qa-report-<timestamp>.json` — full structured results for CI / further processing.

## Exit codes

- `0` — crawl completed, no page-level errors.
- `2` — crawl completed but at least one page had an **error**-severity issue (handy for CI gates).
- `1` — fatal/config error.

## What gets checked per page

- HTTP status (flags 4xx/5xx as errors, 3xx as info)
- Uncaught JavaScript exceptions (`pageerror`) → error
- Console errors → warning
- Failed network requests → warning
- Broken images (`naturalWidth === 0`) → warning
- Missing/empty `<title>` → warning
- Slow page load beyond threshold → warning

## Notes

- Same-origin only by default; use `--include-subdomains` to widen scope.
- `ignorePatterns` in the config skips assets (images, css, js, pdf, etc.) and logout links so the crawler doesn't kill its own session.
- Credentials in a config file are secrets — don't commit `qa.config.json`.
