// Optional login flow so the crawler can reach post-login (authenticated) pages.
//
// Generic by design: if the caller does not provide selectors, we auto-detect
// the username, password, and submit elements using common patterns. This lets
// login work on most websites without manual configuration.

// Candidate selectors for the password field (most reliable anchor on a form).
const PASSWORD_CANDIDATES = [
  'input[type=password]',
  'input[name*=pass i]',
  'input[id*=pass i]',
];

// Candidate selectors for the username / email / login identifier field.
const USERNAME_CANDIDATES = [
  'input[type=email]',
  'input[name*=email i]',
  'input[id*=email i]',
  'input[name*=user i]',
  'input[id*=user i]',
  'input[name*=login i]',
  'input[id*=login i]',
  'input[name*=mobile i]',
  'input[name*=phone i]',
  'input[autocomplete=username]',
  'input[type=text]',
  'input[type=tel]',
];

// Candidate selectors for the submit button.
const SUBMIT_CANDIDATES = [
  'button[type=submit]',
  'input[type=submit]',
  'button[name*=login i]',
  'button[id*=login i]',
  'button[class*=login i]',
  'button[id*=signin i]',
  'button[class*=signin i]',
];

// Regex for text on a button/link that OPENS the login popup (the trigger you
// click first). e.g. "Sign In", "Login", "Log in", "Sign Up".
const OPEN_LOGIN_TEXT = /\b(sign\s?in|log\s?in|login|signin|sign\s?up|account)\b/i;

// Find the first selector in a list that exists and is visible on the page.
async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        return sel;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

// Find a submit control; if no obvious submit button, fall back to a button
// whose text looks like a login action.
async function findSubmit(page) {
  const sel = await firstVisible(page, SUBMIT_CANDIDATES);
  if (sel) return { kind: 'selector', value: sel };

  // Fallback: a button/link whose visible text suggests login.
  const textButton = page
    .locator('button, [role=button], a')
    .filter({ hasText: /^(log\s?in|sign\s?in|login|continue|submit|next)$/i })
    .first();
  if (await textButton.isVisible({ timeout: 500 }).catch(() => false)) {
    return { kind: 'locator', value: textButton };
  }
  return null;
}

// Is a visible password field present on the page right now?
async function hasVisiblePassword(page) {
  return page
    .locator('input[type=password]')
    .first()
    .isVisible({ timeout: 800 })
    .catch(() => false);
}

// Close/dismiss any blocking overlay or modal popup (ad, podcast promo, cookie
// banner, etc.) that may intercept clicks on the real "Sign In" button.
async function dismissOverlays(page, log) {
  const closeSelectors = [
    '.modal.show button.close',
    '.modal.show [data-dismiss=modal]',
    '.modal.show [data-bs-dismiss=modal]',
    '[class*=modal][class*=show] button[aria-label=Close i]',
    'button[aria-label=Close i]',
    'button.close',
    '.close-button',
    '[class*=popup] [class*=close]',
    '[class*=modal] [class*=close]',
  ];
  let closed = 0;
  for (const sel of closeSelectors) {
    try {
      const els = page.locator(sel);
      const n = await els.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = els.nth(i);
        if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
          await el.click({ force: true, timeout: 1500 }).catch(() => {});
          closed++;
        }
      }
    } catch { /* ignore */ }
  }
  // As a last resort, press Escape to dismiss modals.
  await page.keyboard.press('Escape').catch(() => {});
  if (closed > 0) log(`[auth] dismissed ${closed} overlay/popup element(s) blocking the page`);
}

// Does this element look like a real login trigger (not a dropdown toggle)?
async function isLikelyLoginTrigger(el) {
  try {
    const txt = ((await el.textContent().catch(() => '')) || '').trim().toLowerCase();
    // Exact-ish login words are good; dropdown toggles usually have other text.
    if (!/\b(sign\s?in|log\s?in|login|signin)\b/.test(txt)) return false;
    // Avoid Bootstrap dropdown toggles.
    const cls = ((await el.getAttribute('class').catch(() => '')) || '').toLowerCase();
    const dataToggle = (await el.getAttribute('data-toggle').catch(() => '')) || (await el.getAttribute('data-bs-toggle').catch(() => '')) || '';
    if (/dropdown/.test(cls) || /dropdown/.test(dataToggle)) return false;
    return true;
  } catch {
    return false;
  }
}

// Click a "Sign In" / "Login" trigger to open the login popup/modal.
// Returns true if a trigger was clicked.
async function openLoginPopup(page, lc, log) {
  // First, clear any overlay/modal that could intercept the click.
  await dismissOverlays(page, log);

  // 1. Use an explicit trigger selector if the user provided one.
  if (lc.openSelector) {
    try {
      const el = page.locator(lc.openSelector).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        log(`[auth] clicking configured login trigger: ${lc.openSelector}`);
        await el.click({ timeout: 5000 }).catch(async () => {
          await el.click({ force: true, timeout: 3000 });
        });
        return true;
      }
    } catch { /* fall through */ }
  }

  // 2. Auto-find candidate triggers and pick the one that really looks like login.
  const candidates = page
    .locator('button, a, [role=button]')
    .filter({ hasText: OPEN_LOGIN_TEXT });
  const count = await candidates.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible({ timeout: 300 }).catch(() => false))) continue;
    if (!(await isLikelyLoginTrigger(el))) continue;

    const label = ((await el.textContent().catch(() => '')) || '').trim().slice(0, 30);
    log(`[auth] clicking login trigger ("${label}") to open popup`);
    // Normal click first; if an overlay still blocks it, dismiss + force-click.
    const clicked = await el.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!clicked) {
      await dismissOverlays(page, log);
      await el.click({ force: true, timeout: 3000 }).catch(() => {});
    }
    return true;
  }

  // 3. Last resort: click the first visible login-ish element with force.
  const fallback = candidates.first();
  if (await fallback.isVisible({ timeout: 500 }).catch(() => false)) {
    log('[auth] clicking first login-ish element (forced)');
    await fallback.click({ force: true, timeout: 3000 }).catch(() => {});
    return true;
  }
  return false;
}

// Tick any consent / terms / "remember me" checkboxes that are required to log in.
async function checkConsentBoxes(page, log) {
  try {
    const boxes = page.locator('input[type=checkbox]:visible');
    const count = await boxes.count().catch(() => 0);
    let checked = 0;
    for (let i = 0; i < count; i++) {
      const box = boxes.nth(i);
      const isChecked = await box.isChecked().catch(() => true);
      if (!isChecked) {
        // check() ticks it; if the real input is hidden behind a styled label,
        // fall back to clicking it.
        await box.check({ timeout: 1500 }).catch(async () => {
          await box.click({ force: true, timeout: 1500 }).catch(() => {});
        });
        checked++;
      }
    }
    if (checked > 0) log(`[auth] checked ${checked} consent/checkbox field(s)`);
  } catch {
    /* ignore */
  }
}

/**
 * Perform a form login in the given browser context.
 * Returns { ok, message, landingUrl }.
 *
 * - If selectors are provided in cfg.login, they are used directly.
 * - Otherwise the username/password/submit elements are auto-detected.
 * - landingUrl is the URL the browser ends up on after a successful login
 *   (useful for starting a post-login crawl there).
 */
export async function login(context, cfg, log) {
  const { login: lc } = cfg;
  if (!lc || !lc.enabled) return { ok: false, message: 'login disabled', landingUrl: null };

  // loginUrl is optional: if the login is a popup on the site itself, fall back
  // to the site's base URL (the user clicks "Sign In" there).
  const entryUrl = lc.loginUrl || cfg.baseUrl;
  if (!entryUrl || !lc.username || !lc.password) {
    return {
      ok: false,
      message: 'login config incomplete (username/password required; and a URL to start from)',
      landingUrl: null,
    };
  }

  const auto = !lc.usernameSelector || !lc.passwordSelector || lc.autoDetect;

  const page = await context.newPage();
  try {
    log(`[auth] navigating to: ${entryUrl}`);
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: cfg.navTimeoutMs }).catch(() => {});

    // If no password field is visible yet, the login is likely behind a
    // "Sign In" button that opens a popup/modal. Click it to reveal the form.
    if (!(await hasVisiblePassword(page))) {
      const opened = await openLoginPopup(page, lc, log);
      if (opened) {
        // Wait for the popup/modal with a password field to appear.
        await page
          .locator('input[type=password]')
          .first()
          .waitFor({ state: 'visible', timeout: 8000 })
          .catch(() => {});
        await page.waitForTimeout(500);
      }
    }

    // Resolve selectors (use provided ones, else auto-detect).
    let userSel = lc.usernameSelector;
    let passSel = lc.passwordSelector;

    if (auto) {
      log('[auth] auto-detecting login fields...');
      passSel = (await firstVisible(page, PASSWORD_CANDIDATES)) || passSel;
      userSel = (await firstVisible(page, USERNAME_CANDIDATES)) || userSel;
    }

    if (!userSel || !passSel) {
      return {
        ok: false,
        message: `login failed: could not locate ${!userSel ? 'username/email' : ''}${!userSel && !passSel ? ' and ' : ''}${!passSel ? 'password' : ''} field. If login opens in a popup, make sure the "Sign In" trigger is clickable, or set selectors in Advanced.`,
        landingUrl: null,
      };
    }

    log(`[auth] filling username (${userSel}) and password (${passSel})`);
    await page.fill(userSel, lc.username);
    await page.fill(passSel, lc.password);

    // Tick any consent / terms / remember-me checkboxes (required by some forms).
    await checkConsentBoxes(page, log);

    // Resolve submit.
    let submitHandled = false;
    if (lc.submitSelector && !auto) {
      log('[auth] submitting via configured selector');
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: cfg.navTimeoutMs }).catch(() => {}),
        page.click(lc.submitSelector),
      ]);
      submitHandled = true;
    } else {
      const submit = await findSubmit(page);
      if (submit) {
        log('[auth] submitting login form (auto-detected submit)');
        await Promise.all([
          page.waitForLoadState('networkidle', { timeout: cfg.navTimeoutMs }).catch(() => {}),
          submit.kind === 'selector' ? page.click(submit.value) : submit.value.click(),
        ]);
        submitHandled = true;
      }
    }

    // Fallback: press Enter in the password field to submit.
    if (!submitHandled) {
      log('[auth] no submit button found; pressing Enter in password field');
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: cfg.navTimeoutMs }).catch(() => {}),
        page.press(passSel, 'Enter'),
      ]);
    }

    if (lc.waitAfterLoginMs) {
      await page.waitForTimeout(lc.waitAfterLoginMs);
    }

    const currentUrl = page.url();

    // Verify success.
    if (lc.successUrlIncludes) {
      const ok = currentUrl.includes(lc.successUrlIncludes);
      return {
        ok,
        landingUrl: ok ? currentUrl : null,
        message: ok
          ? `login success (landed on ${currentUrl})`
          : `login likely failed: expected URL to include "${lc.successUrlIncludes}" but got ${currentUrl}`,
      };
    }

    // Fallback heuristic: success if no visible password field remains AND the
    // URL changed from the login page.
    const stillHasPassword = await page
      .locator('input[type=password]')
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    const urlChanged = currentUrl.replace(/\/$/, '') !== entryUrl.replace(/\/$/, '');
    const ok = !stillHasPassword || urlChanged;

    return {
      ok,
      landingUrl: ok ? currentUrl : null,
      message: ok
        ? `login success (landed on ${currentUrl})`
        : 'login likely failed: still on login page with password field present',
    };
  } catch (err) {
    return { ok: false, message: `login error: ${err.message}`, landingUrl: null };
  } finally {
    await page.close().catch(() => {});
  }
}
