# Deploying QA Crawler (going live)

This tool is a small Node.js web server. You can run it locally, on a VM/server,
or in Docker. Pick whichever fits.

---

## Option A — Run on any server (Node.js)

Requirements: Node.js 18+ on the server.

```bash
# 1. Get the code onto the server (git clone or copy the folder)
cd qa-crawler

# 2. Install dependencies + the browser
npm install
npx playwright install --with-deps chromium

# 3. Start the UI server
#    Use PORT to change the port (default 5177)
PORT=5177 npm run ui
```

Open `http://SERVER_IP:5177` in a browser.

To keep it running after you log out, use a process manager like **pm2**:

```bash
npm install -g pm2
pm2 start src/server.js --name qa-crawler
pm2 save
pm2 startup   # follow the printed instructions to auto-start on reboot
```

---

## Option B — Docker (recommended for "live")

Requirements: Docker installed on the server.

```bash
cd qa-crawler

# Build the image
docker build -t qa-crawler .

# Run it (maps port 5177 on the host to the container)
docker run -d --name qa-crawler -p 5177:5177 qa-crawler
```

Open `http://SERVER_IP:5177`.

Change the port:

```bash
docker run -d --name qa-crawler -e PORT=8080 -p 8080:8080 qa-crawler
```

Update after code changes:

```bash
docker build -t qa-crawler .
docker rm -f qa-crawler
docker run -d --name qa-crawler -p 5177:5177 qa-crawler
```

---

## Option C — Behind a domain (nginx reverse proxy)

If you want `https://qa.yourdomain.com` instead of an IP:port, put nginx in front:

```nginx
server {
    listen 80;
    server_name qa.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:5177;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # Server-Sent Events (live progress) needs these:
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

Then add HTTPS with certbot (`certbot --nginx -d qa.yourdomain.com`).

> Important: the live progress uses Server-Sent Events. Keep `proxy_buffering off`
> and a long `proxy_read_timeout`, otherwise progress updates will stall.

---

## Security notes before exposing publicly

This tool crawls any URL you give it and can log into sites with credentials you
type in. Before putting it on a public server:

- **Put it behind authentication** (nginx basic auth, VPN, or an SSO proxy). It has
  no built-in login of its own.
- **Restrict who can reach the port** (firewall / security group) — ideally only
  your QA team's IPs.
- **Never commit `qa.config.json` or `.env`** — they may hold credentials. They are
  already in `.gitignore`.
- Consider limiting `maxPages` so nobody can launch a huge crawl by accident.

---

## Config

- Default port: `5177` (override with the `PORT` env var).
- Reports are written to `./reports/` inside the app directory. In Docker, mount a
  volume if you want them to persist:  `-v /host/reports:/app/reports`.
