import { useEffect, useRef, useState } from 'preact/hooks';
import { api, session, navigate, toast, errorToast, timeAgo, onEvent, typeIcon, matchRoute } from '../lib.js';
import { useSignal } from '../signal.js';
import { useAsync, Loading, ErrorBox, Avatar, TagEditor } from '../ui.jsx';
import Editor from '../editor/Editor.jsx';

function LinkInput({ value, onChange, space, placeholder }) {
  const [q, setQ] = useState((value || '').replace(/^\[\[|\]\]$/g, ''));
  const [opts, setOpts] = useState([]);
  const [focus, setFocus] = useState(false);
  useEffect(() => { setQ((value || '').replace(/^\[\[|\]\]$/g, '')); }, [value]);
  useEffect(() => {
    if (!focus) return;
    const h = setTimeout(() => api.get(`/suggest/pages?q=${encodeURIComponent(q)}&space=${space || ''}`).then(setOpts).catch(() => {}), 120);
    return () => clearTimeout(h);
  }, [q, focus]);
  const commit = (t) => { setQ(t); onChange(t ? `[[${t}]]` : ''); setOpts([]); };
  return (
    <span class="link-input">
      <input value={q} placeholder={placeholder || 'Link to page…'} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => { setFocus(false); commit(q.trim()); }, 150)}
        onInput={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(q.trim()); } }} />
      {focus && opts.length > 0 && <div class="mini-suggest">{opts.slice(0, 6).map(o => <button type="button" onMouseDown={(e) => { e.preventDefault(); commit(o.title); }}>{typeIcon(o.type)} {o.title} <small>{o.space}</small></button>)}</div>}
    </span>
  );
}

function PropertiesPanel({ ontology, type, setType, props, setProps, space, aliases, setAliases }) {
  const t = ontology.types.find(x => x.name === (type || 'Document'));
  const fields = (t && t.properties) || [];
  const set = (k, v) => setProps({ ...props, [k]: v });
  return (
    <div class="props-panel">
      <label>Page type <select value={type || 'Document'} onChange={(e) => setType(e.target.value === 'Document' ? '' : e.target.value)}>
        {ontology.types.map(x => <option value={x.name}>{typeIcon(x.name)} {x.name}</option>)}</select></label>
      {t && t.description && <p class="muted small">{t.description}</p>}
      {fields.map(f => (
        <label class={f.required && !props[f.name] ? 'required-missing' : ''}>{f.name.replace(/_/g, ' ')}{f.required ? ' *' : ''}
          {f.datatype === 'enum' ? <select value={props[f.name] || ''} onChange={(e) => set(f.name, e.target.value)}><option value="">—</option>{(f.values || []).map(v => <option value={v}>{v}</option>)}</select>
            : f.datatype === 'date' ? <input type="date" value={props[f.name] || ''} onInput={(e) => set(f.name, e.target.value)} />
              : f.datatype === 'link' ? <LinkInput value={props[f.name]} space={space} onChange={(v) => set(f.name, v)} placeholder={`Link to ${(f.range || ['page']).join(' / ')}…`} />
                : <input value={props[f.name] || ''} onInput={(e) => set(f.name, e.target.value)} />}
        </label>))}
      <label>Page status <select value={props.status || ''} onChange={(e) => set('status', e.target.value)}>
        <option value="">None</option>{['Rough draft', 'In progress', 'Ready for review', 'Verified', 'Outdated'].map(s => <option value={s}>{s}</option>)}</select></label>
      <label>Also known as (aliases) <input value={aliases} placeholder="comma separated" onInput={(e) => setAliases(e.target.value)} /></label>
      {!fields.some(f => f.name === 'review_by') && <label>Review by <input type="date" value={props.review_by || ''} onInput={(e) => set('review_by', e.target.value)} /></label>}
    </div>
  );
}

function TemplatePicker({ onPick }) {
  const { data, loading } = useAsync(() => api.get('/templates'), []);
  if (loading) return <Loading />;
  return (
    <div class="template-picker">
      <h2>Start with a template</h2>
      <div class="template-grid">
        <button class="template-card" onClick={() => onPick(null)}><strong>📄 Blank page</strong><span class="muted">Start from scratch</span></button>
        {(data || []).map(t => <button class="template-card" onClick={() => onPick(t)}><strong>{typeIcon(t.type)} {t.name}</strong><span class="muted">{t.description}</span></button>)}
      </div>
    </div>
  );
}

export default function PageEdit({ params, query }) {
  const s = useSignal(session);
  const me = s.user;
  const isNew = !params.id;
  const [state, setState] = useState(null); // {title, markdown, tags, type, props, rev, space, parent, kind}
  const [error, setError] = useState(null);
  const [needTemplate, setNeedTemplate] = useState(false);
  const [spaces, setSpaces] = useState([]);
  const [ontology, setOntology] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [others, setOthers] = useState([]);
  const [remoteChange, setRemoteChange] = useState(null);
  const [showProps, setShowProps] = useState(false);
  const [message, setMessage] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const draftKey = useRef(isNew ? (query.draft || 'new-' + Math.random().toString(36).slice(2, 10)) : params.id);
  const dirty = useRef(false);
  const latest = useRef(null);
  latest.current = state;

  useEffect(() => {
    api.get('/ontology').then(o => setOntology(o.ontology)).catch(() => {});
    (async () => {
      try {
        if (!isNew) {
          const p = await api.get(`/pages/${params.id}?track=0`);
          if (!p.perms.edit) throw Object.assign(new Error('You do not have permission to edit this page'), { status: 403 });
          const own = {};
          for (const [k, v] of Object.entries(p.frontmatter)) if (!['id', 'title', 'tags', 'type', 'parent', 'order', 'created', 'created_by', 'kind', 'aliases', 'archived'].includes(k)) own[k] = v;
          if (p.page.status && !own.status) own.status = p.page.status;
          const base = { aliases: (p.page.aliases || []).join(', '), title: p.page.title, markdown: p.markdown, tags: [].concat(p.frontmatter.tags || []), type: p.frontmatter.type || '', props: own, rev: p.page.rev, space: p.page.space, parent: p.page.parent, kind: p.page.kind };
          const d = await api.get(`/drafts/${params.id}`).catch(() => null);
          if (d && d.markdown != null && d.updated_at > (p.page.updated_at || '')) {
            setState({ ...base, markdown: d.markdown, title: d.title || base.title, rev: d.base_rev || base.rev });
            toast('Restored your unsaved draft. Publishing will merge it with any newer changes.', 'info', 6000);
          } else setState(base);
        } else {
          const all = await api.get('/spaces');
          const editable = all.filter(x => ['editor', 'admin'].includes(x.role));
          setSpaces(editable);
          let space = (query.space || '').toUpperCase(), parent = query.parent || null;
          if (query.from) {
            const m = matchRoute('/p/:id', query.from.split('?')[0]) || matchRoute('/p/:id/:rest*', query.from);
            const sm = matchRoute('/s/:key', query.from) || matchRoute('/s/:key/:rest*', query.from);
            if (m) { const p = await api.get(`/pages/${m.id}?track=0`).catch(() => null); if (p) { space = p.page.space; parent = p.page.kind === 'page' ? p.page.id : null; } }
            else if (sm) space = sm.key.toUpperCase();
          }
          if (!space || !editable.some(x => x.key === space)) space = editable[0] ? editable[0].key : '';
          const d = query.draft ? await api.get(`/drafts/${query.draft}`).catch(() => null) : null;
          if (d) setState({ title: d.title, markdown: d.markdown, tags: [], type: '', props: {}, space: d.space || space, parent: d.parent || parent, kind: 'page' });
          else {
            setState({ title: query.title || '', markdown: '', tags: [], type: '', props: {}, space, parent, kind: query.kind === 'blog' ? 'blog' : 'page' });
            if (!query.title) setNeedTemplate(true);
          }
          if (!editable.length) setError(Object.assign(new Error('You do not have edit access to any space. Ask a space admin, or create a space.'), { status: 403 }));
        }
      } catch (e) { setError(e); }
    })();
  }, []);

  // presence while editing
  useEffect(() => {
    if (isNew) return;
    const beat = () => api.post(`/pages/${params.id}/presence`, { editing: true }).then(r => setOthers(r.users.filter(u => u.username !== me.username))).catch(() => {});
    beat();
    const h = setInterval(beat, 15000);
    const off = onEvent('presence', (e) => { if (e.page === params.id) setOthers(e.users.filter(u => u.username !== me.username)); });
    const off2 = onEvent('page', (e) => { if (e.id === params.id && e.by !== me.username) setRemoteChange(e); });
    return () => { clearInterval(h); off(); off2(); api.post(`/pages/${params.id}/presence`, { leave: true }).catch(() => {}); };
  }, []);

  // autosave drafts
  useEffect(() => {
    const h = setInterval(async () => {
      if (!dirty.current || !latest.current) return;
      dirty.current = false;
      const st = latest.current;
      try {
        await api.put(`/drafts/${encodeURIComponent(draftKey.current)}`, { page_id: isNew ? null : params.id, space: st.space, parent: st.parent, title: st.title, markdown: st.markdown, base_rev: st.rev });
        setSavedAt(new Date().toISOString());
        if (isNew && !query.draft) history.replaceState({}, '', `/new?draft=${encodeURIComponent(draftKey.current)}`);
      } catch {}
    }, 2500);
    const warn = (e) => { if (dirty.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => { clearInterval(h); window.removeEventListener('beforeunload', warn); };
  }, []);

  const update = (patch) => { dirty.current = true; setState(st => ({ ...st, ...patch })); };

  const publish = async () => {
    const st = latest.current;
    if (!st.title.trim()) { toast('Please give the page a title', 'warn'); return; }
    setBusy(true);
    try {
      const props = {};
      for (const [k, v] of Object.entries(st.props || {})) props[k] = v === '' ? null : v;
      if (isNew) {
        const aliases = String(st.aliases || '').split(',').map(s => s.trim()).filter(Boolean);
        const r = await api.post('/pages', { space: st.space, parent: st.parent, title: st.title, markdown: st.markdown, tags: st.tags, type: st.type || undefined, props, aliases, kind: st.kind, draftKey: draftKey.current, message: message || undefined });
        await api.del(`/drafts/${encodeURIComponent(draftKey.current)}`).catch(() => {});
        dirty.current = false;
        toast('Page published', 'success');
        navigate(`/p/${r.page.id}`, { replace: true });
      } else {
        const aliases = String(st.aliases || '').split(',').map(s => s.trim()).filter(Boolean);
        const r = await api.put(`/pages/${params.id}`, { title: st.title, markdown: st.markdown, tags: st.tags, type: st.type, props, aliases, baseRev: st.rev, message: message || undefined, draftKey: draftKey.current });
        dirty.current = false;
        if (r.merged) toast(r.conflicts ? `Published. Your changes were merged with a newer edit (${r.conflicts} overlapping change(s) kept for review).` : 'Published — merged with changes made by others meanwhile.', 'success', 6000);
        else toast(r.unchanged ? 'No changes to publish' : 'Page published', 'success');
        navigate(`/p/${params.id}`, { replace: true });
      }
    } catch (e) { errorToast(e); } finally { setBusy(false); }
  };

  useEffect(() => {
    const k = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); publish(); } };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []);

  const cancel = async () => {
    if (dirty.current && !confirm('Discard your unpublished changes?')) return;
    dirty.current = false;
    await api.del(`/drafts/${encodeURIComponent(draftKey.current)}`).catch(() => {});
    navigate(isNew ? (state && state.parent ? `/p/${state.parent}` : '/') : `/p/${params.id}`);
  };

  if (error) return <div class="narrow"><ErrorBox error={error} /></div>;
  if (!state) return <Loading />;
  if (needTemplate) return <div class="narrow"><TemplatePicker onPick={async (t) => {
    if (t) { const full = await api.get(`/templates/${t.id}`); const today = new Date().toISOString().slice(0, 10);
      update({ markdown: full.body.replace(/\{\{date\}\}/g, today).replace(/\{\{(user|username)\}\}/g, me.username).replace(/\{\{title\}\}/g, state.title || 'Untitled'), type: full.type || '', tags: full.tags || [] }); }
    setNeedTemplate(false);
  }} /></div>;

  return (
    <div class="edit-layout">
      <div class="edit-bar">
        <div class="edit-bar-left">
          {isNew ? <>
            <label class="inline">Space <select value={state.space} onChange={(e) => update({ space: e.target.value, parent: null })} aria-label="Space">{spaces.map(x => <option value={x.key}>{x.name}</option>)}</select></label>
            <label class="inline">Type <select value={state.kind} onChange={(e) => update({ kind: e.target.value })} aria-label="Content type"><option value="page">Page</option><option value="blog">Blog post</option></select></label>
          </> : <span class="muted">Editing in <strong>{state.space}</strong></span>}
          {others.length > 0 && <span class="presence-note" role="status">{others.map(o => <Avatar name={o.name} size={22} />)} {others.map(o => o.name).join(', ')} {others.length > 1 ? 'are' : 'is'} {others.some(o => o.editing) ? 'also editing' : 'viewing'} — changes merge automatically.</span>}
          {remoteChange && <span class="presence-note warn" role="status">{remoteChange.by} just published changes; yours will be merged on publish.</span>}
        </div>
        <div class="edit-bar-right">
          <span class="muted small" aria-live="polite">{savedAt ? `Draft saved ${timeAgo(savedAt)}` : 'Drafts save automatically'}</span>
          <button class="btn" onClick={() => setShowProps(!showProps)} aria-expanded={showProps ? 'true' : 'false'}>⚙ Properties</button>
          <button class="btn" onClick={cancel}>Cancel</button>
          <button class="btn primary" disabled={busy} onClick={publish} title="Publish (Ctrl+S)">{busy ? 'Publishing…' : isNew ? 'Publish' : 'Update'}</button>
        </div>
      </div>
      <div class="edit-main">
        <input class="title-input" value={state.title} placeholder="Page title" aria-label="Page title" onInput={(e) => update({ title: e.target.value })} autoFocus={isNew} />
        <div class="labels"><TagEditor tags={state.tags} onChange={(tags) => update({ tags })} /></div>
        {showProps && ontology && <PropertiesPanel ontology={ontology} type={state.type} setType={(type) => update({ type })} props={state.props} setProps={(props) => update({ props })} space={state.space}
          aliases={state.aliases || ''} setAliases={(aliases) => update({ aliases })} />}
        <Editor key={editorKey} markdown={state.markdown} space={state.space} pageId={isNew ? null : params.id} autofocus={!isNew}
          slash={true} onChange={(md) => update({ markdown: md })} />
        <input class="version-msg" value={message} placeholder="Describe what you changed (optional)" aria-label="Change description" onInput={(e) => setMessage(e.target.value)} />
      </div>
    </div>
  );
}
