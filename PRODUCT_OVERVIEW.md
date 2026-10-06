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

## 7. Technology

| Layer | Technology |
|-------|------------|
| Browser automation | Playwright (Chromium) |
| Runtime | Node.js 18+ |
| Web server / UI | Node built-in `http` (no heavy framework), Server-Sent Events for live progress |
| Front end | Plain HTML/CSS/JS (no build step) |
| Packaging | Docker (official Playwright base image) |

Design choices kept it **dependency-light** (one runtime dependency: Playwright)
so it's easy to install, run, and deploy.

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
- Docker + deploy docs
- One-click Windows launcher

**Possible next steps**
- Built-in authentication for the hosted UI
- Scheduled/automated runs + email of the report
- Functional test flows (not just link health): verify buttons/forms work
- CI integration (fail a build when critical pages break)
- Trend history (compare today's run vs last week's)

---

## 10. Quick facts for the CTO

- **Input:** a URL. **Output:** a full QA report in minutes.
- **Coverage:** every linked page + sitemap pages, each opened in a real browser.
- **Accuracy:** distinguishes genuinely broken links from bot-blocked ones.
- **Footprint:** lightweight, containerised, deployable on existing infra.
- **Extensible:** CLI + JSON output make it CI-ready.
