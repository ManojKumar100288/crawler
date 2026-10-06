# QA Crawler — Product Overview

**An automated website QA tool for the MyBharat / YUVA platform.**

Give it a website URL. It crawls the site, opens every page/link in a real
browser, finds errors, and produces a shareable QA report — in minutes, with no
manual clicking.

---

## 1. What problem it solves

Today, checking whether every page and link on a site works is **manual, slow,
and error-prone**. A QA engineer has to open each page, click each link, and note
what's broken. On a large portal like MyBharat (dozens of pages, hundreds of
links), this takes hours and things get missed.

**QA Crawler automates this end-to-end:**

- One input: the website URL.
- It discovers all pages (by following links **and** reading `sitemap.xml`).
- It opens each page in a real browser (Chromium via Playwright).
- It detects technical problems automatically.
- It produces an HTML + JSON QA report.

---

## 2. What it checks (per page)

| Check | Example issue caught |
|-------|----------------------|
| HTTP status | Page returns 404 / 500 |
| Broken links | A header/footer/body link points to a dead URL |
| JavaScript errors | Uncaught JS exceptions on the page |
| Console errors | CSP violations, runtime console errors |
| Failed network requests | A font/API/image fails to load |
| Broken images | `<img>` that doesn't render |
| Missing page title | Empty `<title>` (SEO/accessibility) |
| Slow page load | Page takes longer than the threshold |
| External link health | Outbound links that are dead |

**Smart handling of bot-protected sites:** Social/government sites (Facebook, X,
Instagram, LinkedIn, india.gov.in, etc.) deliberately block automated requests
and return 400/403. QA Crawler recognises these and labels them **"Blocked
(bot-protected) — likely OK in browser"** instead of falsely reporting them as
broken. This removes false positives.

---

## 3. Scan modes

1. **Full site — crawl all pages**
   Breadth-first crawl of the whole site. Reads `sitemap.xml` (including nested
   sitemap indexes) so even orphan / unlinked pages are found.

2. **Home page only — check ALL links (header + footer + body)**
   Inspects just the home page and validates every link on it, grouped by region
   (header / footer / body). Fast, focused smoke test.

---

## 4. The report

Every run produces two outputs in `./reports/`:

- **HTML report** — a readable dashboard: summary cards (pages, errors, warnings,
  broken links, blocked links), issues grouped by type, and a per-page table with
  every issue and link.
- **JSON report** — the same data in machine-readable form, for CI pipelines or
  further processing.

A CI-friendly exit code is returned (non-zero when a page has errors), so this
can later be wired into a build pipeline.

---

## 5. How to use it

### Option A — Web UI (recommended for most users)
1. Double-click `Start-QA-Crawler.bat` (Windows).
2. The browser opens `http://localhost:5177` automatically.
3. Enter the URL, pick a scan mode, click **Start Crawl**.
4. Watch live progress, then open the HTML report.

Optional **Login** support lets it reach authenticated / post-login pages
(provide login URL, username, password, and the form field selectors).

### Option B — Command line (for automation / CI)
```bash
node src/cli.js https://mybharat.gov.in --home-links
node src/cli.js https://mybharat.gov.in --full-site --concurrency 5
```

---

## 6. Live demo

A temporary public URL can be shared for a live demo (via a secure tunnel):

```
Live URL:  https://headwear-diligence-latrine.ngrok-free.dev
```

> Note: On first open, click **"Visit Site"** on the ngrok notice page.
> This URL is temporary and only works while the demo server + tunnel are
> running on the host machine. It changes each time the tunnel is restarted.

For a **permanent** URL, the tool ships with a `Dockerfile` and `DEPLOY.md` and
can be hosted on MyBharat infrastructure or a cloud service (Render / Railway /
Fly.io). See section 8.

---

## 7. Technology Stack

### 7.1 Backend

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Node.js 18+ (ES modules) | Runs the whole application |
| Web/API server | Node.js built-in `http` module | Serves the UI and exposes the API — no Express/heavy framework |
| Browser automation | Playwright (Chromium) | Opens every page/link in a real browser to detect errors |
| Crawl engine | Custom module (`src/crawler.js`) | Breadth-first crawl, concurrency control, queue management |
| Sitemap discovery | Custom module (`src/sitemap.js`) | Reads `robots.txt` + `sitemap.xml` (incl. nested indexes) |
| Page checks | Custom module (`src/checks.js`) | HTTP status, JS/console errors, broken images/links, timings |
| Report generator | Custom module (`src/report.js`) | Produces the HTML + JSON reports |
| Live progress | Server-Sent Events (SSE) | Streams crawl progress to the browser in real time |
| Packaging | Docker (official Playwright base image) | Containerised deployment |

> **Only one external dependency: Playwright.** Everything else uses Node's
> standard library, which keeps the tool lightweight and easy to deploy.

### 7.2 Frontend

| Component | Technology | Purpose |
|-----------|------------|---------|
| Markup | HTML5 (`public/index.html`) | Single-page UI structure |
| Styling | Plain CSS3 (gradients, glassmorphism, flex/grid, animations) | Modern dark-theme design — no CSS framework |
| Logic | Vanilla JavaScript (`public/app.js`) | Form handling, live log, summary rendering |
| Live updates | `EventSource` (SSE client) | Receives real-time progress from the server |
| Build step | None | Served as static files directly — no React/Vue/webpack |

### 7.3 APIs

The server exposes a small internal REST + SSE API (consumed by the UI):

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/crawl` | Start a crawl with the submitted options; returns a `jobId` |
| `GET` | `/api/progress?jobId=...` | Server-Sent Events stream of live progress + final result |
| `GET` | `/reports/<file>` | Serves the generated HTML/JSON report files |
| `GET` | `/`, `/app.js` | Serves the UI (static files) |

**External / third-party APIs used:** none. The tool does **not** depend on any
paid or external API. It only makes standard HTTP(S) requests to the website
being tested (via Playwright's browser and request APIs) to crawl and check it.

### 7.4 Database

**None.** This tool does not use any database (no SQL, NoSQL, Redis, SQLite, or
any other data store). All data lives in memory during a crawl and is written to
flat files (JSON + HTML reports in the `./reports/` directory) when the crawl
completes. There is nothing to install, configure, or maintain on the database
side.

If persistent storage is needed in the future (e.g., crawl history, trend
comparison), a lightweight solution such as SQLite or a JSON file store could be
added without changing the existing architecture.

### 7.5 AI integration

**Available now — AI Report Summary.** The tool can optionally send the crawl
results to a Large Language Model (OpenAI-compatible API) and generate a clear,
prioritized plain-English summary that a CTO or PM can read in seconds — e.g.
"The site is healthy overall; the /login page throws a JavaScript error (fix
first); 5 footer links are bot-protected and likely fine." The summary appears
in the UI, the HTML report, and the CLI output.

- **How it works:** one API call after the crawl, sending a compact version of
  the report. No raw page data is stored.
- **Providers:** OpenAI (default), Azure OpenAI, or any OpenAI-compatible
  endpoint (configurable `baseUrl` + `model`).
- **Optional & safe:** disabled by default. If no API key is provided, the tool
  runs exactly as before with no AI. The key can be supplied per-run (UI/CLI) or
  set once on the server via the `OPENAI_API_KEY` environment variable.

**Where AI can be used (roadmap).** The architecture allows AI to be added at
several points:

| Area | What AI does | Status |
|------|--------------|--------|
| Report summary | Plain-English, prioritized summary of findings | ✅ Done |
| Visual/UI testing | Vision model reviews page screenshots for broken layout, overlapping text, misalignment | Planned |
| Content validation | Detects placeholder/dummy text, wrong language, title–content mismatch | Planned |
| Issue severity classification | AI ranks issues Critical / Major / Minor / Info instead of fixed rules | Planned |
| Test suggestions | AI reads the site structure and suggests functional tests to run next | Planned |
| Accessibility (a11y) review | AI checks pages for WCAG issues (alt text, contrast, ARIA) — valuable for government sites | Planned |

> **Cost note:** AI features are opt-in and use pay-per-use APIs. The report
> summary is a single low-cost call per crawl. Per-page features (visual/content
> checks) scale with the number of pages, so they can be enabled selectively.

---

## 8. Deployment options

- **Local** — run on any machine with Node.js (`npm run ui`).
- **Docker** — `docker build -t qa-crawler . && docker run -p 5177:5177 qa-crawler`.
- **Server / cloud** — behind nginx with HTTPS; details in `DEPLOY.md`.

### Security note (before public hosting)
The tool crawls arbitrary URLs and can accept login credentials. Before exposing
it on the public internet it should be placed **behind authentication** (basic
auth / VPN / SSO) and restricted to the QA team. Credentials are never committed
(they're in `.gitignore`).

---

## 9. Current status & roadmap

**Done**
- Full-site + home-page scan modes
- sitemap.xml discovery (nested indexes)
- Real-browser link checking with false-positive handling for bot-protected sites
- Live-progress Web UI + CLI
- HTML + JSON reports
- AI-powered report summary (optional, OpenAI-compatible)
- Docker + deploy docs
- One-click Windows launcher

**Possible next steps**
- Built-in authentication for the hosted UI
- Scheduled/automated runs + email of the report
- Functional test flows (not just link health): verify buttons/forms work
- CI integration (fail a build when critical pages break)
- Trend history (compare today's run vs last week's)
