// Thin, fast wrapper around the git CLI. All mutations go through a single serial queue so
// concurrent requests never race on the index; reads come straight from the working tree.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export class Git {
  constructor(dir, { committerName = 'GitWiki', committerEmail = 'gitwiki@localhost' } = {}) {
    this.dir = dir;
    this.committer = { name: committerName, email: committerEmail };
    this._queue = Promise.resolve();
  }

  run(args, { input, allowFail = false, env = {}, maxBuffer = 256 * 1024 * 1024, encoding = 'utf8' } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile('git', ['-c', 'core.quotepath=off', '-c', 'commit.gpgsign=false', ...args], {
        cwd: this.dir, maxBuffer, encoding,
        env: {
          ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
          GIT_COMMITTER_NAME: this.committer.name, GIT_COMMITTER_EMAIL: this.committer.email, ...env,
        },
      }, (err, stdout, stderr) => {
        if (err && !allowFail) {
          const e = new Error(`git ${args[0]} failed: ${(stderr || err.message).toString().trim()}`);
          e.code = err.code; e.stderr = stderr; e.stdout = stdout;
          return reject(e);
        }
        resolve(allowFail ? { ok: !err, code: err ? err.code : 0, stdout, stderr } : stdout);
      });
      if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    });
  }

  /** Serialise a unit of work that mutates the repository. */
  exclusive(fn) {
    const p = this._queue.then(fn, fn);
    this._queue = p.catch(() => {});
    return p;
  }

  async init(seedFiles = {}) {
    await fs.mkdir(this.dir, { recursive: true });
    if (!fsSync.existsSync(path.join(this.dir, '.git'))) {
      await this.run(['init', '-q', '-b', 'main']);
      await this.run(['config', 'user.name', this.committer.name]);
      await this.run(['config', 'user.email', this.committer.email]);
      const writes = Object.entries(seedFiles).map(([p, content]) => ({ path: p, content }));
      await this.commit({ writes, message: 'Initialise knowledge base', author: this.committer });
    }
  }

  abs(p) {
    const full = path.resolve(this.dir, p);
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) throw new Error('path escapes repository');
    return full;
  }

  async readFile(p, enc = 'utf8') {
    try { return await fs.readFile(this.abs(p), enc); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  exists(p) { return fsSync.existsSync(this.abs(p)); }

  /**
   * Commit a set of changes atomically. writes: [{path, content}], deletes: [path],
   * renames: [[from, to]]. Returns the new commit sha (or current HEAD if nothing changed).
   */
  commit({ writes = [], deletes = [], renames = [], message, author, date }) {
    return this.exclusive(() => this._commit({ writes, deletes, renames, message, author, date }));
  }

  async _commit({ writes = [], deletes = [], renames = [], message, author, date }) {
    const touched = [];
    for (const [from, to] of renames) {
      await fs.mkdir(path.dirname(this.abs(to)), { recursive: true });
      await this.run(['mv', '-k', '--', from, to]);
      touched.push(to);
    }
    for (const w of writes) {
      const full = this.abs(w.path);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, w.content);
      touched.push(w.path);
    }
    for (const d of deletes) {
      try { await fs.rm(this.abs(d), { recursive: true, force: true }); } catch {}
      touched.push(d);
    }
    if (!touched.length) return this.head();
    await this.run(['add', '-A', '--', ...new Set(touched)]);
    const st = await this.run(['diff', '--cached', '--quiet'], { allowFail: true });
    if (st.ok) return this.head(); // no actual change
    const a = author || this.committer;
    const env = {};
    if (date) { env.GIT_AUTHOR_DATE = date; env.GIT_COMMITTER_DATE = date; }
    await this.run(['commit', '-q', '--no-verify', '-m', message || 'Update', `--author=${a.name} <${a.email}>`], { env });
    return this.head();
  }

  async head() {
    const r = await this.run(['rev-parse', 'HEAD'], { allowFail: true });
    return r.ok ? r.stdout.trim() : null;
  }

  async show(rev, p, enc = 'utf8') {
    const r = await this.run(['show', `${rev}:${p}`], { allowFail: true, encoding: enc });
    return r.ok ? r.stdout : null;
  }

  async lastRev(p) {
    const out = await this.run(['log', '-1', '--format=%H', '--', p]);
    return out.trim() || null;
  }

  /**
   * History of a page file, following renames deterministically: a rename is followed only
   * when the file deleted in the same commit carries the same frontmatter id.
   */
  async pageLog(p, id, { limit = 500 } = {}) {
    const out = [];
    let path = p, until = 'HEAD', guard = 0;
    while (path && guard++ < 50 && out.length < limit) {
      const raw = await this.run(['log', `-n${limit}`, '--no-renames', '--format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%s', '--name-status', until, '--', path], { allowFail: true });
      if (!raw.ok) break;
      const recs = raw.stdout.split('\x1e').filter(s => s.trim()).map(rec => {
        const [meta, ...lines] = rec.split('\n');
        const [rev, author, email, date, message] = meta.split('\x1f');
        const st = (lines.find(l => l.endsWith('\t' + path)) || '').split('\t')[0];
        return { rev, author, email, date, message, path, status: st };
      });
      if (!recs.length) break;
      out.push(...recs);
      const oldest = recs[recs.length - 1];
      if (oldest.status !== 'A') break;
      const touched = (await this.run(['show', '--no-renames', '--name-status', '--format=', oldest.rev])).split('\n').filter(l => l.startsWith('D\t')).map(l => l.slice(2));
      let prev = null;
      for (const d of touched) {
        const txt = await this.show(oldest.rev + '^', d);
        if (txt && new RegExp('^id: ' + id.replace(/[^\w-]/g, '') + '$', 'm').test(txt)) { prev = d; break; }
      }
      if (!prev) break;
      path = prev; until = oldest.rev + '^';
    }
    return out.slice(0, limit);
  }

  /** History of a file (follows renames by similarity). */
  async log(p, { limit = 200, follow = true } = {}) {
    const args = ['log', `-n${limit}`, '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e'];
    if (follow) args.push('--follow', '--name-only');
    args.push('--', p);
    const out = await this.run(args);
    return out.split('\x1e').map(s => s.trim()).filter(Boolean).map(rec => {
      const [meta, ...files] = rec.split('\n');
      const [rev, author, email, date, message] = meta.split('\x1f');
      return { rev, author, email, date, message, path: files.map(f => f.trim()).filter(Boolean).pop() || p };
    });
  }

  /** Recent commits across the repo with changed paths. */
  async activity({ limit = 50, pathspec = 'spaces' } = {}) {
    const out = await this.run(['log', `-n${limit}`, '--name-status', '--format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%s', '--', pathspec]);
    return out.split('\x1e').filter(s => s.trim()).map(rec => {
      const [meta, ...lines] = rec.split('\n');
      const [rev, author, email, date, message] = meta.split('\x1f');
      const files = lines.filter(Boolean).map(l => { const [status, ...ps] = l.split('\t'); return { status, path: ps[ps.length - 1] }; });
      return { rev, author, email, date, message, files };
    });
  }

  async diffNames(from, to) {
    const out = await this.run(['diff', '--name-status', '-M', from, to]);
    return out.split('\n').filter(Boolean).map(l => {
      const [status, a, b] = l.split('\t');
      return { status: status[0], path: b || a, oldPath: b ? a : null };
    });
  }

  /** Locate the path of the file with frontmatter `id: <id>` at a given revision. */
  async findPathById(rev, id) {
    const r = await this.run(['grep', '-l', '-F', '-e', `id: ${id}`, rev, '--', 'spaces'], { allowFail: true });
    if (!r.ok) return null;
    const line = r.stdout.split('\n').find(Boolean);
    return line ? line.slice(rev.length + 1) : null;
  }

  async listFiles(prefix = '') {
    const out = await this.run(['ls-files', '-z', '--', prefix || '.']);
    return out.split('\0').filter(Boolean);
  }
}
