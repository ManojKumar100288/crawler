// Optional login flow so the crawler can reach post-login (authenticated) pages.

/**
 * Perform a form login in the given browser context.
 * Returns { ok: boolean, message: string }.
 *
 * Strategy:
 *  1. Navigate to loginUrl.
 *  2. Fill username + password using the configured selectors.
 *  3. Click submit and wait for navigation / success indicator.
 *  4. Verify success via successUrlIncludes (if provided) or by absence of the login form.
 */
export async function login(context, cfg, log) {
  const { login: lc } = cfg;
  if (!lc || !lc.enabled) return { ok: false, message: 'login disabled' };

  if (!lc.loginUrl || !lc.username || !lc.password) {
    return { ok: false, message: 'login config incomplete (loginUrl/username/password required)' };
  }

  const page = await context.newPage();
  try {
    log(`[auth] navigating to login page: ${lc.loginUrl}`);
    await page.goto(lc.loginUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });

    await page.waitForSelector(lc.usernameSelector, { timeout: cfg.navTimeoutMs });
    await page.fill(lc.usernameSelector, lc.username);
    await page.fill(lc.passwordSelector, lc.password);

    log('[auth] submitting login form');
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: cfg.navTimeoutMs }).catch(() => {}),
      page.click(lc.submitSelector),
    ]);

    if (lc.waitAfterLoginMs) {
      await page.waitForTimeout(lc.waitAfterLoginMs);
    }

    const currentUrl = page.url();

    // Verify success.
    if (lc.successUrlIncludes) {
      const ok = currentUrl.includes(lc.successUrlIncludes);
      return {
        ok,
        message: ok
          ? `login success (landed on ${currentUrl})`
          : `login likely failed: expected URL to include "${lc.successUrlIncludes}" but got ${currentUrl}`,
      };
    }

    // Fallback: consider login successful if the password field is gone.
    const stillHasPassword = await page.$(lc.passwordSelector);
    return {
      ok: !stillHasPassword,
      message: stillHasPassword
        ? 'login likely failed: password field still present'
        : `login success (landed on ${currentUrl})`,
    };
  } catch (err) {
    return { ok: false, message: `login error: ${err.message}` };
  } finally {
    await page.close().catch(() => {});
  }
}
