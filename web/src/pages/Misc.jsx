import { useState } from 'preact/hooks';
import { api, session, config, navigate, toast, errorToast, timeAgo, unread, typeIcon, fmtDate } from '../lib.js';
import { useSignal } from '../signal.js';
import { useAsync, Loading, ErrorBox, Empty, Avatar } from '../ui.jsx';

export function Login({ query = {} }) {
  const cfg = useSignal(config);
  const [f, setF] = useState({ username: '', password: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api.post('/auth/login', f);
      session.value = { user: r.user, loaded: true };
      navigate(query.next && query.next.startsWith('/') && !query.next.startsWith('/login') ? query.next : '/', { replace: true });
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };
  return (
    <div class="login-wrap">
      <form class="login card" onSubmit={submit}>
        <h1><span class="logo">◈</span> {cfg.siteName}</h1>
        <p class="muted">Sign in to your knowledge base</p>
        {err && <div class="error-box" role="alert">{err}</div>}
        <label>Username <input name="username" autoComplete="username" required value={f.username} onInput={(e) => setF({ ...f, username: e.target.value })} /></label>
        <label>Password <input name="password" type="password" autoComplete="current-password" required value={f.password} onInput={(e) => setF({ ...f, password: e.target.value })} /></label>
        <button class="btn primary block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {cfg.sso && <a class="btn block" href={`/api/v1/auth/oidc/login?returnTo=${encodeURIComponent(query.next || '/')}`}>🔐 {cfg.sso.label}</a>}
      </form>
    </div>
  );
}

export function NotFound() { return <div class="narrow"><h1>Page not found</h1><p><a href="/">Go to the dashboard</a></p></div>; }

const NTEXT = {
  mention: (d) => <>{d.by} mentioned you in <a href={`/p/${d.page}`}>{d.title}</a></>,
  comment: (d) => <>{d.by} commented on <a href={`/p/${d.page}#comments`}>{d.title}</a>: “{(d.text || '').slice(0, 120)}”</>,
  reply: (d) => <>{d.by} replied to you on <a href={`/p/${d.page}#comments`}>{d.title}</a></>,
  task: (d) => <>{d.by} assigned you a task in <a href={`/p/${d.page}`}>{d.title}</a>: {d.text}</>,
  'page.updated': (d) => <><a href={`/p/${d.page}`}>{d.title}</a> was updated by {d.by}</>,
  'page.created': (d) => <>{d.by} created <a href={`/p/${d.page}`}>{d.title}</a></>,
  merge: (d) => <>Your edit to <a href={`/p/${d.page}`}>{d.title}</a> overlapped with {d.by}'s — merged automatically; a copy of overlapping text is kept for KM review.</>,
  review: (d) => <><a href={`/p/${d.page}`}>{d.title}</a> is due for review ({d.review_by})</>,
  share: (d) => <>{d.by} shared <a href={`/p/${d.page}`}>{d.title}</a> with you{d.text ? `: “${d.text}”` : ''}</>,
};

export function Notifications() {
  const { data, loading, reload } = useAsync(() => api.get('/notifications'), []);
  const markAll = async () => { await api.post('/notifications/read', {}); unread.value = 0; reload(); };
  if (loading) return <Loading />;
  return (
    <div class="narrow">
      <div class="page-head"><h1>Notifications</h1><button class="btn" onClick={markAll}>Mark all read</button></div>
      {data.items.length ? <ul class="notif-list">{data.items.map(n => (
        <li class={n.read ? '' : 'unread'} onClick={() => !n.read && api.post('/notifications/read', { ids: [n.id] }).then(() => { unread.value = Math.max(0, unread.value - 1); })}>
          <div>{(NTEXT[n.type] || ((d) => <>{n.type} <a href={`/p/${d.page}`}>{d.title}</a></>))(n.data)}</div><small class="muted">{timeAgo(n.created_at)}</small></li>))}</ul>
        : <Empty>You're all caught up.</Empty>}
    </div>
  );
}

export function Tasks() {
  const [done, setDone] = useState(false);
  const { data, loading } = useAsync(() => api.get(`/tasks?done=${done ? 1 : 0}`), [done]);
  return (
    <div class="narrow">
      <div class="page-head"><h1>My tasks</h1><label class="inline"><input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} /> Show completed</label></div>
      <p class="muted">Tasks are checklist items assigned with <code>@you</code> anywhere in the knowledge base. Add due dates with 📅 YYYY-MM-DD.</p>
      {loading ? <Loading /> : data.length ? <ul class="tasklist">{data.map(t => <li><span aria-hidden="true">{t.done ? '☑' : '☐'}</span> {t.text} {t.due && <span class={'due' + (!t.done && t.due < new Date().toISOString().slice(0, 10) ? ' overdue' : '')}>{t.due}</span>} — <a href={`/p/${t.page_id}`}>{t.title}</a> <small class="muted">{t.space}</small></li>)}</ul> : <Empty>No tasks.</Empty>}
    </div>
  );
}

export function Profile() {
  const s = useSignal(session);
  const u = s.user;
  const [f, setF] = useState({ name: u.name, email: u.email || '', emailNotif: u.prefs.email !== false });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [newToken, setNewToken] = useState(null);
  const tokens = useAsync(() => api.get('/auth/tokens'), []);
  const [theme, setTheme] = useState(localStorage.getItem('gw-theme') || 'auto');
  const save = async () => { try { const r = await api.put('/auth/me', { name: f.name, email: f.email, prefs: { email: f.emailNotif } }); session.value = { user: r.user, loaded: true }; toast('Profile saved', 'success'); } catch (e) { errorToast(e); } };
  const changePw = async () => { try { await api.put('/auth/me', pw); setPw({ currentPassword: '', newPassword: '' }); toast('Password changed', 'success'); } catch (e) { errorToast(e); } };
  const applyTheme = (t) => { setTheme(t); if (t === 'auto') { localStorage.removeItem('gw-theme'); delete document.documentElement.dataset.theme; } else { localStorage.setItem('gw-theme', t); document.documentElement.dataset.theme = t; } };
  return (
    <div class="narrow settings">
      <h1>Profile</h1>
      <section class="card"><h2>About you</h2>
        <label>Display name <input value={f.name} onInput={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Email <input type="email" value={f.email} onInput={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label class="inline"><input type="checkbox" checked={f.emailNotif} onChange={(e) => setF({ ...f, emailNotif: e.target.checked })} /> Email me about mentions, comments and watched pages</label>
        <button class="btn primary" onClick={save}>Save</button>
      </section>
      <section class="card"><h2>Appearance</h2>
        <label>Theme <select value={theme} onChange={(e) => applyTheme(e.target.value)}><option value="auto">Match system</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      </section>
      <section class="card"><h2>Password</h2>
        <label>Current password <input type="password" autoComplete="current-password" value={pw.currentPassword} onInput={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></label>
        <label>New password <input type="password" autoComplete="new-password" minLength={8} value={pw.newPassword} onInput={(e) => setPw({ ...pw, newPassword: e.target.value })} /></label>
        <button class="btn" onClick={changePw} disabled={!pw.newPassword}>Change password</button>
      </section>
      <section class="card"><h2>API tokens</h2>
        <p class="muted">Use tokens for the REST API, GraphRAG and the MCP endpoint (<code>{location.origin}/mcp</code>). Tokens act with your permissions.</p>
        {newToken && <div class="banner success" role="status">Copy your new token now — it won't be shown again:<br /><code class="token">{newToken.token}</code></div>}
        <table class="grid-table"><thead><tr><th>Name</th><th>Created</th><th>Last used</th><th /></tr></thead>
          <tbody>{(tokens.data || []).map(t => <tr><td>{t.name}</td><td>{fmtDate(t.created_at)}</td><td>{t.last_used ? timeAgo(t.last_used) : 'never'}</td>
            <td><button class="link danger" onClick={() => api.del(`/auth/tokens/${t.id}`).then(tokens.reload).catch(errorToast)}>Revoke</button></td></tr>)}</tbody></table>
        <button class="btn" onClick={async () => { const name = prompt('Token name', 'My integration'); if (!name) return; try { setNewToken(await api.post('/auth/tokens', { name })); tokens.reload(); } catch (e) { errorToast(e); } }}>+ New token</button>
      </section>
    </div>
  );
}

export function Trash() {
  const { data, loading, reload } = useAsync(() => api.get('/trash'), []);
  return (
    <div class="narrow">
      <h1>Trash</h1>
      <p class="muted">Deleted pages can be restored with their full history — nothing is ever lost from git.</p>
      {loading ? <Loading /> : data.length ? <table class="grid-table"><thead><tr><th>Page</th><th>Space</th><th>Deleted</th><th /></tr></thead>
        <tbody>{data.map(t => <tr><td>{t.title}</td><td>{t.space}</td><td>{timeAgo(t.deleted_at)} by {t.deleted_by}</td>
          <td><button class="btn small" onClick={() => api.post(`/trash/${t.page_id}/restore`).then(r => { toast('Restored', 'success'); navigate(`/p/${r.page.id}`); }).catch(errorToast)}>Restore</button>{' '}
            <button class="link danger" onClick={() => confirm('Remove from trash list? (Content remains in git history.)') && api.del(`/trash/${t.page_id}`).then(reload).catch(errorToast)}>Purge</button></td></tr>)}</tbody></table>
        : <Empty>Trash is empty.</Empty>}
    </div>
  );
}

export function Person({ params }) {
  const { data, loading, error } = useAsync(() => api.get(`/users/${encodeURIComponent(params.username)}`), [params.username]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return (
    <div class="narrow">
      <div class="person-head"><Avatar name={data.name} size={64} /><div><h1>{data.name}</h1><div class="muted">@{data.username} · {data.role}{data.email ? ' · ' + data.email : ''}</div>
        {data.groups.length > 0 && <div class="muted">Groups: {data.groups.join(', ')}</div>}</div></div>
      <h2>Recent contributions</h2>
      {data.recent.length ? <ul class="plist">{data.recent.map(p => <li><a href={`/p/${p.id}`}>{p.title}</a> <small class="muted">{p.space} · {timeAgo(p.updated_at)}</small></li>)}</ul> : <Empty>No contributions yet.</Empty>}
      <p><a href={`/search?q=${encodeURIComponent('author:' + data.username)}`}>Search all pages by {data.name}</a></p>
    </div>
  );
}
