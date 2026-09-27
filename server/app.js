// Application composition root: wires services together and handles HTTP requests.
import http from 'node:http';
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { openDb, now } from './db.js';
import { Git } from './git.js';
import { Indexer } from './indexer.js';
import { Ontology, DEFAULT_ONTOLOGY, ONTOLOGY_PATH } from './ontology.js';
import { makeEmbedder } from './embed.js';
import { Users } from './auth.js';
import { Perms } from './perms.js';
import { Pages } from './pages.js';
import { Renderer } from './render.js';
import { Search } from './search.js';
import { Notify, Events } from './notify.js';
import { Graph } from './graph.js';
import { GraphRag } from './graphrag.js';
import { Health } from './health.js';
import { Sync } from './sync.js';
import { Oidc } from './oidc.js';
import { Mailer } from './mailer.js';
import { Router, parseCookies, readBody, send, staticServer } from './http.js';
import YAML from 'yaml';
import registerRoutes from './api/index.js';

export const SESSION_COOKIE = 'gw_sid';
export const CSRF_HEADER = 'x-gitwiki-csrf';

export class Settings {
  constructor(db) { this.db = db; this.cache = new Map(); }
  get(key, def) {
    if (this.cache.has(key)) return this.cache.get(key) ?? def;
    const r = this.db.get('SELECT value FROM settings WHERE key = ?', key);
    const v = r ? JSON.parse(r.value) : undefined;
    this.cache.set(key, v);
    return v ?? def;
  }
  set(key, value) {
    this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value ?? null));
    this.cache.set(key, value);
  }
  all() { return Object.fromEntries(this.db.all('SELECT key, value FROM settings').map(r => [r.key, JSON.parse(r.value)])); }

  /**
   * Feature flags with A/B rollout: {enabled, rollout: 0-100, groups: [..]}. A user is in the
   * treatment if the flag is enabled and (in a targeted group, or hash(flag+user) < rollout).
   */
  flag(name, user, app) {
    const f = (this.get('flags', {}) || {})[name];
    if (!f) return DEFAULT_FLAGS[name]?.enabled ?? false;
    if (!f.enabled) return false;
    if (f.rollout === undefined || f.rollout >= 100) return true;
    if (user && f.groups && f.groups.length && app) {
      const gs = app.perms.groupNames(user);
      if (f.groups.some(g => gs.includes(g.toLowerCase()))) return true;
    }
    const key = `${name}:${user ? user.id : 'anon'}`;
    const bucket = parseInt(crypto.createHash('sha1').update(key).digest('hex').slice(0, 8), 16) % 100;
    return bucket < f.rollout;
  }
}

export const DEFAULT_FLAGS = {
  'search.graph_boost': { enabled: true, description: 'Boost search ranking with link-graph centrality and recency.' },
  'graphrag.answer': { enabled: true, description: 'Synthesize answers with the configured LLM on the Ask page.' },
  'editor.slash_menu': { enabled: true, description: 'Slash-command menu in the editor.' },
};

const DEFAULT_TEMPLATES = {
  'meeting-notes': `---\nname: Meeting notes\ndescription: Agenda, attendees, decisions and action items.\ntype: Meeting\ntags:\n  - meeting\n---\n\n## Date\n\n{{date}}\n\n## Attendees\n\n- @{{username}}\n\n## Agenda\n\n1. \n\n## Decisions\n\n> [!success] Decision\n> \n\n## Action items\n\n- [ ] \n`,
  'how-to': `---\nname: How-to guide\ndescription: Step-by-step instructions for a task.\ntype: HowTo\ntags:\n  - how-to\n---\n\n> [!info] Summary\n> What this guide helps you do.\n\n## Prerequisites\n\n- \n\n## Steps\n\n1. \n2. \n\n## Troubleshooting\n\n\`\`\`toc\n\`\`\`\n`,
  'decision-record': `---\nname: Decision record\ndescription: Architecture / business decision record (ADR).\ntype: Decision\ntags:\n  - decision\ndecision_status: proposed\n---\n\n## Context\n\n## Options considered\n\n| Option | Pros | Cons |\n| --- | --- | --- |\n|  |  |  |\n\n## Decision\n\n{{status:blue|PROPOSED}}\n\n## Consequences\n`,
  'runbook': `---\nname: Runbook\ndescription: Operational procedure for a system or incident.\ntype: Process\ntags:\n  - runbook\nowner: ""\n---\n\n> [!warning] When to use\n> Describe the trigger for this runbook.\n\n## Procedure\n\n- [ ] Step one\n\n## Escalation\n\n## Related\n\n\`\`\`query\ntag:#runbook\n\`\`\`\n`,
  'system': `---\nname: System / service\ndescription: Document a system with owner, dependencies and lifecycle.\ntype: System\ntags:\n  - system\nlifecycle: active\n---\n\n## Overview\n\nowner:: \ndepends_on:: \n\n## Architecture\n\n\`\`\`mermaid\ngraph LR\n  A[Client] --> B[{{title}}]\n\`\`\`\n\n## Operations\n`,
};

export async function createApp(overrides = {}) {
  const cfg = loadConfig(overrides);
  const app = { cfg, pending: new Set() };
  app.db = openDb(cfg.dbFile);
  app.settings = new Settings(app.db);
  app.git = new Git(cfg.repoDir, { committerName: cfg.committerName, committerEmail: cfg.committerEmail });
  const seed = { [ONTOLOGY_PATH]: YAML.stringify(DEFAULT_ONTOLOGY, { lineWidth: 0 }),
    'README.md': '# Knowledge base\n\nThis repository is managed by GitWiki. Pages live under `spaces/<KEY>/` as Markdown with YAML frontmatter.\nYou can edit them here directly; GitWiki merges your changes automatically.\n' };
  for (const [k, v] of Object.entries(DEFAULT_TEMPLATES)) seed[`_system/templates/${k}.md`] = v;
  await app.git.init(seed);
  app.audit = (user, action, target, details, ip) => {
    app.db.run('INSERT INTO audit (ts, user_id, username, action, target, details, ip) VALUES (?,?,?,?,?,?,?)',
      now(), user ? user.id : null, user ? user.username : 'system', action, target == null ? null : String(target), details ? JSON.stringify(details) : null, ip || null);
  };
  app.reloadOntology = async () => {
    const text = await app.git.readFile(ONTOLOGY_PATH);
    try { app.ontology = text ? Ontology.parse(text) : new Ontology(); } catch { app.ontology = app.ontology || new Ontology(); }
    return app.ontology;
  };
  await app.reloadOntology();
  app.embedder = makeEmbedder(app.settings.get('embedding', { provider: 'local' }));
  app.users = new Users(app);
  app.perms = new Perms(app);
  app.indexer = new Indexer(app);
  app.search = new Search(app);
  app.renderer = new Renderer(app);
  app.notify = new Notify(app);
  app.events = new Events(app);
  app.pages = new Pages(app);
  app.graph = new Graph(app);
  app.graphrag = new GraphRag(app);
  app.health = new Health(app);
  app.sync = new Sync(app);
  app.oidc = new Oidc(app);
  app.mailer = new Mailer(app);
  app.flag = (name, user) => app.settings.flag(name, user, app);

  // bootstrap admin account on first run
  if (!app.db.get('SELECT 1 FROM users LIMIT 1')) {
    const pw = cfg.adminPassword || crypto.randomBytes(9).toString('base64url');
    app.users.create({ username: cfg.adminUser, password: pw, name: 'Administrator', role: 'admin', email: null });
    if (!cfg.adminPassword && !cfg.quiet) console.log(`\n  Created admin account: ${cfg.adminUser} / ${pw}\n  (set GITWIKI_ADMIN_PASSWORD to choose it)\n`);
    app.settings.set('site_name', 'GitWiki');
  }
  // (re)build derived index if empty or stale relative to HEAD
  const head = await app.git.head();
  if (app.settings.get('indexed_head') !== head || !app.db.get('SELECT 1 FROM pages LIMIT 1')) {
    await app.indexer.rebuild();
    app.settings.set('indexed_head', head);
  }

  const router = new Router();
  registerRoutes(router, app);
  const serveStatic = staticServer(cfg.webDir);

  app.authenticate = (req) => {
    const auth = req.headers.authorization || '';
    if (/^Bearer\s+/i.test(auth)) return { user: app.users.userForApiToken(auth.replace(/^Bearer\s+/i, '').trim()), via: 'token' };
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return { user: sid ? app.users.userForSession(sid) : null, via: sid ? 'cookie' : null, sid };
  };

  app.handle = async (req, res) => {
    const t0 = performance.now();
    const url = new URL(req.url, 'http://x');
    const ip = req.socket.remoteAddress;
    if (!cfg.quiet && cfg.logLevel !== 'silent' && (url.pathname.startsWith('/api/') || url.pathname === '/mcp' || cfg.logLevel === 'debug')) {
      res.on('finish', () => {
        const who = res.gwUser;
        process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: res.statusCode >= 500 ? 'error' : 'info', method: req.method,
          path: url.pathname, status: res.statusCode, ms: Math.round((performance.now() - t0) * 10) / 10, user: who || null, ip }) + '\n');
      });
    }
    try {
      const m = router.match(req.method, url.pathname);
      if (!m) {
        if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/') && serveStatic(req, res, url.pathname)) return;
        return send(res, 404, { error: 'Not found' });
      }
      if (m.methodNotAllowed) return send(res, 405, { error: 'Method not allowed' });
      const { user, via, sid } = app.authenticate(req);
      res.gwUser = user ? user.username : null;
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (mutating && via === 'cookie' && !m.route.opts.noCsrf && req.headers[CSRF_HEADER] !== '1') {
        return send(res, 403, { error: 'Missing CSRF header' });
      }
      if (app.settings.get('maintenance', false) && mutating && !(user && user.role === 'admin') && !m.route.opts.public) {
        return send(res, 503, { error: 'The knowledge base is in maintenance mode (read-only).' });
      }
      let bodyBuf = null;
      const ctx = {
        app, req, res, user, ip, sid, via, params: m.route && m.params, query: Object.fromEntries(url.searchParams), url,
        async raw(limit) { if (!bodyBuf) bodyBuf = await readBody(req, limit); return bodyBuf; },
        async json() {
          const b = await this.raw();
          if (!b.length) return {};
          try { return JSON.parse(b.toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
        },
        send: (status, body, headers) => send(res, status, body, headers),
      };
      ctx.params = m.params;
      if (m.route.opts.auth && !user) return send(res, 401, { error: 'Login required' });
      const out = await m.route.handler(ctx);
      if (!res.headersSent && !res.writableEnded && out !== undefined) send(res, 200, out, { 'server-timing': `app;dur=${(performance.now() - t0).toFixed(1)}` });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500 && !cfg.quiet) console.error(e);
      if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Internal server error' : e.message, ...(e.errors ? { errors: e.errors } : {}) });
      else res.end();
    }
  };

  app.server = http.createServer((req, res) => { app.handle(req, res); });
  app.server.keepAliveTimeout = 65000;
  app.listen = (port = cfg.port, host = cfg.host) => new Promise((resolve) => app.server.listen(port, host, () => {
    app.port = app.server.address().port;
    app.url = `http://${host}:${app.port}`;
    if (!cfg.baseUrl) cfg.baseUrl = app.url;
    resolve(app);
  }));
  // background jobs
  app.sync.start();
  app.mailer.start();
  const daily = setInterval(() => { try { app.health.remindReviews(); app.db.run('DELETE FROM sessions WHERE expires_at < ?', now()); } catch {} }, 6 * 3600_000);
  daily.unref();
  app.close = async () => {
    clearInterval(daily);
    app.sync.stop();
    app.mailer.stop();
    app.notify.closeAll();
    await Promise.allSettled([...app.pending]);
    const closed = new Promise(r => app.server.close(() => r()));
    app.server.closeAllConnections?.();
    await closed;
    app.db.close();
  };
  return app;
}
