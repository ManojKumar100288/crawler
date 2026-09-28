// Front-end logic for the QA Crawler UI.
const $ = (id) => document.getElementById(id);

const logEl = $('log');
const startBtn = $('startBtn');
const summaryEl = $('summary');
const statCards = $('statCards');
const reportLinks = $('reportLinks');
const authLine = $('authLine');

// Toggle login fields.
$('loginEnabled').addEventListener('change', (e) => {
  $('loginFields').classList.toggle('hidden', !e.target.checked);
});

function log(line, cls) {
  if (logEl.classList.contains('muted')) {
    logEl.classList.remove('muted');
    logEl.textContent = '';
  }
  const div = document.createElement('div');
  div.textContent = line;
  if (cls) div.style.color = cls;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function collectForm() {
  const form = {
    baseUrl: $('baseUrl').value.trim(),
    maxPages: $('maxPages').value,
    maxDepth: $('maxDepth').value,
    concurrency: $('concurrency').value,
    includeSubdomains: $('includeSubdomains').checked,
    checkExternalLinks: $('checkExternalLinks').checked,
  };
  if ($('loginEnabled').checked) {
    form.login = {
      enabled: true,
      loginUrl: $('loginUrl').value.trim(),
      username: $('username').value,
      password: $('password').value,
      usernameSelector: $('usernameSelector').value.trim(),
      passwordSelector: $('passwordSelector').value.trim(),
      submitSelector: $('submitSelector').value.trim(),
      successUrlIncludes: $('successUrlIncludes').value.trim(),
    };
  }
  return form;
}

function showSummary(payload) {
  summaryEl.classList.remove('hidden');
  const s = payload.summary || {};
  const cards = [
    ['Pages', s.pagesCrawled, '#e5e7eb'],
    ['Errors', s.pagesWithErrors, '#ef4444'],
    ['Warnings', s.pagesWithWarnings, '#f59e0b'],
    ['Clean', s.cleanPages, '#22c55e'],
    ['Total issues', s.totalIssues, '#e5e7eb'],
    ['Broken links', s.brokenExternalLinks, '#ef4444'],
  ];
  statCards.innerHTML = cards
    .map(([label, val, color]) => `<div class="stat"><b style="color:${color}">${val ?? 0}</b><span>${label}</span></div>`)
    .join('');

  reportLinks.innerHTML =
    `<a class="btnlink" href="${payload.htmlReport}" target="_blank">📄 Open HTML report</a>` +
    `<a class="btnlink" href="${payload.jsonReport}" target="_blank">{ } JSON report</a>`;

  if (payload.auth && payload.auth.attempted) {
    authLine.textContent = (payload.auth.ok ? '✅ ' : '⚠️ ') + 'Auth: ' + payload.auth.message;
  } else {
    authLine.textContent = '';
  }
}

async function start() {
  const form = collectForm();
  if (!form.baseUrl) {
    alert('Please enter a website URL.');
    return;
  }

  startBtn.disabled = true;
  startBtn.textContent = 'Crawling…';
  summaryEl.classList.add('hidden');
  logEl.classList.add('muted');
  logEl.textContent = 'Starting…';

  let jobId;
  try {
    const res = await fetch('/api/crawl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start');
    jobId = data.jobId;
  } catch (err) {
    log('Error: ' + err.message, '#ef4444');
    resetBtn();
    return;
  }

  const es = new EventSource('/api/progress?jobId=' + encodeURIComponent(jobId));
  es.addEventListener('log', (e) => log(JSON.parse(e.data)));
  es.addEventListener('done', (e) => {
    const payload = JSON.parse(e.data);
    log('✅ Done.', '#22c55e');
    showSummary(payload);
    es.close();
    resetBtn();
  });
  es.addEventListener('error', (e) => {
    if (e.data) log('❌ ' + JSON.parse(e.data), '#ef4444');
    es.close();
    resetBtn();
  });
}

function resetBtn() {
  startBtn.disabled = false;
  startBtn.textContent = 'Start Crawl';
}

startBtn.addEventListener('click', start);
