// Config loading + normalization for the QA crawler.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  baseUrl: null,
  maxPages: 100,
  maxDepth: 4,
  sameOriginOnly: true,
  includeSubdomains: false,
  concurrency: 3,
  navTimeoutMs: 30000,
  slowPageMs: 5000,
  headless: true,
  ignorePatterns: [
    '\\.(pdf|zip|jpg|jpeg|png|gif|svg|webp|mp4|mp3|css|js|ico|woff2?)($|\\?)',
    '/logout',
    '/signout',
    'mailto:',
    'tel:',
    // OAuth / SSO / auth-redirect endpoints are not meant to be hit directly;
    // hitting them returns 5xx/redirect errors that are false positives.
    '/oauth',
    '/authorize',
    '/auth/realms',
    'response_type=',
    'redirect_uri=',
  ],
  checkExternalLinks: true,
  useSitemap: true,
  fullSite: false,
  // scanMode: 'full' (crawl whole site) | 'headerFooterHome' (only home page +
  // its header/footer links).
  scanMode: 'full',
  // AI-powered report summary (optional). Disabled unless an API key is set.
  ai: {
    enabled: false,
    apiKey: null,
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
  },
  login: {
    enabled: false,
    loginUrl: null,
    usernameSelector: '#username',
    passwordSelector: '#password',
    submitSelector: 'button[type=submit]',
    username: null,
    password: null,
    successUrlIncludes: null,
    waitAfterLoginMs: 2000,
  },
  outputDir: './reports',
};

function deepMerge(base, override) {
  const out = { ...base };
  for (const key of Object.keys(override || {})) {
    const val = override[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      out[key] = deepMerge(base[key] || {}, val);
    } else if (val !== undefined) {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Build the effective config from a config file and CLI overrides.
 * @param {object} opts
 * @param {string|null} opts.configPath - path to a JSON config file (optional)
 * @param {object} opts.cliOverrides - values parsed from CLI flags
 * @returns {object} normalized config
 */
export function loadConfig({ configPath = null, cliOverrides = {} } = {}) {
  let fileConfig = {};
  if (configPath) {
    const resolved = path.resolve(configPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    fileConfig = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  }

  let cfg = deepMerge(DEFAULTS, fileConfig);
  cfg = deepMerge(cfg, cliOverrides);

  if (!cfg.baseUrl) {
    throw new Error('baseUrl is required (pass a URL as the first argument or set it in the config file).');
  }

  // Normalize baseUrl and derive origin info.
  const u = new URL(cfg.baseUrl);
  cfg.origin = u.origin;
  cfg.hostname = u.hostname;
  cfg.rootDomain = u.hostname.split('.').slice(-2).join('.');

  cfg.ignoreRegexes = (cfg.ignorePatterns || []).map((p) => new RegExp(p, 'i'));

  // "Full site" mode: check ALL URLs. Raise limits and force sitemap use,
  // unless the caller explicitly set higher values already.
  if (cfg.fullSite) {
    cfg.useSitemap = true;
    if (!cliOverrides.maxPages && (!fileConfig || fileConfig.maxPages === undefined)) {
      cfg.maxPages = Math.max(cfg.maxPages, 10000);
    }
    if (!cliOverrides.maxDepth && (!fileConfig || fileConfig.maxDepth === undefined)) {
      cfg.maxDepth = Math.max(cfg.maxDepth, 50);
    }
  }

  return cfg;
}

export { DEFAULTS };
