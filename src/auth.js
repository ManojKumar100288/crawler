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

  if (!lc.loginUrl || !lc.username || !lc.password) {
    return {
      ok: false,
      message: 'login config incomplete (loginUrl/username/password required)',
      landingUrl: null,
    };
  }

  const auto = !lc.usernameSelector || !lc.passwordSelector || lc.autoDetect;

  const page = await context.newPage();
  try {
    log(`[auth] navigating to login page: ${lc.loginUrl}`);
    await page.goto(lc.loginUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: cfg.navTimeoutMs }).catch(() => {});

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
        message: `login failed: could not locate ${!userSel ? 'username' : ''}${!userSel && !passSel ? ' and ' : ''}${!passSel ? 'password' : ''} field (try specifying selectors manually)`,
        landingUrl: null,
      };
    }

    log(`[auth] filling username (${userSel}) and password (${passSel})`);
    await page.fill(userSel, lc.username);
    await page.fill(passSel, lc.password);

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
    const urlChanged = currentUrl.replace(/\/$/, '') !== lc.loginUrl.replace(/\/$/, '');
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
