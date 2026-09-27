import { useEffect, useState, useCallback, useRef } from 'preact/hooks';
import { api, errorToast, initials, colorFor, typeIcon, navigate } from './lib.js';

export function useAsync(fn, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const seq = useRef(0);
  const run = useCallback(() => {
    const n = ++seq.current;
    setState(s => ({ ...s, loading: true }));
    return Promise.resolve().then(fn).then(
      (data) => { if (n === seq.current) setState({ loading: false, data, error: null }); return data; },
      (error) => { if (n === seq.current) setState({ loading: false, data: null, error }); });
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run, setData: (d) => setState(s => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

export function Loading({ label = 'Loading…' }) { return <div class="loading" role="status"><span class="spinner" /> {label}</div>; }
export function ErrorBox({ error }) {
  if (!error) return null;
  return <div class="error-box" role="alert"><strong>{error.status === 404 ? 'Not found' : error.status === 403 ? 'Access denied' : 'Something went wrong'}</strong><div>{error.message}</div></div>;
}
export function Empty({ children }) { return <div class="empty">{children}</div>; }

export function Avatar({ name, size = 28 }) {
  return <span class="avatar" style={`width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px;background:${colorFor(name)}`} title={name} aria-hidden="true">{initials(name)}</span>;
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []);
  return (
    <div class="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div class="modal-head"><h2>{title}</h2><button class="icon-btn" aria-label="Close" onClick={onClose}>✕</button></div>
        <div class="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function TagChip({ tag, onRemove }) {
  return <span class="tag-chip"><a class="tag" href={`/tags/${encodeURIComponent(tag)}`}>#{tag}</a>{onRemove && <button class="chip-x" aria-label={`Remove tag ${tag}`} onClick={() => onRemove(tag)}>×</button>}</span>;
}

export function TagEditor({ tags, onChange, placeholder = 'Add label…' }) {
  const [v, setV] = useState('');
  const [sugs, setSugs] = useState([]);
  const add = (t) => {
    t = t.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setV(''); setSugs([]);
  };
  useEffect(() => {
    if (!v) { setSugs([]); return; }
    const h = setTimeout(() => api.get(`/suggest/tags?q=${encodeURIComponent(v)}`).then(setSugs).catch(() => {}), 150);
    return () => clearTimeout(h);
  }, [v]);
  return (
    <div class="tag-editor">
      {tags.map(t => <TagChip tag={t} onRemove={(x) => onChange(tags.filter(y => y !== x))} />)}
      <span class="tag-input-wrap">
        <input value={v} placeholder={placeholder} aria-label="Add label" onInput={(e) => setV(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(v); } }} />
        {sugs.length > 0 && <div class="mini-suggest">{sugs.slice(0, 6).map(s => <button type="button" onMouseDown={(e) => { e.preventDefault(); add(s.tag); }}>#{s.tag} <small>{s.count}</small></button>)}</div>}
      </span>
    </div>
  );
}

/** Build a nested tree from flat {id,parent,title,sort} rows. */
export function buildTree(rows) {
  const byId = new Map(rows.map(r => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const n of byId.values()) (n.parent && byId.has(n.parent) ? byId.get(n.parent).children : roots).push(n);
  const sort = (arr) => { arr.sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title)); arr.forEach(n => sort(n.children)); };
  sort(roots);
  return roots;
}

export function PageTree({ rows, currentId, canEdit, onMoved, spaceKey }) {
  const tree = buildTree(rows);
  const ancestors = new Set();
  const byId = new Map(rows.map(r => [r.id, r]));
  let c = byId.get(currentId);
  while (c && c.parent) { ancestors.add(c.parent); c = byId.get(c.parent); }
  const [open, setOpen] = useState(() => new Set([...ancestors, ...tree.map(t => t.id)]));
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  useEffect(() => { setOpen(o => new Set([...o, ...ancestors])); }, [currentId]);
  const drop = async (target, pos) => {
    const id = drag;
    setDrag(null); setOver(null);
    if (!id || id === target.id) return;
    try {
      if (pos === 'inside') await api.post(`/pages/${id}/move`, { parent: target.id });
      else await api.post(`/pages/${id}/move`, { parent: target.parent, [pos === 'before' ? 'before' : 'after']: target.id });
      onMoved && onMoved();
    } catch (e) { errorToast(e); }
  };
  // Rendered via a plain function (not a nested component) so DOM rows survive re-renders during a drag.
  const renderNode = (n, depth) => {
    const isOpen = open.has(n.id);
    const toggle = () => { const s = new Set(open); isOpen ? s.delete(n.id) : s.add(n.id); setOpen(s); };
    const zone = (e) => { const r = e.currentTarget.getBoundingClientRect(); const y = e.clientY - r.top; return y < r.height * 0.25 ? 'before' : y > r.height * 0.75 ? 'after' : 'inside'; };
    return (
      <li key={n.id} role="treeitem" aria-expanded={n.children.length ? String(isOpen) : undefined} aria-selected={n.id === currentId ? 'true' : 'false'}>
        <div class={'tree-row' + (n.id === currentId ? ' current' : '') + (over && over.id === n.id ? ' drop-' + over.pos : '')} style={`padding-left:${depth * 14 + 4}px`}
          draggable={canEdit} data-id={n.id}
          onDragStart={(e) => { setDrag(n.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', n.id); }}
          onDragOver={(e) => { if (!drag) return; e.preventDefault(); const pos = zone(e); if (!over || over.id !== n.id || over.pos !== pos) setOver({ id: n.id, pos }); }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => { e.preventDefault(); drop(n, zone(e)); }}>
          {n.children.length ? <button class="twisty" aria-label={isOpen ? 'Collapse' : 'Expand'} onClick={toggle}>{isOpen ? '▾' : '▸'}</button> : <span class="twisty" />}
          <a href={`/p/${n.id}`} class={n.archived ? 'archived' : ''}>{typeIcon(n.type)} {n.title}</a>
          {canEdit && <a class="tree-add" href={`/new?space=${spaceKey}&parent=${n.id}`} title="Add child page" aria-label={`Add child page under ${n.title}`}>+</a>}
        </div>
        {isOpen && n.children.length > 0 && <ul role="group">{n.children.map(ch => renderNode(ch, depth + 1))}</ul>}
      </li>
    );
  };
  return <ul class="tree" role="tree" aria-label="Page tree">{tree.map(n => renderNode(n, 0))}</ul>;
}

export function PageLink({ p }) { return <a href={`/p/${p.id}`}>{typeIcon(p.type)} {p.title}</a>; }

export function Tabs({ tabs, value, onChange }) {
  return <div class="tabs" role="tablist">{tabs.map(t => <button role="tab" aria-selected={value === t.id ? 'true' : 'false'} class={value === t.id ? 'active' : ''} onClick={() => onChange(t.id)}>{t.label}{t.count != null && <span class="count">{t.count}</span>}</button>)}</div>;
}

export function ConfirmButton({ children, confirm: msg, onConfirm, class: cls = 'btn' }) {
  return <button class={cls} onClick={() => { if (window.confirm(msg)) onConfirm(); }}>{children}</button>;
}

export function goLogin() { navigate('/login?next=' + encodeURIComponent(location.pathname + location.search)); }
