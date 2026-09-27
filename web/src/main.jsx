import { render } from 'preact';
import { useEffect, useState, useRef } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import { api, session, config, route, toasts, unread, navigate, matchRoute, connectEvents, onEvent, toast, typeIcon } from './lib.js';
import { useSignal } from './signal.js';
import { Avatar, Loading } from './ui.jsx';
import Dashboard from './pages/Dashboard.jsx';
import PageView from './pages/PageView.jsx';
import { SpacesList, SpaceHome, SpaceSettings, BlogList } from './pages/Spaces.jsx';
import { Login, NotFound, Tasks, Notifications, Profile, Trash, Person } from './pages/Misc.jsx';
import SearchPage from './pages/Search.jsx';
import { TagsIndex, TagPage } from './pages/Tags.jsx';
import History from './pages/History.jsx';
import Ask from './pages/Ask.jsx';

const PageEdit = lazy(() => import('./pages/PageEdit.jsx'));
const GraphPage = lazy(() => import('./pages/Graph.jsx'));
const Admin = lazy(() => import('./admin/Admin.jsx'));

const ROUTES = [
  ['/', Dashboard], ['/login', Login], ['/spaces', SpacesList], ['/s/:key', SpaceHome], ['/s/:key/settings', SpaceSettings], ['/s/:key/blog', BlogList],
  ['/p/:id', PageView], ['/p/:id/edit', PageEdit], ['/p/:id/history', History], ['/new', PageEdit],
  ['/search', SearchPage], ['/tags', TagsIndex], ['/tags/:tag*', TagPage], ['/graph', GraphPage], ['/ask', Ask],
  ['/tasks', Tasks], ['/notifications', Notifications], ['/profile', Profile], ['/trash', Trash], ['/people/:username', Person],
  ['/admin', Admin], ['/admin/:section', Admin],
];

function QuickSearch({ onClose }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState([]);
  const [i, setI] = useState(0);
  const input = useRef(null);
  useEffect(() => { input.current.focus(); }, []);
  useEffect(() => {
    const h = setTimeout(() => {
      if (!q.trim()) { api.get('/suggest/pages?q=').then(setRes).catch(() => {}); return; }
      api.get(`/search?q=${encodeURIComponent(q)}&limit=8`).then(r => setRes(r.results)).catch(() => {});
    }, 120);
    return () => clearTimeout(h);
  }, [q]);
  const go = (p) => { onClose(); navigate(p ? `/p/${p.id}` : `/search?q=${encodeURIComponent(q)}`); };
  return (
    <div class="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="quick-search" role="dialog" aria-label="Quick search">
        <input ref={input} value={q} placeholder="Search pages…  (Enter for full results)" aria-label="Quick search"
          onInput={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') { e.preventDefault(); setI(Math.min(i + 1, res.length)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(i - 1, 0)); }
            else if (e.key === 'Enter') go(i < res.length ? res[i] : null);
          }} />
        <ul class="qs-results">
          {res.map((r, n) => <li class={n === i ? 'active' : ''} onMouseDown={() => go(r)}><span>{typeIcon(r.type)} {r.title}</span><small>{r.space}</small>
            {r.snippet && <div class="snippet" dangerouslySetInnerHTML={{ __html: r.snippet }} />}</li>)}
          {q.trim() && <li class={i === res.length ? 'active' : ''} onMouseDown={() => go(null)}>🔍 Search everything for “{q}”</li>}
        </ul>
        <div class="qs-help">↑↓ to navigate · Enter to open · Esc to close · try <code>tag:runbook</code> <code>type:System</code> <code>space:ENG</code></div>
      </div>
    </div>
  );
}

function Header() {
  const s = useSignal(session);
  const cfg = useSignal(config);
  const n = useSignal(unread);
  const [menu, setMenu] = useState(false);
  const [qs, setQs] = useState(false);
  useEffect(() => {
    const k = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setQs(true); } };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []);
  const u = s.user;
  const logout = async () => { await api.post('/auth/logout'); session.value = { user: null, loaded: true }; navigate('/login'); };
  return (
    <header class="topbar">
      <a class="brand" href="/"><span class="logo" aria-hidden="true">◈</span> {cfg.siteName}</a>
      <nav class="mainnav" aria-label="Main">
        <a href="/spaces">Spaces</a><a href="/tags">Tags</a><a href="/graph">Graph</a><a href="/ask">Ask</a>
        {u && u.isKm && <a href="/admin">Admin</a>}
      </nav>
      <button class="search-trigger" onClick={() => setQs(true)} aria-label="Search (Ctrl+K)">🔍 Search <kbd>Ctrl K</kbd></button>
      {u && <a class="btn primary create-btn" href={`/new${route.value.path.startsWith('/p/') || route.value.path.startsWith('/s/') ? '?from=' + encodeURIComponent(route.value.path) : ''}`}>+ Create</a>}
      {u ? (
        <div class="userbox">
          <a class="bell" href="/notifications" aria-label={`Notifications (${n} unread)`}>🔔{n > 0 && <span class="badge">{n}</span>}</a>
          <button class="user-btn" aria-haspopup="menu" aria-expanded={menu ? 'true' : 'false'} onClick={() => setMenu(!menu)}><Avatar name={u.name} /> <span class="uname">{u.name}</span></button>
          {menu && <div class="menu" role="menu" onClick={() => setMenu(false)}>
            <a role="menuitem" href="/profile">Profile & API tokens</a>
            <a role="menuitem" href="/tasks">My tasks</a>
            <a role="menuitem" href="/trash">Trash</a>
            {u.isKm && <a role="menuitem" href="/admin">KM admin</a>}
            <button role="menuitem" onClick={logout}>Log out</button>
          </div>}
        </div>
      ) : <a class="btn" href="/login">Log in</a>}
      {qs && <QuickSearch onClose={() => setQs(false)} />}
    </header>
  );
}

function Toasts() {
  const t = useSignal(toasts);
  return <div class="toasts" aria-live="polite">{t.map(x => <div class={'toast ' + x.kind} role={x.kind === 'error' ? 'alert' : 'status'}>{x.message}</div>)}</div>;
}

function App() {
  const s = useSignal(session);
  const r = useSignal(route);
  const cfg = useSignal(config);
  useEffect(() => { document.title = cfg.siteName; }, [cfg.siteName]);
  if (!s.loaded) return <Loading />;
  let Comp = NotFound, params = {};
  for (const [pat, C] of ROUTES) { const m = matchRoute(pat, r.path); if (m) { Comp = C; params = m; break; } }
  if (!s.user && !cfg.anonymous && Comp !== Login) { Comp = Login; }
  return (
    <>
      <a class="skip" href="#main">Skip to content</a>
      <Header />
      {cfg.banner && cfg.banner.text && <div class={'site-banner ' + (cfg.banner.kind || 'info')} role="note">{cfg.banner.text}</div>}
      <main id="main"><Suspense fallback={<Loading />}><Comp key={r.path} params={params} query={r.query} /></Suspense></main>
      <Toasts />
    </>
  );
}

async function boot() {
  const theme = localStorage.getItem('gw-theme');
  if (theme) document.documentElement.dataset.theme = theme;
  try { config.value = await api.get('/config'); } catch {}
  try { const me = await api.get('/auth/me'); session.value = { user: me.user, loaded: true }; } catch { session.value = { user: null, loaded: true }; }
  const startEvents = () => {
    connectEvents();
    if (session.value.user) api.get('/notifications').then(n => { unread.value = n.unread; }).catch(() => {});
  };
  startEvents();
  let lastUser = session.value.user && session.value.user.id;
  session.subscribe((v) => { const id = v.user && v.user.id; if (id !== lastUser) { lastUser = id; startEvents(); } });
  onEvent('notification', (n) => {
    unread.value = unread.value + 1;
    const d = n.data || {};
    const msg = { mention: `${d.by} mentioned you in “${d.title}”`, comment: `${d.by} commented on “${d.title}”`, reply: `${d.by} replied on “${d.title}”`,
      task: `${d.by} assigned you a task in “${d.title}”`, share: `${d.by} shared “${d.title}” with you`, 'page.updated': `“${d.title}” was updated by ${d.by}`, merge: `Your edit to “${d.title}” was merged with ${d.by}'s` }[n.type];
    if (msg) toast(msg, 'info');
  });
  render(<App />, document.getElementById('app'));
}
boot();
