import path from 'node:path';
import fs from 'node:fs';

export function loadConfig(overrides = {}) {
  const env = process.env;
  const dataDir = path.resolve(overrides.dataDir || env.GITWIKI_DATA || './data');
  const cfg = {
    dataDir,
    repoDir: path.join(dataDir, 'repo'),
    dbFile: path.join(dataDir, 'gitwiki.db'),
    port: Number(overrides.port ?? env.PORT ?? 3000),
    host: overrides.host || env.HOST || '127.0.0.1',
    baseUrl: overrides.baseUrl || env.GITWIKI_BASE_URL || null,
    adminUser: overrides.adminUser || env.GITWIKI_ADMIN_USER || 'admin',
    adminPassword: overrides.adminPassword || env.GITWIKI_ADMIN_PASSWORD || null,
    secureCookies: (overrides.secureCookies ?? env.GITWIKI_SECURE_COOKIES) === true || env.GITWIKI_SECURE_COOKIES === '1',
    sessionTtlHours: Number(env.GITWIKI_SESSION_HOURS || 24 * 7),
    committerName: env.GITWIKI_COMMITTER_NAME || 'GitWiki',
    committerEmail: env.GITWIKI_COMMITTER_EMAIL || 'gitwiki@localhost',
    syncIntervalSec: Number(overrides.syncIntervalSec ?? env.GITWIKI_SYNC_INTERVAL ?? 60),
    webDir: path.resolve(overrides.webDir || new URL('../web/dist', import.meta.url).pathname),
    logLevel: overrides.logLevel || env.GITWIKI_LOG || 'info',
    quiet: overrides.quiet ?? false,
    ...overrides.extra,
  };
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}
