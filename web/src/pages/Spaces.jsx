import { useEffect, useState } from 'preact/hooks';
import { api, session, navigate, toast, errorToast, timeAgo, typeIcon, download } from '../lib.js';
import { useSignal } from '../signal.js';
import { useAsync, Loading, ErrorBox, Empty, Modal } from '../ui.jsx';
import { SpaceSidebar } from './PageView.jsx';

function CreateSpace({ onClose }) {
  const [f, setF] = useState({ key: '', name: '', description: '', template: 'default' });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try { const r = await api.post('/spaces', f); toast(`Space ${r.key} created`, 'success'); onClose(); navigate(`/p/${r.home}`); }
    catch (err) { errorToast(err); } finally { setBusy(false); }
  };
  return (
    <Modal title="Create space" onClose={onClose}>
      <form onSubmit={submit} class="form">
        <label>Name <input required value={f.name} onInput={(e) => { set('name', e.target.value); if (!f._keyTouched) set('key', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)); }} /></label>
        <label>Key <input required value={f.key} pattern="[A-Z][A-Z0-9_]{1,15}" title="2-16 chars: A-Z, 0-9, _" onInput={(e) => setF(x => ({ ...x, key: e.target.value.toUpperCase(), _keyTouched: true }))} /></label>
        <label>Description <textarea value={f.description} onInput={(e) => set('description', e.target.value)} /></label>
        <label>Template <select value={f.template} onChange={(e) => set('template', e.target.value)}><option value="default">Documentation space</option><option value="team">Team space</option></select></label>
        <div class="modal-actions"><button class="btn primary" disabled={busy}>Create space</button><button type="button" class="btn" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}

export function SpacesList() {
  const s = useSignal(session);
  const [create, setCreate] = useState(false);
  const [filter, setFilter] = useState('');
  const { data, loading, error } = useAsync(() => api.get('/spaces'), []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const list = data.filter(x => (x.name + ' ' + x.key + ' ' + (x.description || '')).toLowerCase().includes(filter.toLowerCase()));
  return (
    <div class="narrow wide">
      <div class="page-head"><h1>Spaces</h1>{s.user && s.user.role !== 'guest' && <button class="btn primary" onClick={() => setCreate(true)}>+ Create space</button>}</div>
      <input class="filter" placeholder="Filter spaces…" aria-label="Filter spaces" value={filter} onInput={(e) => setFilter(e.target.value)} />
      {list.length ? <div class="space-grid">{list.map(sp => (
        <a class="space-card" href={`/s/${sp.key}`}>
          <span class="space-badge big" style={sp.color ? `background:${sp.color}` : ''}>{sp.key.slice(0, 2)}</span>
          <div><strong>{sp.name}</strong> <small class="muted">{sp.key}</small><p class="muted">{sp.description}</p>
            <small class="muted">{sp.pages} pages · updated {timeAgo(sp.updated_at)} · you: {sp.role}</small></div>
        </a>))}</div> : <Empty>No spaces yet.</Empty>}
      {create && <CreateSpace onClose={() => setCreate(false)} />}
    </div>
  );
}

export function SpaceHome({ params }) {
  const { data, error } = useAsync(() => api.get(`/spaces/${params.key}`), [params.key]);
  useEffect(() => {
    if (!data) return;
    const home = data.home_id && data.tree.find(t => t.id === data.home_id) ? data.home_id : data.tree[0] && data.tree[0].id;
    if (home) navigate(`/p/${home}`, { replace: true });
  }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (data && !data.tree.length) return <div class="narrow"><h1>{data.name}</h1><Empty>This space has no pages you can see. <a href={`/new?space=${data.key}`}>Create one</a></Empty></div>;
  return <Loading />;
}

export function BlogList({ params }) {
  const s = useSignal(session);
  const { data, loading, error } = useAsync(() => api.get(`/spaces/${params.key}/blog`), [params.key]);
  return (
    <div class="page-layout">
      <SpaceSidebar spaceKey={params.key.toUpperCase()} />
      <div class="page-main">
        <div class="page-head"><h1>Blog</h1>{s.user && <a class="btn primary" href={`/new?space=${params.key.toUpperCase()}&kind=blog`}>+ New blog post</a>}</div>
        {loading ? <Loading /> : error ? <ErrorBox error={error} /> : data.length ? data.map(p => (
          <article class="blog-item"><h2><a href={`/p/${p.id}`}>{p.title}</a></h2><div class="muted small">{p.created_by} · {new Date(p.created_at).toLocaleDateString()}</div><p>{p.excerpt}</p></article>
        )) : <Empty>No blog posts yet.</Empty>}
      </div>
    </div>
  );
}

function PermissionsEditor({ spaceKey }) {
  const { data, loading, reload } = useAsync(() => api.get(`/spaces/${spaceKey}/permissions`), [spaceKey]);
  const [rows, setRows] = useState(null);
  useEffect(() => { if (data) setRows(data.map(r => ({ ...r }))); }, [data]);
  if (loading || !rows) return <Loading />;
  const set = (i, k, v) => setRows(rows.map((r, j) => j === i ? { ...r, [k]: v } : r));
  const save = async () => { try { await api.put(`/spaces/${spaceKey}/permissions`, { entries: rows.filter(r => r.ptype === 'all' || r.ptype === 'anonymous' || r.principal) }); toast('Permissions saved', 'success'); reload(); } catch (e) { errorToast(e); } };
  return (
    <div>
      <table class="grid-table" aria-label="Space permissions">
        <thead><tr><th>Who</th><th>Name</th><th>Role</th><th /></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr><td><select value={r.ptype} onChange={(e) => set(i, 'ptype', e.target.value)} aria-label="Principal type"><option value="user">User</option><option value="group">Group</option><option value="all">All logged-in users</option><option value="anonymous">Anonymous</option></select></td>
            <td>{['user', 'group'].includes(r.ptype) ? <input value={r.principal} onInput={(e) => set(i, 'principal', e.target.value)} aria-label="Principal name" /> : <span class="muted">—</span>}</td>
            <td><select value={r.role} onChange={(e) => set(i, 'role', e.target.value)} aria-label="Role"><option>viewer</option><option>commenter</option><option>editor</option><option>admin</option></select></td>
            <td><button class="link danger" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button></td></tr>))}</tbody>
      </table>
      <button class="btn small" onClick={() => setRows([...rows, { ptype: 'user', principal: '', role: 'viewer' }])}>+ Add</button>{' '}
      <button class="btn primary small" onClick={save}>Save permissions</button>
    </div>
  );
}

export function SpaceSettings({ params }) {
  const key = params.key.toUpperCase();
  const { data, loading, error, reload } = useAsync(() => api.get(`/spaces/${key}`), [key]);
  const [f, setF] = useState(null);
  const [imp, setImp] = useState({ format: 'confluence', busy: false, result: null });
  useEffect(() => { if (data) setF({ name: data.name, description: data.description || '', color: data.color || '#3b6fd8', home: data.home_id || '' }); }, [data]);
  if (loading || !f) return error ? <ErrorBox error={error} /> : <Loading />;
  if (data.role !== 'admin') return <ErrorBox error={{ status: 403, message: 'Space administrators only' }} />;
  const save = async () => { try { await api.put(`/spaces/${key}`, f); toast('Space updated', 'success'); reload(); } catch (e) { errorToast(e); } };
  const doImport = async (file) => {
    setImp({ ...imp, busy: true, result: null });
    try { const r = await api(`/spaces/${key}/import?format=${imp.format}`, { method: 'POST', raw: file, headers: { 'content-type': 'application/zip' } }); setImp({ ...imp, busy: false, result: r }); toast(`Imported ${r.pages} page(s)`, 'success'); reload(); }
    catch (e) { setImp({ ...imp, busy: false }); errorToast(e); }
  };
  return (
    <div class="page-layout">
      <SpaceSidebar spaceKey={key} />
      <div class="page-main settings">
        <h1>Space settings — {data.name}</h1>
        <section class="card"><h2>Details</h2>
          <label>Name <input value={f.name} onInput={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>Description <textarea value={f.description} onInput={(e) => setF({ ...f, description: e.target.value })} /></label>
          <label>Colour <input type="color" value={f.color} onInput={(e) => setF({ ...f, color: e.target.value })} /></label>
          <label>Home page <select value={f.home} onChange={(e) => setF({ ...f, home: e.target.value })}>{data.tree.map(t => <option value={t.id}>{t.title}</option>)}</select></label>
          <button class="btn primary" onClick={save}>Save</button>{' '}
          <button class="btn" onClick={() => api.put(`/spaces/${key}`, { archived: !data.archived }).then(() => { toast(data.archived ? 'Space restored' : 'Space archived', 'success'); reload(); }).catch(errorToast)}>{data.archived ? 'Unarchive space' : 'Archive space'}</button>
        </section>
        <section class="card"><h2>Permissions</h2><p class="muted">Space roles: viewer &lt; commenter &lt; editor &lt; admin. Use page restrictions for finer control.</p><PermissionsEditor spaceKey={key} /></section>
        <section class="card"><h2>Import</h2>
          <p class="muted">Migrate content in one step. Confluence: upload a space <em>HTML export</em> zip. Obsidian/Markdown: upload a zipped vault — folders become parent pages and [[links]] keep working.</p>
          <label>Format <select value={imp.format} onChange={(e) => setImp({ ...imp, format: e.target.value })}><option value="confluence">Confluence HTML export (.zip)</option><option value="markdown">Obsidian vault / Markdown (.zip)</option></select></label>
          <label class="btn">{imp.busy ? 'Importing…' : 'Choose zip file'}<input type="file" accept=".zip" hidden disabled={imp.busy} onChange={(e) => e.target.files[0] && doImport(e.target.files[0])} /></label>
          {imp.result && <p class="muted">Imported {imp.result.pages} page(s).</p>}
        </section>
        <section class="card"><h2>Export</h2><p class="muted">Download all pages (Markdown) and attachments as a zip — it opens directly as an Obsidian vault.</p>
          <button class="btn" onClick={() => download(`/api/v1/spaces/${key}/export`)}>⬇ Export space</button></section>
      </div>
    </div>
  );
}
