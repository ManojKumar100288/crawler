// Web UI server for the QA crawler.
// Serves a form-based UI, runs crawls, streams live progress (SSE), and serves reports.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { crawl } from './crawler.js';
import { writeReports } from './report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const REPORTS_DIR = path.resolve('./reports');

const PORT = process.env.PORT ? Number(process.env.PORT) : 5177;

// In-memory job store. Each job streams logs to any connected SSE clients.
const jobs = new Map();

function newJob() {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = { id, logs: [], clients: new Set(), done: false, result: null, error: null };
  jobs.set(id, job);
  return job;
}

function pushLog(job, message) {
  const line = typeof message === 'string' ? message : JSON.stringify(message);
  job.logs.push(line);
  for (const res of job.clients) {
    res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
  }
}

function finishJob(job, payload) {
  job.done = true;
  job.result = payload;
  for (const res of job.clients) {
    res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
    res.end();
  }
  job.clients.clear();
}

function failJob(job, message) {
  job.done = true;
  job.error = message;
  for (const res of job.clients) {
    res.write(`event: error\ndata: ${JSON.stringify(message)}\n\n`);
    res.end();
  }
  job.clients.clear();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendFile(res, filePath, status = 200) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(status, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Build a crawler config from the UI form payload.
function buildConfigFromForm(form) {
  const cliOverrides = {
    baseUrl: form.baseUrl,
    maxPages: form.maxPages ? Number(form.maxPages) : undefined,
    maxDepth: form.maxDepth ? Number(form.maxDepth) : undefined,
    concurrency: form.concurrency ? Number(form.concurrency) : undefined,
    includeSubdomains: !!form.includeSubdomains,
    checkExternalLinks: form.checkExternalLinks !== false,
    useSitemap: form.useSitemap !== false,
    fullSite: !!form.fullSite,
    scanMode: form.scanMode === 'homeAllLinks' ? 'homeAllLinks' : 'full',
    ai: (() => {
      // API key can come from the form OR from the OPENAI_API_KEY env var on the host.
      const key = (form.ai && form.ai.apiKey) || process.env.OPENAI_API_KEY || null;
      const wantAi = (form.ai && form.ai.enabled) || !!process.env.OPENAI_API_KEY;
      if (!wantAi || !key) return { enabled: false };
      return {
        enabled: true,
        apiKey: key,
        model: (form.ai && form.ai.model) || process.env.OPENAI_MODEL || 'gpt-4o-mini',
        baseUrl: (form.ai && form.ai.baseUrl) || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      };
    })(),
    outputDir: REPORTS_DIR,
    headless: true,
  };
  if (form.login && form.login.enabled) {
    cliOverrides.login = {
      enabled: true,
      loginUrl: form.login.loginUrl,
      usernameSelector: form.login.usernameSelector || '#username',
      passwordSelector: form.login.passwordSelector || '#password',
      submitSelector: form.login.submitSelector || 'button[type=submit]',
      username: form.login.username,
      password: form.login.password,
      successUrlIncludes: form.login.successUrlIncludes || null,
      waitAfterLoginMs: form.login.waitAfterLoginMs ? Number(form.login.waitAfterLoginMs) : 2000,
    };
  }
  return loadConfig({ cliOverrides });
}

async function runCrawlJob(job, form) {
  let cfg;
  try {
    cfg = buildConfigFromForm(form);
  } catch (err) {
    failJob(job, `Config error: ${err.message}`);
    return;
  }

  pushLog(job, `Starting crawl on ${cfg.baseUrl} (maxPages=${cfg.maxPages}, maxDepth=${cfg.maxDepth}, login=${cfg.login?.enabled ? 'on' : 'off'})`);

  try {
    const report = await crawl(cfg, (m) => pushLog(job, m));
    const { jsonPath, htmlPath } = writeReports(report, cfg);
    pushLog(job, 'Crawl finished. Report generated.');
    finishJob(job, {
      summary: report.summary,
      auth: report.auth,
      aiSummary: report.aiSummary || null,
      htmlReport: '/reports/' + path.basename(htmlPath),
      jsonReport: '/reports/' + path.basename(jsonPath),
    });
  } catch (err) {
    failJob(job, `Crawl failed: ${err.message}`);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // Start a crawl.
  if (req.method === 'POST' && pathname === '/api/crawl') {
    try {
      const body = await readBody(req);
      const form = JSON.parse(body || '{}');
      if (!form.baseUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'baseUrl is required' }));
        return;
      }
      const job = newJob();
      // Run asynchronously; client subscribes to progress via SSE.
      runCrawlJob(job, form);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobId: job.id }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Subscribe to live progress via Server-Sent Events.
  if (req.method === 'GET' && pathname === '/api/progress') {
    const jobId = url.searchParams.get('jobId');
    const job = jobs.get(jobId);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('unknown job');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Replay existing logs.
    for (const line of job.logs) {
      res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
    }
    if (job.done) {
      if (job.error) res.write(`event: error\ndata: ${JSON.stringify(job.error)}\n\n`);
      else res.write(`event: done\ndata: ${JSON.stringify(job.result)}\n\n`);
      res.end();
      return;
    }
    job.clients.add(res);
    req.on('close', () => job.clients.delete(res));
    return;
  }

  // Serve generated reports.
  if (req.method === 'GET' && pathname.startsWith('/reports/')) {
    const name = path.basename(pathname);
    const filePath = path.join(REPORTS_DIR, name);
    // Prevent path traversal.
    if (!filePath.startsWith(REPORTS_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    sendFile(res, filePath);
    return;
  }

  // Serve UI.
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }
  if (req.method === 'GET' && pathname === '/app.js') {
    sendFile(res, path.join(PUBLIC_DIR, 'app.js'));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use.`);
    console.error(`   Another QA Crawler server may already be running.`);
    console.error(`   Just open http://localhost:${PORT} in your browser,`);
    console.error(`   or start on a different port:  set PORT=8080 && node src\\server.js\n`);
  } else {
    console.error(`\n❌ Server error: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\n🖥️  QA Crawler UI running at:  http://localhost:${PORT}\n`);
  console.log('   Open that URL in your browser, enter a website URL, and click "Start Crawl".');
  console.log('   Press Ctrl+C to stop the server.\n');
});
