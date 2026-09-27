import { useEffect, useState } from 'preact/hooks';
import { api, session, navigate, toast, errorToast, timeAgo, fmtDate, typeIcon, download } from '../lib.js';
import { useSignal } from '../signal.js';
import { useAsync, Loading, ErrorBox, Empty, Modal, Tabs, TagChip } from '../ui.jsx';
import Editor from '../editor/Editor.jsx';

const SECTIONS = [
  ['overview', '📊 Overview'], ['health', '🩺 Content health'], ['analytics', '📈 Analytics'], ['ontology', '🧬 Ontology'], ['tags', '🏷 Tags'],
  ['conflicts', '🔀 Merge review'], ['templates', '📑 Templates'], ['users', '👤 Users'], ['groups', '👥 Groups'], ['spaces', '🗂 Spaces'],
  ['git', '🔁 Git & GitHub'], ['integrations', '🔌 API & webhooks'], ['audit', '📜 Audit log'], ['settings', '⚙ Settings & flags'], ['system', '🛠 System'],
];

function Stat({ label, value, tone, href }) {
  const body = <><div class={'stat-value ' + (tone || '')}>{value}</div><div class="stat-label">{label}</div></>;
  return href ? <a class="stat" href={href}>{body}</a> : <div class="stat">{body}</div>;
}

function Overview() {
  const { data, loading, error } = useAsync(() => api.get('/admin/overview'), []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const t = data.health.totals;
  return (
    <div>
      <div class="stats">
        <Stat label="Content health score" value={data.health.score} tone={data.health.score >= 80 ? 'good' : data.health.score >= 60 ? 'warn' : 'bad'} href="/admin/health" />
        <Stat label="Pages" value={data.totals.pages} /><Stat label="Spaces" value={data.totals.spaces} /><Stat label="Active users (30d)" value={data.activeUsers} />
        <Stat label="Tags" value={data.totals.tags} /><Stat label="Comments" value={data.totals.comments} />
        <Stat label="Open merge reviews" value={data.openConflicts} tone={data.openConflicts ? 'warn' : ''} href="/admin/conflicts" />
        <Stat label="Git commits" value={data.git.commits} href="/admin/git" />
      </div>
      <div class="two-col">
        <section class="card"><h2>Needs attention</h2><ul class="attention">
          <li><a href="/admin/health#reviewDue">{t.reviewDue} pages overdue for review</a></li>
          <li><a href="/admin/health#stale">{t.stale} stale pages</a></li>
          <li><a href="/admin/health#orphans">{t.orphans} orphaned pages</a></li>
          <li><a href="/admin/health#broken">{t.broken} broken links</a></li>
          <li><a href="/admin/health#violations">{t.violations} pages with ontology issues</a></li>
          <li><a href="/admin/health#untagged">{t.untagged} untagged pages</a></li>
        </ul></section>
        <section class="card"><h2>System</h2><dl class="kv">
          <dt>Git HEAD</dt><dd><code>{String(data.git.head).slice(0, 10)}</code></dd>
          <dt>Remote</dt><dd>{data.git.sync.remote ? data.git.sync.remote.url.replace(/\/\/[^@]*@/, '//') : 'not configured'}</dd>
          <dt>Last sync</dt><dd>{data.git.sync.lastSync ? timeAgo(data.git.sync.lastSync) : '—'}{data.git.sync.lastError && <span class="pill red">{data.git.sync.lastError}</span>}</dd>
          <dt>Uptime</dt><dd>{Math.round(data.uptime / 60)} min</dd><dt>Memory</dt><dd>{Math.round(data.memory / 1048576)} MB</dd><dt>Node</dt><dd>{data.node}</dd>
        </dl></section>
      </div>
    </div>
  );
}

function PageTable({ rows, extra }) {
  if (!rows.length) return <Empty>Nothing here 🎉</Empty>;
  return <table class="grid-table"><thead><tr><th>Page</th><th>Space</th><th>Type</th><th>Updated</th>{extra && <th>{extra[0]}</th>}</tr></thead>
    <tbody>{rows.map(r => <tr><td><a href={`/p/${r.id || r.page}`}>{r.title}</a></td><td>{r.space}</td><td>{r.type || ''}</td><td>{r.updated_at ? timeAgo(r.updated_at) + ' · ' + (r.updated_by || '') : ''}</td>{extra && <td>{extra[1](r)}</td>}</tr>)}</tbody></table>;
}

function Health() {
  const [stale, setStale] = useState(180);
  const { data, loading, error, reload } = useAsync(() => api.get(`/admin/health?staleDays=${stale}`), [stale]);
  const [tab, setTab] = useState((location.hash || '#reviewDue').slice(1));
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const t = data.totals;
  const tabs = [['reviewDue', 'Review overdue', t.reviewDue], ['stale', 'Stale', t.stale], ['orphans', 'Orphans', t.orphans], ['broken', 'Broken links', t.broken],
    ['violations', 'Ontology issues', t.violations], ['untagged', 'Untagged', t.untagged], ['thin', 'Thin content', t.thin], ['duplicates', 'Duplicate titles', t.duplicates]];
  return (
    <div>
      <div class="page-head"><h2>Content health <span class={'score ' + (data.score >= 80 ? 'good' : data.score >= 60 ? 'warn' : 'bad')}>{data.score}/100</span></h2>
        <div><label class="inline">Stale after <input type="number" min="7" value={stale} style="width:5em" onChange={(e) => setStale(+e.target.value)} /> days</label>{' '}
          <button class="btn" onClick={() => api.post('/admin/health/remind').then(r => toast(`Sent ${r.notified} review reminder(s)`, 'success')).catch(errorToast)}>Send review reminders</button></div></div>
      <Tabs tabs={tabs.map(([id, label, count]) => ({ id, label, count }))} value={tab} onChange={(v) => { setTab(v); history.replaceState({}, '', '#' + v); }} />
      {tab === 'broken' ? (data.broken.length ? <table class="grid-table"><thead><tr><th>Page</th><th>Missing target</th><th>Kind</th><th /></tr></thead>
        <tbody>{data.broken.map(b => <tr><td><a href={`/p/${b.page}`}>{b.title}</a></td><td>{b.target}</td><td>{b.kind}</td><td><a href={`/new?space=${b.space}&title=${encodeURIComponent(b.target)}`}>Create page</a></td></tr>)}</tbody></table> : <Empty>No broken links 🎉</Empty>)
        : tab === 'violations' ? <PageTable rows={data.violations} extra={['Issues', (r) => <ul class="issues">{r.issues.map(i => <li>{i.message}</li>)}</ul>]} />
          : tab === 'duplicates' ? (data.duplicates.length ? <ul>{data.duplicates.map(d => <li>{d.space}: “{d.title}” — {d.ids.map(id => <a href={`/p/${id}`}>{id.slice(-6)} </a>)}</li>)}</ul> : <Empty>No duplicates.</Empty>)
            : tab === 'reviewDue' ? <PageTable rows={data.reviewDue} extra={['Review by', (r) => <span class="pill red">{r.review_by}</span>]} />
              : <PageTable rows={data[tab] || []} />}
    </div>
  );
}

/** Single-series column chart: views per day (HTML bars, hover/focus tooltip, table view). */
function fillDays(rows, days) {
  const byDay = new Map(rows.map(r => [r.day, r.views]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ day: d, views: byDay.get(d) || 0 });
  }
  return out;
}

function ViewsChart({ rows: raw, days = 30 }) {
  const rows = fillDays(raw, days);
  const [table, setTable] = useState(false);
  const [tip, setTip] = useState(null);
  if (!raw.length) return <Empty>No page views recorded yet.</Empty>;
  const max = Math.max(1, ...rows.map(r => r.views));
  const ticks = [max, Math.round(max / 2), 0];
  return (
    <figure class="viz-root chart">
      <figcaption class="chart-head"><strong>Page views per day</strong><button class="link small" onClick={() => setTable(!table)} aria-pressed={table ? 'true' : 'false'}>{table ? 'Show chart' : 'Show table'}</button></figcaption>
      {table ? <table class="grid-table"><thead><tr><th>Day</th><th>Views</th></tr></thead><tbody>{rows.filter(r => r.views).map(r => <tr><td>{r.day}</td><td>{r.views}</td></tr>)}</tbody></table> : (
        <div class="col-chart">
          <div class="y-axis" aria-hidden="true">{ticks.map(t => <span>{t}</span>)}</div>
          <div class="plot" role="list" aria-label="Page views per day">
            {rows.map(r => (
              <div class="col-hit" role="listitem" tabIndex={0} aria-label={`${r.day}: ${r.views} views`}
                onPointerMove={(e) => setTip({ r, x: e.currentTarget.offsetLeft + e.currentTarget.offsetWidth / 2 })} onPointerLeave={() => setTip(null)}
                onFocus={(e) => setTip({ r, x: e.currentTarget.offsetLeft + e.currentTarget.offsetWidth / 2 })} onBlur={() => setTip(null)}>
                <div class="col-bar" style={`height:${(r.views / max) * 100}%`} />
              </div>))}
            {tip && <div class="chart-tip" style={`left:${tip.x}px`}><strong>{tip.r.views}</strong> views<div class="muted small">{tip.r.day}</div></div>}
          </div>
          <div class="x-axis" aria-hidden="true"><span>{rows[0].day}</span><span>{rows[rows.length - 1].day}</span></div>
        </div>)}
    </figure>
  );
}

function Analytics() {
  const [days, setDays] = useState(30);
  const { data, loading, error } = useAsync(() => api.get(`/admin/analytics?days=${days}`), [days]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const maxViews = Math.max(1, ...data.topPages.map(p => p.views));
  return (
    <div>
      <div class="page-head"><h2>Analytics</h2><select value={days} onChange={(e) => setDays(+e.target.value)} aria-label="Period"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option></select></div>
      <div class="stats"><Stat label="Active readers" value={data.activeUsers} /><Stat label="Pages" value={data.totals.pages} /><Stat label="Users" value={data.totals.users} /><Stat label="Comments" value={data.totals.comments} /></div>
      <section class="card"><ViewsChart rows={data.viewsByDay} days={days} /></section>
      <div class="two-col">
        <section class="card"><h3>Most viewed pages</h3>{data.topPages.length ? <table class="grid-table"><thead><tr><th>Page</th><th>Views</th><th>Readers</th></tr></thead>
          <tbody>{data.topPages.map(p => <tr><td><a href={`/p/${p.id}`}>{p.title}</a></td><td><span class="inline-bar" style={`width:${(p.views / maxViews) * 80}px`} /> {p.views}</td><td>{p.viewers}</td></tr>)}</tbody></table> : <Empty>No views yet.</Empty>}</section>
        <section class="card"><h3>Top contributors</h3>{data.contributors.length ? <table class="grid-table"><thead><tr><th>User</th><th>Edits</th></tr></thead><tbody>{data.contributors.map(c => <tr><td>{c.username}</td><td>{c.edits}</td></tr>)}</tbody></table> : <Empty>No edits yet.</Empty>}</section>
      </div>
      <div class="two-col">
        <section class="card"><h3>Top searches</h3>{data.topSearches.length ? <table class="grid-table"><thead><tr><th>Query</th><th>Count</th><th>Avg results</th></tr></thead><tbody>{data.topSearches.map(s => <tr><td>{s.q}</td><td>{s.n}</td><td>{Math.round(s.avg_results)}</td></tr>)}</tbody></table> : <Empty>No searches yet.</Empty>}</section>
        <section class="card"><h3>Content gaps <small class="muted">(searches with no results)</small></h3>{data.zeroResultSearches.length ? <table class="grid-table"><thead><tr><th>Query</th><th>Count</th><th /></tr></thead><tbody>{data.zeroResultSearches.map(s => <tr><td>{s.q}</td><td>{s.n}</td><td><a href={`/new?title=${encodeURIComponent(s.q)}`}>Write it</a></td></tr>)}</tbody></table> : <Empty>No content gaps found.</Empty>}</section>
      </div>
    </div>
  );
}

function OntologyAdmin() {
  const { data, loading, error, reload } = useAsync(() => api.get('/ontology'), []);
  const [yaml, setYaml] = useState(null);
  const [check, setCheck] = useState(null);
  const [tab, setTab] = useState('types');
  useEffect(() => { if (data) setYaml(data.yaml); }, [data]);
  if (loading || yaml === null) return error ? <ErrorBox error={error} /> : <Loading />;
  const o = data.ontology;
  const validate = async () => setCheck(await api.post('/ontology/validate', { yaml }));
  const save = async () => { try { await api.put('/ontology', { yaml, message: 'Update ontology (admin panel)' }); toast('Ontology saved and versioned in git', 'success'); reload(); } catch (e) { errorToast(e); } };
  const addTag = async () => {
    const name = prompt('Tag name (e.g. security or team/platform)'); if (!name) return;
    const description = prompt('Description') || '';
    const synonyms = (prompt('Synonyms (comma separated, optional)') || '').split(',').map(s => s.trim()).filter(Boolean);
    try { await api.put('/ontology', { ontology: { ...o, tags: [...(o.tags || []).filter(t => t.name !== name), { name, description, ...(synonyms.length ? { synonyms } : {}) }] } }); toast('Tag definition saved', 'success'); reload(); } catch (e) { errorToast(e); }
  };
  return (
    <div>
      <div class="page-head"><h2>Ontology</h2><div><a class="btn small" href="/api/v1/ontology/schema.ttl" target="_blank" rel="noopener">OWL schema (Turtle)</a>{' '}
        <button class="btn small" onClick={() => download('/api/v1/graph/export?format=jsonld')}>Export graph JSON-LD</button>{' '}
        <button class="btn small" onClick={() => download('/api/v1/graph/export?format=ttl')}>RDF Turtle</button>{' '}
        <button class="btn small" onClick={() => download('/api/v1/graph/export?format=graphml')}>GraphML</button></div></div>
      <p class="muted">Entity types, typed relations and the tag taxonomy that power validation, the graph and GraphRAG. Pages pick a type in the editor's Properties panel; relations come from properties like <code>owner: [[Team]]</code> or inline <code>depends_on:: [[Service]]</code>.</p>
      <Tabs tabs={[{ id: 'types', label: 'Entity types', count: o.types.length }, { id: 'relations', label: 'Relations', count: (o.relations || []).length }, { id: 'tags', label: 'Tag taxonomy', count: (o.tags || []).length }, { id: 'yaml', label: 'Edit (YAML)' }]} value={tab} onChange={setTab} />
      {tab === 'types' && <table class="grid-table"><thead><tr><th>Type</th><th>Description</th><th>Properties</th><th>Pages</th></tr></thead>
        <tbody>{o.types.map(t => <tr><td>{typeIcon(t.name)} <strong>{t.name}</strong></td><td>{t.description}</td><td>{(t.properties || []).map(p => <code class="prop">{p.name}{p.required ? '*' : ''}: {p.datatype}{p.range ? '→' + p.range.join('|') : ''}</code>)}</td><td>{data.usage[t.name] || 0}</td></tr>)}</tbody></table>}
      {tab === 'relations' && <table class="grid-table"><thead><tr><th>Relation</th><th>Label / inverse</th><th>Domain → Range</th><th>Uses</th></tr></thead>
        <tbody>{[...data.builtins, ...(o.relations || [])].map(r => <tr><td><code>{r.name}</code>{r.builtin && <span class="pill">built-in</span>}</td><td>{r.label} / <em>{r.inverse}</em></td><td>{(r.domain || ['any']).join(', ')} → {(r.range || ['any']).join(', ')}</td><td>{data.relationUsage[r.name] || ''}</td></tr>)}</tbody></table>}
      {tab === 'tags' && <div><button class="btn small" onClick={addTag}>+ Define tag</button>
        <table class="grid-table"><thead><tr><th>Tag</th><th>Description</th><th>Synonyms</th><th>Status</th></tr></thead>
          <tbody>{(o.tags || []).map(t => <tr><td><TagChip tag={t.name} /></td><td>{t.description}</td><td>{(t.synonyms || []).join(', ')}</td><td>{t.deprecated ? <span class="pill red">deprecated{t.replaced_by ? ' → ' + t.replaced_by : ''}</span> : 'active'}</td></tr>)}</tbody></table></div>}
      {tab === 'yaml' && <div>
        <textarea class="code-area" value={yaml} spellcheck={false} aria-label="Ontology YAML" onInput={(e) => { setYaml(e.target.value); setCheck(null); }} />
        {check && <div class={'banner ' + (check.valid ? 'success' : 'warn')}>{check.valid ? `Valid — ${check.types} types.` : check.error}</div>}
        <button class="btn" onClick={validate}>Validate</button>{' '}<button class="btn primary" onClick={save}>Save ontology</button>
      </div>}
    </div>
  );
}

function TagsAdmin() {
  const { data, loading, reload } = useAsync(() => api.get('/tags'), []);
  const [f, setF] = useState('');
  if (loading) return <Loading />;
  const rename = async (tag) => {
    const to = prompt(`Rename or merge #${tag} into:`, tag); if (!to || to === tag) return;
    try { const r = await api.post('/admin/tags/rename', { from: tag, to }); toast(`Updated ${r.pages} page(s) in one commit`, 'success'); reload(); } catch (e) { errorToast(e); }
  };
  const del = async (tag) => {
    if (!confirm(`Remove #${tag} from every page?`)) return;
    try { const r = await api.post('/admin/tags/delete', { tag }); toast(`Removed from ${r.pages} page(s)`, 'success'); reload(); } catch (e) { errorToast(e); }
  };
  return (
    <div>
      <h2>Tags</h2>
      <p class="muted">Rename, merge (rename into an existing tag) or remove tags across the whole knowledge base — including inline <code>#tags</code> in page text. Each operation is one git commit.</p>
      <input class="filter" placeholder="Filter…" value={f} onInput={(e) => setF(e.target.value)} aria-label="Filter tags" />
      <table class="grid-table"><thead><tr><th>Tag</th><th>Pages</th><th>Description</th><th /></tr></thead>
        <tbody>{data.filter(t => t.tag.includes(f)).map(t => <tr><td><TagChip tag={t.tag} /></td><td>{t.count}</td><td class="muted">{t.description}</td>
          <td><button class="link" onClick={() => rename(t.tag)}>Rename / merge</button> <button class="link danger" onClick={() => del(t.tag)}>Remove</button></td></tr>)}</tbody></table>
    </div>
  );
}

function Conflicts() {
  const [status, setStatus] = useState('open');
  const { data, loading, reload } = useAsync(() => api.get(`/admin/conflicts?status=${status}`), [status]);
  const act = async (id, action) => { try { await api.post(`/admin/conflicts/${id}`, { action }); toast(action === 'restore' ? 'Discarded text restored' : 'Dismissed', 'success'); reload(); } catch (e) { errorToast(e); } };
  return (
    <div>
      <h2>Merge review</h2>
      <p class="muted">GitWiki merges concurrent edits automatically — authors are never shown conflict markers. When two people changed the <em>same words</em>, the newest edit wins and the other version is kept here so nothing is lost.</p>
      <Tabs tabs={[{ id: 'open', label: 'Open' }, { id: 'restored', label: 'Restored' }, { id: 'dismissed', label: 'Dismissed' }]} value={status} onChange={setStatus} />
      {loading ? <Loading /> : !data.length ? <Empty>No overlapping edits to review.</Empty> : data.map(c => (
        <div class="card conflict">
          <div><strong>{c.page_id ? <a href={`/p/${c.page_id}`}>{c.title || c.path}</a> : c.path}</strong> <span class="pill">{c.source === 'sync' ? 'GitHub sync' : 'concurrent edit'}</span> <small class="muted">{fmtDate(c.created_at)}{c.username ? ' · saved by ' + c.username : ''}{c.details.otherUser ? ' · overlapped with ' + c.details.otherUser : ''}</small></div>
          <table class="grid-table"><thead><tr><th>Original</th><th>Kept</th><th>Discarded (recoverable)</th></tr></thead>
            <tbody>{(c.details.conflicts || []).map(x => <tr><td><del>{x.field ? `${x.field}: ${JSON.stringify(x.base)}` : x.base}</del></td><td><ins>{x.field ? JSON.stringify(x.kept) : x.kept}</ins></td><td><mark>{x.field ? JSON.stringify(x.discarded) : x.discarded}</mark></td></tr>)}</tbody></table>
          {status === 'open' && <div><button class="btn small" onClick={() => act(c.id, 'restore')}>Use discarded text</button> <button class="btn small" onClick={() => act(c.id, 'dismiss')}>Keep current (dismiss)</button></div>}
        </div>))}
    </div>
  );
}

function Templates() {
  const { data, loading, reload } = useAsync(() => api.get('/templates'), []);
  const [edit, setEdit] = useState(null);
  const open = async (t) => setEdit(t ? { ...(await api.get(`/templates/${t.id}`)), isNew: false } : { id: '', name: '', description: '', type: '', tags: [], body: '', isNew: true });
  const save = async () => {
    try { await api.put(`/templates/${edit.id || edit.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, edit); toast('Template saved', 'success'); setEdit(null); reload(); } catch (e) { errorToast(e); }
  };
  if (loading) return <Loading />;
  return (
    <div>
      <div class="page-head"><h2>Templates</h2><button class="btn primary" onClick={() => open(null)}>+ New template</button></div>
      <p class="muted">Templates appear when people create pages. Variables: <code>{'{{title}}'}</code> <code>{'{{date}}'}</code> <code>{'{{user}}'}</code>.</p>
      <table class="grid-table"><thead><tr><th>Name</th><th>Type</th><th>Description</th><th /></tr></thead>
        <tbody>{data.map(t => <tr><td>{typeIcon(t.type)} {t.name}</td><td>{t.type}</td><td>{t.description}</td><td><button class="link" onClick={() => open(t)}>Edit</button> <button class="link danger" onClick={() => confirm('Delete template?') && api.del(`/templates/${t.id}`).then(reload).catch(errorToast)}>Delete</button></td></tr>)}</tbody></table>
      {edit && <Modal title={edit.isNew ? 'New template' : `Edit ${edit.name}`} onClose={() => setEdit(null)} wide>
        <label>Name <input value={edit.name} onInput={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
        <label>Description <input value={edit.description} onInput={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
        <label>Page type <input value={edit.type || ''} onInput={(e) => setEdit({ ...edit, type: e.target.value })} placeholder="e.g. HowTo" /></label>
        <Editor markdown={edit.body} onChange={(md) => setEdit(x => ({ ...x, body: md }))} />
        <div class="modal-actions"><button class="btn primary" onClick={save} disabled={!edit.name}>Save template</button></div>
      </Modal>}
    </div>
  );
}

function Users() {
  const s = useSignal(session);
  const { data, loading, reload } = useAsync(() => api.get('/admin/users'), []);
  const [modal, setModal] = useState(null);
  const [f, setF] = useState({});
  if (loading) return <Loading />;
  const isAdmin = s.user.isAdmin;
  const upd = async (u, patch) => { try { await api.put(`/admin/users/${u.username}`, patch); toast('User updated', 'success'); reload(); } catch (e) { errorToast(e); } };
  const create = async () => { try { await api.post('/admin/users', { ...f, groups: (f.groups || '').split(',').map(x => x.trim()).filter(Boolean) }); toast('User created', 'success'); setModal(null); reload(); } catch (e) { errorToast(e); } };
  return (
    <div>
      <div class="page-head"><h2>Users</h2>{isAdmin && <button class="btn primary" onClick={() => { setF({ role: 'user' }); setModal('new'); }}>+ Add user</button>}</div>
      <p class="muted">Users can also be provisioned automatically through SSO (OIDC) or SCIM 2.0 (<code>/scim/v2/Users</code>).</p>
      <table class="grid-table"><thead><tr><th>User</th><th>Email</th><th>Role</th><th>Groups</th><th>Last login</th><th>Status</th></tr></thead>
        <tbody>{data.map(u => <tr class={u.active ? '' : 'inactive'}><td><a href={`/people/${u.username}`}>{u.name}</a> <small class="muted">@{u.username}</small></td><td>{u.email}</td>
          <td>{isAdmin ? <select value={u.role} aria-label={`Role for ${u.username}`} onChange={(e) => upd(u, { role: e.target.value })}><option value="guest">guest</option><option value="user">user</option><option value="km_admin">KM admin</option><option value="admin">admin</option></select> : u.role}</td>
          <td>{u.groups.join(', ')}</td><td>{u.last_login ? timeAgo(u.last_login) : 'never'}</td>
          <td>{isAdmin ? <><button class="link" onClick={() => upd(u, { active: !u.active })}>{u.active ? 'Deactivate' : 'Activate'}</button> <button class="link" onClick={() => { const p = prompt(`New password for ${u.username} (min 8 chars)`); if (p) upd(u, { password: p }); }}>Reset password</button></> : (u.active ? 'active' : 'inactive')}</td></tr>)}</tbody></table>
      {modal === 'new' && <Modal title="Add user" onClose={() => setModal(null)}>
        {['username', 'name', 'email', 'password', 'groups'].map(k => <label>{k === 'groups' ? 'Groups (comma separated)' : k[0].toUpperCase() + k.slice(1)} <input type={k === 'password' ? 'password' : 'text'} value={f[k] || ''} onInput={(e) => setF({ ...f, [k]: e.target.value })} /></label>)}
        <label>Role <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="guest">guest</option><option value="user">user</option><option value="km_admin">KM admin</option><option value="admin">admin</option></select></label>
        <div class="modal-actions"><button class="btn primary" onClick={create}>Create user</button></div>
      </Modal>}
    </div>
  );
}

function Groups() {
  const { data, loading, reload } = useAsync(() => api.get('/admin/groups'), []);
  if (loading) return <Loading />;
  const create = async () => { const name = prompt('Group name'); if (!name) return; try { await api.post('/admin/groups', { name }); reload(); } catch (e) { errorToast(e); } };
  const members = async (g) => { const v = prompt(`Members of ${g.name} (comma separated usernames)`, g.users.join(', ')); if (v == null) return; try { await api.put(`/admin/groups/${encodeURIComponent(g.name)}`, { users: v.split(',').map(x => x.trim()).filter(Boolean) }); reload(); } catch (e) { errorToast(e); } };
  return (
    <div>
      <div class="page-head"><h2>Groups</h2><button class="btn primary" onClick={create}>+ New group</button></div>
      <table class="grid-table"><thead><tr><th>Group</th><th>Members</th><th /></tr></thead>
        <tbody>{data.map(g => <tr><td><strong>{g.name}</strong><div class="muted small">{g.description}</div></td><td>{g.users.join(', ') || <span class="muted">none</span>}</td>
          <td><button class="link" onClick={() => members(g)}>Edit members</button> <button class="link danger" onClick={() => confirm(`Delete group ${g.name}?`) && api.del(`/admin/groups/${encodeURIComponent(g.name)}`).then(reload).catch(errorToast)}>Delete</button></td></tr>)}</tbody></table>
    </div>
  );
}

function SpacesAdmin() {
  const { data, loading } = useAsync(() => api.get('/admin/spaces'), []);
  if (loading) return <Loading />;
  return (
    <div><h2>Spaces</h2>
      <table class="grid-table"><thead><tr><th>Space</th><th>Pages</th><th>Permissions</th><th>Status</th><th /></tr></thead>
        <tbody>{data.map(s => <tr><td><a href={`/s/${s.key}`}>{s.name}</a> <small class="muted">{s.key}</small></td><td>{s.pages}</td>
          <td class="small">{s.permissions.map(p => `${p.ptype === 'all' ? 'everyone' : p.ptype === 'anonymous' ? 'anonymous' : p.principal}: ${p.role}`).join(' · ')}</td>
          <td>{s.archived ? <span class="pill">archived</span> : 'active'}</td><td><a href={`/s/${s.key}/settings`}>Settings</a></td></tr>)}</tbody></table>
    </div>
  );
}

function GitAdmin() {
  const { data, loading, reload } = useAsync(() => api.get('/admin/git'), []);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) { const r = data.status.remote || {}; setF({ url: r.url || '', branch: r.branch || 'main', token: r.hasToken ? '••••••••' : '', autoPush: r.autoPush !== false, interval: r.interval ?? 60, webhookSecret: '' }); } }, [data]);
  if (loading || !f) return <Loading />;
  const st = data.status;
  const save = async () => { try { await api.put('/admin/git', f); toast('Remote saved', 'success'); reload(); } catch (e) { errorToast(e); } };
  const sync = async () => { setBusy(true); try { const r = await api.post('/admin/git/sync'); toast(r.skipped ? r.reason : `Synced: ${r.changed.length} file(s) changed${r.conflicts ? `, ${r.conflicts} overlap(s) auto-resolved` : ''}${r.pushed ? ', pushed' : ''}`, 'success'); reload(); } catch (e) { errorToast(e); } finally { setBusy(false); } };
  return (
    <div>
      <h2>Git & GitHub</h2>
      <p class="muted">Every page is a Markdown file in git. Connect a GitHub repository to back it up and let power users edit with their own tools — GitWiki pulls, merges and re-indexes automatically.</p>
      <div class="stats"><Stat label="Status" value={st.configured ? (st.lastError ? 'error' : 'connected') : 'local only'} tone={st.lastError ? 'bad' : st.configured ? 'good' : ''} />
        <Stat label="Last sync" value={st.lastSync ? timeAgo(st.lastSync) : '—'} /><Stat label="Ahead / behind" value={`${st.ahead} / ${st.behind}`} /></div>
      {st.lastError && <div class="banner warn">{st.lastError}</div>}
      <section class="card"><h3>Remote</h3>
        <label>Repository URL <input value={f.url} placeholder="https://github.com/acme/knowledge-base.git" onInput={(e) => setF({ ...f, url: e.target.value })} /></label>
        <label>Branch <input value={f.branch} onInput={(e) => setF({ ...f, branch: e.target.value })} /></label>
        <label>Access token <input type="password" value={f.token} placeholder="GitHub fine-grained token (contents: read/write)" onInput={(e) => setF({ ...f, token: e.target.value })} /></label>
        <label>Poll interval (seconds, 0 = webhook only) <input type="number" value={f.interval} onInput={(e) => setF({ ...f, interval: +e.target.value })} /></label>
        <label class="inline"><input type="checkbox" checked={f.autoPush} onChange={(e) => setF({ ...f, autoPush: e.target.checked })} /> Push changes automatically</label>
        <label>GitHub webhook secret <input value={f.webhookSecret} placeholder="(unchanged)" onInput={(e) => setF({ ...f, webhookSecret: e.target.value })} /></label>
        <p class="muted small">Webhook URL: <code>{location.origin}/api/v1/webhooks/github</code> (push events, content type JSON)</p>
        <button class="btn primary" onClick={save}>Save</button>{' '}<button class="btn" onClick={sync} disabled={busy || !st.configured}>{busy ? 'Syncing…' : 'Sync now'}</button>
      </section>
      <section class="card"><h3>Recent commits</h3><table class="grid-table"><thead><tr><th>Commit</th><th>Author</th><th>When</th><th>Message</th><th>Files</th></tr></thead>
        <tbody>{data.log.map(c => <tr><td><code>{c.rev.slice(0, 7)}</code></td><td>{c.author}</td><td>{timeAgo(c.date)}</td><td>{c.message}</td><td>{c.files}</td></tr>)}</tbody></table></section>
    </div>
  );
}

function Integrations() {
  const { data, loading, reload } = useAsync(() => api.get('/admin/webhooks'), []);
  const [secret, setSecret] = useState(null);
  const add = async () => {
    const url = prompt('Webhook URL (receives JSON POSTs signed with X-GitWiki-Signature)'); if (!url) return;
    const events = prompt('Events (comma separated; * for all). e.g. page.*, comment.created', '*');
    try { const r = await api.post('/admin/webhooks', { url, events: (events || '*').split(',').map(x => x.trim()) }); setSecret(r.secret); reload(); } catch (e) { errorToast(e); }
  };
  return (
    <div>
      <h2>API & integrations</h2>
      <section class="card"><h3>For developers and AI agents</h3><dl class="kv">
        <dt>REST API</dt><dd><code>{location.origin}/api/v1/…</code> with <code>Authorization: Bearer &lt;token&gt;</code> (create tokens in your profile)</dd>
        <dt>GraphRAG</dt><dd><code>GET /api/v1/graphrag/query?q=…&mode=hybrid|local|global</code> — chunks with citations, entities, relations, clusters, LLM-ready context</dd>
        <dt>MCP server</dt><dd><code>{location.origin}/mcp</code> — Streamable HTTP; tools: search, graphrag_query, get_page, list_spaces, get_neighbors, get_ontology, create_page, append_to_page</dd>
        <dt>Graph export</dt><dd>JSON-LD, RDF Turtle, GraphML at <code>/api/v1/graph/export?format=…</code></dd>
        <dt>SCIM 2.0</dt><dd><code>{location.origin}/scim/v2/Users</code> (admin token)</dd>
        <dt>Git</dt><dd>Clone the connected GitHub repository — every page is Markdown.</dd>
      </dl></section>
      <section class="card"><div class="page-head"><h3>Outgoing webhooks</h3><button class="btn small" onClick={add}>+ Add webhook</button></div>
        {secret && <div class="banner success">Signing secret (store it now): <code class="token">{secret}</code></div>}
        {loading ? <Loading /> : <table class="grid-table"><thead><tr><th>URL</th><th>Events</th><th>Last delivery</th><th /></tr></thead>
          <tbody>{data.map(h => <tr><td>{h.url}</td><td>{h.events}</td><td class="small">{h.last_status || '—'}</td>
            <td><button class="link" onClick={() => api.post(`/admin/webhooks/${h.id}/test`).then(() => { toast('Ping sent', 'success'); setTimeout(reload, 800); })}>Test</button> <button class="link danger" onClick={() => api.del(`/admin/webhooks/${h.id}`).then(reload)}>Delete</button></td></tr>)}</tbody></table>}
      </section>
    </div>
  );
}

function Audit() {
  const [f, setF] = useState({ user: '', action: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, loading } = useAsync(() => api.get(`/admin/audit?${qs}`), [qs]);
  return (
    <div>
      <div class="page-head"><h2>Audit log</h2><button class="btn small" onClick={() => download(`/api/v1/admin/audit?format=csv&limit=5000&${qs}`)}>⬇ Export CSV</button></div>
      <div class="filters"><input placeholder="User" value={f.user} onInput={(e) => setF({ ...f, user: e.target.value })} aria-label="Filter by user" />
        <input placeholder="Action prefix (e.g. page., auth.)" value={f.action} onInput={(e) => setF({ ...f, action: e.target.value })} aria-label="Filter by action" /></div>
      {loading ? <Loading /> : <table class="grid-table small"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead>
        <tbody>{data.map(a => <tr><td class="nowrap">{fmtDate(a.ts)}</td><td>{a.username}</td><td><code>{a.action}</code></td><td>{a.target && /^[a-z0-9]{12,}$/.test(a.target) ? <a href={`/p/${a.target}`}>{a.target.slice(-8)}</a> : a.target}</td><td class="details">{a.details ? JSON.stringify(a.details).slice(0, 160) : ''}</td><td>{a.ip}</td></tr>)}</tbody></table>}
    </div>
  );
}

function Settings() {
  const s = useSignal(session);
  const { data, loading, reload } = useAsync(() => api.get('/admin/settings'), []);
  const [st, setSt] = useState(null);
  const [flags, setFlags] = useState(null);
  useEffect(() => { if (data) { setSt(data.settings); setFlags(data.flags); } }, [data]);
  if (loading || !st) return <Loading />;
  const set = (k, v) => setSt({ ...st, [k]: v });
  const sub = (k, f, v) => setSt({ ...st, [k]: { ...(st[k] || {}), [f]: v } });
  const save = async () => { try { await api.put('/admin/settings', { settings: st, flags }); toast('Settings saved', 'success'); reload(); } catch (e) { errorToast(e); } };
  const ro = !s.user.isAdmin;
  return (
    <div class="settings">
      <h2>Settings</h2>
      {ro && <div class="banner info">Only administrators can change settings.</div>}
      <fieldset disabled={ro}>
        <section class="card"><h3>General</h3>
          <label>Site name <input value={st.site_name || ''} onInput={(e) => set('site_name', e.target.value)} /></label>
          <label class="inline"><input type="checkbox" checked={!!st.anonymous_access} onChange={(e) => set('anonymous_access', e.target.checked)} /> Allow anonymous access (only to spaces granting it)</label>
          <label>Who can create spaces <select value={st.space_creation || 'all'} onChange={(e) => set('space_creation', e.target.value)}><option value="all">All users</option><option value="km">Knowledge managers only</option></select></label>
          <label>Stale content after (days) <input type="number" value={st.stale_days || 180} onInput={(e) => set('stale_days', +e.target.value)} /></label>
          <label>Max attachment size (MB) <input type="number" value={st.max_attachment_mb || 25} onInput={(e) => set('max_attachment_mb', +e.target.value)} /></label>
          <label class="inline"><input type="checkbox" checked={st.email_enabled !== false} onChange={(e) => set('email_enabled', e.target.checked)} /> Email notifications</label>
          <label>Announcement banner <input value={(st.banner || {}).text || ''} placeholder="(none)" onInput={(e) => set('banner', e.target.value ? { text: e.target.value, kind: 'info' } : null)} /></label>
          <label class="inline"><input type="checkbox" checked={!!st.maintenance} onChange={(e) => set('maintenance', e.target.checked)} /> Maintenance mode (read-only for non-admins)</label>
        </section>
        <section class="card"><h3>AI answers (GraphRAG synthesis)</h3>
          <label>Provider <select value={(st.llm || {}).provider || ''} onChange={(e) => sub('llm', 'provider', e.target.value)}><option value="">Off — retrieval only</option><option value="anthropic">Anthropic Claude</option></select></label>
          <label>Model <input value={(st.llm || {}).model || ''} placeholder="claude-opus-5-5" onInput={(e) => sub('llm', 'model', e.target.value)} /></label>
          <label>Effort <select value={(st.llm || {}).effort || 'medium'} onChange={(e) => sub('llm', 'effort', e.target.value)}><option>low</option><option>medium</option><option>high</option></select></label>
          <label>API key <input type="password" value={(st.llm || {}).apiKey || ''} placeholder="or set ANTHROPIC_API_KEY" onInput={(e) => sub('llm', 'apiKey', e.target.value)} /></label>
        </section>
        <section class="card"><h3>Embeddings</h3>
          <label>Provider <select value={(st.embedding || {}).provider || 'local'} onChange={(e) => sub('embedding', 'provider', e.target.value)}><option value="local">Built-in (private, no network)</option><option value="openai">OpenAI-compatible endpoint</option></select></label>
          {(st.embedding || {}).provider === 'openai' && <><label>Endpoint URL <input value={st.embedding.url || ''} onInput={(e) => sub('embedding', 'url', e.target.value)} /></label>
            <label>Model <input value={st.embedding.model || ''} onInput={(e) => sub('embedding', 'model', e.target.value)} /></label>
            <label>API key <input type="password" value={st.embedding.apiKey || ''} onInput={(e) => sub('embedding', 'apiKey', e.target.value)} /></label></>}
          <p class="muted small">Changing provider requires a re-index (System tab).</p>
        </section>
        <section class="card"><h3>Email (SMTP)</h3>
          {['host', 'port', 'user', 'password', 'from'].map(k => <label>{k} <input type={k === 'password' ? 'password' : k === 'port' ? 'number' : 'text'} value={(st.smtp || {})[k] || ''} onInput={(e) => sub('smtp', k, e.target.value)} /></label>)}
          <label class="inline"><input type="checkbox" checked={!!(st.smtp || {}).secure} onChange={(e) => sub('smtp', 'secure', e.target.checked)} /> TLS (port 465)</label>
        </section>
        <section class="card"><h3>Single sign-on (OIDC)</h3>
          {['issuer', 'clientId', 'clientSecret', 'label', 'groupsClaim'].map(k => <label>{k} <input type={k === 'clientSecret' ? 'password' : 'text'} value={(st.oidc || {})[k] || ''} onInput={(e) => sub('oidc', k, e.target.value)} /></label>)}
          <label>Admin groups (comma separated) <input value={((st.oidc || {}).adminGroups || []).join(', ')} onInput={(e) => sub('oidc', 'adminGroups', e.target.value.split(',').map(x => x.trim()).filter(Boolean))} /></label>
          <label>KM admin groups <input value={((st.oidc || {}).kmGroups || []).join(', ')} onInput={(e) => sub('oidc', 'kmGroups', e.target.value.split(',').map(x => x.trim()).filter(Boolean))} /></label>
          <p class="muted small">Redirect URI: <code>{location.origin}/api/v1/auth/oidc/callback</code></p>
        </section>
        <section class="card"><h3>Feature flags & A/B rollouts</h3>
          <p class="muted">Roll features out to a percentage of users (stable per user) or to specific groups, and compare outcomes in Analytics.</p>
          <table class="grid-table"><thead><tr><th>Flag</th><th>Enabled</th><th>Rollout %</th><th>Groups (always on)</th></tr></thead>
            <tbody>{Object.entries(flags).map(([k, v]) => <tr><td><code>{k}</code><div class="muted small">{v.description}</div></td>
              <td><input type="checkbox" aria-label={`Enable ${k}`} checked={!!v.enabled} onChange={(e) => setFlags({ ...flags, [k]: { ...v, enabled: e.target.checked } })} /></td>
              <td><input type="number" min="0" max="100" style="width:5em" aria-label={`Rollout for ${k}`} value={v.rollout ?? 100} onInput={(e) => setFlags({ ...flags, [k]: { ...v, rollout: +e.target.value } })} /></td>
              <td><input aria-label={`Groups for ${k}`} value={(v.groups || []).join(', ')} onInput={(e) => setFlags({ ...flags, [k]: { ...v, groups: e.target.value.split(',').map(x => x.trim()).filter(Boolean) } })} /></td></tr>)}</tbody></table>
        </section>
        <button class="btn primary" onClick={save}>Save settings</button>
      </fieldset>
    </div>
  );
}

function System() {
  const [busy, setBusy] = useState(false);
  const outbox = useAsync(() => api.get('/admin/outbox').catch(() => []), []);
  return (
    <div>
      <h2>System</h2>
      <section class="card"><h3>Search & graph index</h3><p class="muted">The index is derived from git and can be rebuilt at any time.</p>
        <button class="btn" disabled={busy} onClick={async () => { setBusy(true); try { const r = await api.post('/admin/reindex'); toast(`Re-indexed ${r.pages} pages in ${r.ms} ms`, 'success'); } catch (e) { errorToast(e); } finally { setBusy(false); } }}>{busy ? 'Re-indexing…' : 'Rebuild index'}</button></section>
      <section class="card"><h3>Backup</h3><p class="muted">Downloads a git bundle of all content and history plus a snapshot of the database (users, comments, permissions).</p>
        <button class="btn" onClick={() => download('/api/v1/admin/backup')}>⬇ Download backup</button></section>
      <section class="card"><h3>Email outbox</h3>
        <button class="btn small" onClick={() => api.post('/admin/outbox/flush').then(r => { toast(r.configured === false ? 'SMTP is not configured (Settings)' : `Sent ${r.sent}, failed ${r.failed}`, r.failed ? 'warn' : 'success'); outbox.reload(); }).catch(errorToast)}>Send queued email now</button>
        {outbox.loading ? <Loading /> : outbox.data.length ? <table class="grid-table small"><thead><tr><th>To</th><th>Subject</th><th>Queued</th><th>Sent</th></tr></thead>
        <tbody>{outbox.data.slice(0, 50).map(m => <tr><td>{m.to_addr}</td><td>{m.subject}</td><td>{timeAgo(m.created_at)}</td><td>{m.sent_at ? timeAgo(m.sent_at) : m.error || 'queued'}</td></tr>)}</tbody></table> : <Empty>No emails queued.</Empty>}</section>
    </div>
  );
}

const VIEWS = { overview: Overview, health: Health, analytics: Analytics, ontology: OntologyAdmin, tags: TagsAdmin, conflicts: Conflicts, templates: Templates,
  users: Users, groups: Groups, spaces: SpacesAdmin, git: GitAdmin, integrations: Integrations, audit: Audit, settings: Settings, system: System };

export default function Admin({ params }) {
  const s = useSignal(session);
  if (!s.user || !s.user.isKm) return <div class="narrow"><ErrorBox error={{ status: 403, message: 'The admin panel is for knowledge managers and administrators.' }} /></div>;
  const section = params.section || 'overview';
  const View = VIEWS[section] || Overview;
  return (
    <div class="admin-layout">
      <nav class="admin-nav" aria-label="Admin sections"><div class="admin-title">KM Admin</div>
        {SECTIONS.map(([id, label]) => <a href={`/admin/${id}`} class={id === section ? 'active' : ''} aria-current={id === section ? 'page' : undefined}>{label}</a>)}</nav>
      <div class="admin-main"><View key={section} /></div>
    </div>
  );
}
