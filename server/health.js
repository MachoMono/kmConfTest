// Content-health report for the Knowledge Management team.
export class Health {
  constructor(app) { this.app = app; }
  get db() { return this.app.db; }

  report({ staleDays } = {}) {
    const db = this.db;
    const stale = Number(staleDays ?? this.app.settings.get('stale_days', 180));
    const cutoff = new Date(Date.now() - stale * 86400_000).toISOString();
    const today = new Date().toISOString().slice(0, 10);
    const pages = db.all('SELECT * FROM pages WHERE archived = 0');
    const homes = new Set(db.all('SELECT home_id FROM spaces').map(r => r.home_id));
    const inbound = new Map(db.all("SELECT target_id, COUNT(*) AS n FROM links WHERE target_id IS NOT NULL AND kind != 'mention' GROUP BY target_id").map(r => [r.target_id, r.n]));
    const pick = (p) => ({ id: p.id, title: p.title, space: p.space, updated_at: p.updated_at, updated_by: p.updated_by, type: p.type, owner: p.owner, review_by: p.review_by });

    const orphans = pages.filter(p => !homes.has(p.id) && !p.parent && !inbound.get(p.id) && p.kind === 'page').map(pick);
    const broken = db.all(`SELECT l.src, l.target, l.kind, p.title, p.space FROM links l JOIN pages p ON p.id = l.src
      WHERE l.target_id IS NULL AND l.kind != 'mention' AND p.archived = 0 ORDER BY p.title`)
      .map(r => ({ page: r.src, title: r.title, space: r.space, target: r.target, kind: r.kind }));
    const staleList = pages.filter(p => p.updated_at && p.updated_at < cutoff).map(pick);
    const reviewDue = pages.filter(p => p.review_by && p.review_by <= today).map(pick);
    const untagged = pages.filter(p => JSON.parse(p.tags || '[]').length === 0 && !homes.has(p.id)).map(pick);
    const thin = pages.filter(p => (p.words || 0) < 20 && !homes.has(p.id)).map(pick);
    const dupes = db.all(`SELECT space, lower(title) AS t, COUNT(*) AS n, group_concat(id) AS ids FROM pages WHERE archived = 0 GROUP BY space, lower(title) HAVING n > 1`)
      .map(r => ({ space: r.space, title: r.t, ids: r.ids.split(',') }));

    const onto = this.app.ontology;
    const typeOf = (target, space) => { const h = this.app.indexer.resolve(target, space); return h ? h.type : null; };
    const violations = [];
    for (const p of pages) {
      const props = JSON.parse(p.props || '{}');
      const rels = db.all("SELECT kind, target FROM links WHERE src = ? AND kind LIKE 'rel:%'", p.id).map(r => ({ rel: r.kind.slice(4), target: r.target }));
      const data = {};
      for (const [k, v] of Object.entries(props)) if (!Array.isArray(v)) data[k] = v;
      if (p.review_by) data.review_by = p.review_by;
      const issues = onto.validate({ type: p.type === 'Document' ? null : p.type, data, relations: rels, tags: JSON.parse(p.tags || '[]') }, (t) => typeOf(t, p.space))
        .filter(i => i.level === 'warning');
      if (issues.length) violations.push({ ...pick(p), issues });
    }
    const openConflicts = db.get("SELECT COUNT(*) AS n FROM conflicts WHERE status = 'open'").n;
    const total = pages.length || 1;
    const penalty = (orphans.length + staleList.length + reviewDue.length * 2 + untagged.length * 0.5 + violations.length + broken.length * 0.5) / total;
    const score = Math.max(0, Math.round(100 - penalty * 40));
    return {
      score, totals: { pages: pages.length, orphans: orphans.length, broken: broken.length, stale: staleList.length, reviewDue: reviewDue.length,
        untagged: untagged.length, thin: thin.length, duplicates: dupes.length, violations: violations.length, openConflicts },
      orphans, broken, stale: staleList, reviewDue, untagged, thin, duplicates: dupes, violations, staleDays: stale,
    };
  }

  /** Notify owners/last editors of pages whose review date has passed (run daily). */
  remindReviews() {
    const today = new Date().toISOString().slice(0, 10);
    let n = 0;
    for (const p of this.db.all('SELECT * FROM pages WHERE archived = 0 AND review_by IS NOT NULL AND review_by <= ?', today)) {
      const who = this.app.users.byUsername((p.owner || '').replace(/^.*\//, '')) || this.app.users.byUsername(p.updated_by || '');
      if (!who) continue;
      const already = this.db.get(`SELECT 1 FROM notifications WHERE user_id = ? AND type = 'review' AND data LIKE ? AND created_at > ?`,
        who.id, `%"page":"${p.id}"%`, new Date(Date.now() - 7 * 86400_000).toISOString());
      if (already) continue;
      this.app.notify.notify(who.id, 'review', { page: p.id, title: p.title, review_by: p.review_by });
      n++;
    }
    return n;
  }

  analytics({ days = 30 } = {}) {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const db = this.db;
    return {
      topPages: db.all(`SELECT v.page_id AS id, p.title, p.space, COUNT(*) AS views, COUNT(DISTINCT v.user_id) AS viewers FROM views v JOIN pages p ON p.id = v.page_id
        WHERE v.ts >= ? GROUP BY v.page_id ORDER BY views DESC LIMIT 20`, since),
      viewsByDay: db.all(`SELECT substr(ts, 1, 10) AS day, COUNT(*) AS views FROM views WHERE ts >= ? GROUP BY day ORDER BY day`, since),
      topSearches: db.all(`SELECT lower(q) AS q, COUNT(*) AS n, AVG(results) AS avg_results FROM search_log WHERE ts >= ? GROUP BY lower(q) ORDER BY n DESC LIMIT 20`, since),
      zeroResultSearches: db.all(`SELECT lower(q) AS q, COUNT(*) AS n FROM search_log WHERE ts >= ? AND results = 0 GROUP BY lower(q) ORDER BY n DESC LIMIT 20`, since),
      activeUsers: db.get(`SELECT COUNT(DISTINCT user_id) AS n FROM views WHERE ts >= ?`, since).n,
      contributors: db.all(`SELECT username, COUNT(*) AS edits FROM audit WHERE ts >= ? AND action IN ('page.created','page.updated') GROUP BY username ORDER BY edits DESC LIMIT 20`, since),
      growth: db.all(`SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS pages FROM pages GROUP BY month ORDER BY month`),
      totals: {
        pages: db.get('SELECT COUNT(*) AS n FROM pages WHERE archived = 0').n,
        spaces: db.get('SELECT COUNT(*) AS n FROM spaces WHERE archived = 0').n,
        users: db.get('SELECT COUNT(*) AS n FROM users WHERE active = 1').n,
        comments: db.get('SELECT COUNT(*) AS n FROM comments WHERE deleted = 0').n,
        tags: db.get('SELECT COUNT(DISTINCT tag) AS n FROM page_tags').n,
      },
    };
  }
}
