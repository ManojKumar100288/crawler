# Hosting QA Crawler on a Free Server (permanent URL, runs anywhere)

This guide gives you a **permanent public URL** for QA Crawler so anyone can use
it from any browser — your laptop does **not** need to be on.

Because the tool runs a real Chromium browser (Playwright), it needs a host that
can run a **Docker container** or a **Linux VM**. Below are the best free options,
easiest first.

---

## Option 1 — Render.com (easiest, recommended) ⭐

Render runs your Docker image for free and gives you an HTTPS URL like
`https://qa-crawler.onrender.com`. The repo already contains `Dockerfile` and
`render.yaml`, so deployment is almost automatic.

### Steps

1. **Put the code on GitHub**
   - Create a new empty repo on GitHub (e.g. `qa-crawler`).
   - Push this project to it:
     ```bash
     git remote add origin https://github.com/<you>/qa-crawler.git
     git push -u origin master
     ```

2. **Create the service on Render**
   - Go to https://render.com and sign up (free, GitHub login works).
   - Click **New → Web Service** → connect your GitHub repo.
   - Render detects the `Dockerfile` automatically. Select the **Free** plan.
   - Click **Create Web Service**.

3. **Wait for the build** (~3–5 min the first time). When it's done you get a URL:
   ```
   https://qa-crawler-xxxx.onrender.com
   ```
   Share that link — it works from any device, anytime.

### Good to know
- **Free instances sleep after ~15 min of inactivity.** The first request after
  sleeping takes ~30–50 seconds to wake up, then it's fast. Fine for demos and
  occasional use.
- No credit card required for the free web service.
- Every time you `git push`, Render redeploys automatically.

---

## Option 2 — Railway.app (easy, small free credit)

1. Push the code to GitHub (same as above).
2. Go to https://railway.app → **New Project → Deploy from GitHub repo**.
3. Railway builds the `Dockerfile` and gives you a public URL.
4. Free monthly usage credit; good for light use.

---

## Option 3 — Oracle Cloud Always Free (truly free forever, more setup) 🏆

This is the only option that is **free permanently with no sleep** — a real
always-on Linux server. More setup, but best for long-term use.

### Steps (summary)
1. Sign up at https://www.oracle.com/cloud/free/ (needs a card for identity
   verification; the "Always Free" resources are not charged).
2. Create an **Always Free** VM instance (Ampere A1, Ubuntu).
3. Open port 5177 (or 80) in the VM's security list / firewall.
4. SSH into the VM and run:
   ```bash
   # install Node 18+
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs git

   # get the code
   git clone https://github.com/<you>/qa-crawler.git
   cd qa-crawler
   npm install
   npx playwright install --with-deps chromium

   # keep it running forever with pm2
   sudo npm install -g pm2
   PORT=80 pm2 start src/server.js --name qa-crawler
   pm2 save
   pm2 startup   # follow the printed command so it restarts on reboot
   ```
5. Visit `http://<your-vm-public-ip>` — it runs 24/7, free, no sleep.

---

## Option 4 — MyBharat internal infrastructure

Your team already deploys with Docker. Hand them this repo — it has a
`Dockerfile` and `DEPLOY.md`. They can run it on existing infra behind your
internal domain. This is the best choice for a production/internal tool.

---

## ⚠️ Important: secure it before public hosting

QA Crawler accepts **any URL to crawl** and can take **login credentials**. On a
public server you should restrict access so strangers can't use it:

- Put it behind **HTTP basic auth** (via nginx) or a **VPN / SSO**, or
- Restrict the port to your team's IPs (firewall / security group).

I can add a simple username/password gate to the app itself if you want it
protected without extra infrastructure — just ask.

---

## Which should you pick?

| Need | Best option |
|------|-------------|
| Fastest free demo URL | **Render** (Option 1) |
| Free forever, always on | **Oracle Cloud** (Option 3) |
| Production / internal | **MyBharat infra** (Option 4) |

For showing the CTO a live link quickly, **Render** is the easiest. For a
permanent always-on URL at no cost, **Oracle Cloud Always Free** is the best.
