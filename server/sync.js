// Two-way sync with a GitHub (or any git) remote. Remote commits are merged file-by-file with
// the same silent merge engine used for concurrent UI edits: no conflict markers ever land in
// the repository. On true conflicts the newer commit wins and the loser is recorded for KM.
import { mergeDocument } from './merge.js';
import { splitFrontmatter, joinFrontmatter } from '../shared/doc.js';
import { classifyPath } from './indexer.js';
import { newId } from './pages.js';
import { now } from './db.js';

export class Sync {
  constructor(app) {
    this.app = app;
    this.status = { configured: false, lastSync: null, lastError: null, ahead: 0, behind: 0, running: false, lastResult: null };
    this._pushTimer = null;
    this._interval = null;
  }
  get git() { return this.app.git; }
  get conf() { return this.app.settings.get('git_remote', null); }

  gitArgsAuth() {
    const c = this.conf;
    if (!c || !c.token) return [];
    const basic = Buffer.from(`x-access-token:${c.token}`).toString('base64');
    return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
  }

  async configure(conf) {
    if (conf && conf.url && !/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(conf.url)) throw Object.assign(new Error('Unsupported remote URL'), { status: 400 });
    this.app.settings.set('git_remote', conf && conf.url ? { url: conf.url, branch: conf.branch || 'main', token: conf.token || null, autoPush: conf.autoPush !== false, interval: conf.interval ?? 60 } : null);
    await this.git.exclusive(async () => {
      const has = await this.git.run(['remote', 'get-url', 'origin'], { allowFail: true });
      if (conf && conf.url) await this.git.run(has.ok ? ['remote', 'set-url', 'origin', conf.url] : ['remote', 'add', 'origin', conf.url]);
      else if (has.ok) await this.git.run(['remote', 'remove', 'origin']);
    });
    this.start();
    return this.publicStatus();
  }

  publicStatus() {
    const c = this.conf;
    return { ...this.status, configured: !!c, remote: c ? { url: c.url, branch: c.branch, autoPush: c.autoPush, interval: c.interval, hasToken: !!c.token } : null };
  }

  start() {
    clearInterval(this._interval);
    const c = this.conf;
    if (c && c.interval > 0) { this._interval = setInterval(() => this.syncNow().catch(() => {}), c.interval * 1000); this._interval.unref?.(); }
  }
  stop() { clearInterval(this._interval); clearTimeout(this._pushTimer); }

  schedulePush() {
    const c = this.conf;
    if (!c || !c.autoPush) return;
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this.syncNow().catch(() => {}), 1500);
    this._pushTimer.unref?.();
  }

  async syncNow({ user = null } = {}) {
    const c = this.conf;
    if (!c) return { skipped: true, reason: 'No remote configured' };
    if (this.status.running) return this._current;
    this.status.running = true;
    this._current = this.app.pages.withLock(() => this.git.exclusive(() => this._sync(c, user))).then((r) => {
      Object.assign(this.status, { lastSync: now(), lastError: null, lastResult: r });
      return r;
    }, (e) => { this.status.lastError = e.message; throw e; }).finally(() => { this.status.running = false; });
    return this._current;
  }

  async _sync(c, user) {
    const git = this.git;
    const auth = this.gitArgsAuth();
    const branch = c.branch || 'main';
    const result = { fetched: false, merged: false, fastForward: false, pushed: false, changed: [], conflicts: 0, normalized: 0 };
    const f = await git.run([...auth, 'fetch', '-q', 'origin', branch], { allowFail: true });
    const remoteRef = `refs/remotes/origin/${branch}`;
    const remoteRev = f.ok ? (await git.run(['rev-parse', remoteRef], { allowFail: true })).stdout?.trim() : null;
    if (!f.ok && !/couldn't find remote ref|not found/i.test(f.stderr || '')) throw new Error('fetch failed: ' + (f.stderr || '').trim());
    result.fetched = !!remoteRev;
    const local = await git.head();
    if (remoteRev && remoteRev !== local) {
      const mb = (await git.run(['merge-base', local, remoteRev], { allowFail: true })).stdout?.trim() || null;
      if (mb === remoteRev) { /* only ahead */ }
      else if (mb === local) {
        await git.run(['merge', '-q', '--ff-only', remoteRev]);
        result.fastForward = true;
        result.changed = await git.diffNames(local, remoteRev);
      } else {
        result.merged = true;
        result.conflicts = await this.mergeDiverged(local, remoteRev, mb);
        result.changed = await git.diffNames(local, 'HEAD');
      }
      if (result.changed.length) result.normalized = await this.normalize(result.changed.map(ch => ch.path));
      for (const ch of result.changed) {
        if (ch.oldPath) this.app.indexer.removePath(ch.oldPath);
        if (ch.status === 'D') this.app.indexer.removePath(ch.path);
      }
      const commits = await this.app.indexer.lastCommits();
      for (const ch of result.changed) if (ch.status !== 'D') await this.app.indexer.indexPath(ch.path, null, commits.get(ch.path));
      if (result.changed.some(ch => ch.path === '_system/ontology.yml')) await this.app.reloadOntology();
      this.app.notify.broadcast('sync', { changed: result.changed.length });
    }
    if (c.autoPush !== false) {
      const head = await git.head();
      if (head !== remoteRev) {
        const p = await git.run([...auth, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { allowFail: true });
        if (!p.ok) throw new Error('push failed: ' + (p.stderr || '').trim());
        result.pushed = true;
      }
    }
    const counts = remoteRev ? (await git.run(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`], { allowFail: true })).stdout : null;
    if (counts) { const [a, b] = counts.trim().split(/\s+/).map(Number); this.status.ahead = a; this.status.behind = b; }
    this.app.audit(user, 'git.sync', null, result);
    return result;
  }

  async mergeDiverged(local, remote, base) {
    const git = this.git;
    const m = await git.run(['merge', '--no-ff', '--no-commit', '-q', remote], { allowFail: true });
    let conflicts = 0;
    if (!m.ok) {
      const un = (await git.run(['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
      for (const p of un) {
        const b = await git.show(':1', p), o = await git.show(':2', p), t = await git.show(':3', p);
        const lt = Number((await git.run(['log', '-1', '--format=%ct', local, '--', p])).trim() || 0);
        const rt = Number((await git.run(['log', '-1', '--format=%ct', remote, '--', p])).trim() || 0);
        const prefer = rt > lt ? 'theirs' : 'ours';
        if (o == null || t == null) {
          // modify/delete: keep the surviving modification
          const keep = o ?? t;
          await git.run(['checkout', o != null ? '--ours' : '--theirs', '--', p], { allowFail: true });
          if (keep != null) { await (await import('node:fs/promises')).writeFile(git.abs(p), keep); await git.run(['add', '--', p]); }
          continue;
        }
        if (!/\.(md|ya?ml|txt|json)$/i.test(p)) {
          await git.run(['checkout', prefer === 'ours' ? '--ours' : '--theirs', '--', p]);
          await git.run(['add', '--', p]);
          continue;
        }
        const res = mergeDocument(b ?? '', o, t, { prefer });
        await (await import('node:fs/promises')).writeFile(git.abs(p), res.text);
        await git.run(['add', '--', p]);
        if (res.conflicts.length) {
          conflicts++;
          const c = classifyPath(p);
          const id = c && c.kind !== 'space' ? String(splitFrontmatter(res.text).data.id || '') : null;
          this.app.db.run(`INSERT INTO conflicts (page_id, path, created_at, user_id, source, base_rev, merged_rev, details, status) VALUES (?,?,?,?,?,?,?,?,?)`,
            id, p, now(), null, 'sync', base, null, JSON.stringify({ conflicts: res.conflicts, prefer, local, remote }), 'open');
        }
      }
    }
    await git.run(['commit', '-q', '--no-verify', '-m', `Merge remote changes (auto-resolved${conflicts ? `, ${conflicts} overlapping edit(s) recorded` : ''})`,
      `--author=${git.committer.name} <${git.committer.email}>`], { allowFail: true });
    return conflicts;
  }

  /** Give pages added directly through git a stable id + title so the CMS can track them. */
  async normalize(paths) {
    const writes = [];
    for (const p of paths) {
      const c = classifyPath(p);
      if (!c || c.kind === 'space') continue;
      const text = await this.git.readFile(p);
      if (text == null) continue;
      const { data, body } = splitFrontmatter(text);
      if (data.id) continue;
      const h1 = /^#[ \t]+(.+)$/m.exec(body);
      writes.push({ path: p, content: joinFrontmatter({ ...data, id: newId(), title: data.title || (h1 ? h1[1].trim() : c.slug.replace(/[-_]+/g, ' ')), created: data.created || now() }, body) });
    }
    if (writes.length) await this.git._commit({ writes, message: `Normalise metadata for ${writes.length} page(s) added via git`, author: this.git.committer });
    return writes.length;
  }
}
