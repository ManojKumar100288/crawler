// URL helpers: normalization, scoping, and filtering.

/**
 * Normalize a URL for dedupe: strip hash, sort query params, drop trailing slash.
 * Returns null if the URL is not http(s) or cannot be parsed.
 */
export function normalizeUrl(rawUrl, baseUrl) {
  if (!rawUrl) return null;
  let u;
  try {
    u = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hash = '';

  // Sort search params for stable dedupe.
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);

  let out = u.toString();
  // Drop a single trailing slash (but keep root "/").
  if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1);
  return out;
}

/**
 * Decide whether a URL is in-scope for crawling (same origin/subdomain rules).
 */
export function isInScope(url, cfg) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // Extra origins (e.g. a post-login dashboard on a different host) are always in scope.
  if (cfg.extraOrigins && cfg.extraOrigins.includes(u.origin)) {
    return true;
  }
  if (cfg.sameOriginOnly && !cfg.includeSubdomains) {
    return u.origin === cfg.origin;
  }
  if (cfg.includeSubdomains) {
    const root = u.hostname.split('.').slice(-2).join('.');
    return root === cfg.rootDomain;
  }
  return u.origin === cfg.origin;
}

/**
 * Should this URL be skipped entirely based on ignore patterns?
 */
export function isIgnored(url, cfg) {
  return (cfg.ignoreRegexes || []).some((re) => re.test(url));
}

/**
 * Classify a link as internal (in-scope) or external.
 */
export function classifyLink(url, cfg) {
  if (isInScope(url, cfg)) return 'internal';
  return 'external';
}
