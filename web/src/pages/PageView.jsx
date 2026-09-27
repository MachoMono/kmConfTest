import { useEffect, useRef, useState } from 'preact/hooks';
import { api, session, navigate, toast, errorToast, timeAgo, fmtDate, onEvent, typeIcon, download } from '../lib.js';
import { useSignal } from '../signal.js';
import { useAsync, Loading, ErrorBox, Avatar, Modal, TagEditor, TagChip, PageTree } from '../ui.jsx';
import { extract, splitFrontmatter } from '../../../shared/doc.js';

const REACTIONS = ['👍', '❤️', '🎉', '😄', '🤔', '👀', '🚀', '✅'];

export function SpaceSidebar({ spaceKey, currentId, onChanged }) {
  const { data, reload } = useAsync(() => api.get(`/spaces/${spaceKey}`), [spaceKey]);
  useEffect(() => onEvent('page', (e) => { if (e.space === spaceKey && (e.type !== 'page.updated')) reload(); }), [spaceKey]);
  if (!data) return <aside class="sidebar"><Loading /></aside>;
  const canEdit = ['editor', 'admin'].includes(data.role);
  return (
    <aside class="sidebar" aria-label="Space navigation">
      <a class="space-title" href={`/s/${data.key}`}><span class="space-badge" style={data.color ? `background:${data.color}` : ''}>{data.key.slice(0, 2)}</span> {data.name}</a>
      <nav class="space-links">
        <a href={`/s/${data.key}/blog`}>📰 Blog</a>
        {canEdit && <a href={`/new?space=${data.key}`}>＋ New page</a>}
        {data.role === 'admin' && <a href={`/s/${data.key}/settings`}>⚙ Space settings</a>}
      </nav>
      <div class="tree-head">Pages</div>
      <PageTree rows={data.tree} currentId={currentId} canEdit={canEdit} spaceKey={data.key} onMoved={() => { reload(); onChanged && onChanged(); }} />
    </aside>
  );
}

function renderEnhancements(root, { canEdit, pageId, markdown, onTaskToggled, comments, onSelectText }) {
  if (!root) return;
  // mermaid diagrams (lazy)
  const diagrams = root.querySelectorAll('pre.mermaid:not([data-processed])');
  if (diagrams.length) import('mermaid').then(({ default: m }) => {
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default' });
    m.run({ nodes: [...diagrams] }).catch(() => {});
  }).catch(() => {});
  // code highlighting (lazy)
  const code = root.querySelectorAll('pre > code[class*="language-"]:not(.hljs)');
  if (code.length) import('highlight.js/lib/common').then(({ default: hljs }) => code.forEach(c => { try { hljs.highlightElement(c); } catch {} })).catch(() => {});
  // interactive task checkboxes (own tasks only, not those inside embeds/macros)
  const own = [...root.querySelectorAll('li[data-type="taskItem"]')].filter(li => !li.closest('.embed, .macro-rendered'));
  const lines = extract({}, splitFrontmatter(markdown).body).tasks.map(t => t.line);
  own.forEach((li, i) => {
    if (li.querySelector(':scope > input.task-cb')) return;
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'task-cb'; cb.checked = li.dataset.checked === 'true'; cb.disabled = !canEdit || lines[i] === undefined;
    cb.setAttribute('aria-label', 'Toggle task');
    cb.addEventListener('change', async () => {
      try { await api.post(`/pages/${pageId}/tasks/${lines[i]}`, { done: cb.checked }); li.dataset.checked = String(cb.checked); onTaskToggled(); }
      catch (e) { cb.checked = !cb.checked; errorToast(e); }
    });
    li.prepend(cb);
  });
  // wikilink/tag hrefs are real links already; heading anchors
  for (const h of root.querySelectorAll('h1[id],h2[id],h3[id],h4[id]')) {
    if (h.querySelector('.anchor')) continue;
    const a = document.createElement('a'); a.className = 'anchor'; a.href = '#' + h.id; a.textContent = '#'; a.setAttribute('aria-label', 'Link to section'); h.appendChild(a);
  }
  // inline comment highlights
  for (const c of comments.filter(c => c.anchor && !c.resolved && !c.deleted && !c.parent_id)) highlightText(root, c.anchor.text, c.id);
}

function highlightText(root, text, id) {
  if (!text || root.querySelector(`mark[data-comment="${id}"]`)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const i = node.nodeValue.indexOf(text);
    if (i < 0) continue;
    const range = document.createRange();
    range.setStart(node, i); range.setEnd(node, i + text.length);
    const mark = document.createElement('mark');
    mark.className = 'inline-comment'; mark.dataset.comment = id; mark.title = 'Inline comment — click to view';
    mark.addEventListener('click', () => { const el = document.getElementById('comment-' + id); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1500); } });
    range.surroundContents(mark);
    return;
  }
}

function Comment({ c, all, perms, me, reload, depth = 0 }) {
  const [reply, setReply] = useState(false);
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState('');
  const replies = all.filter(x => x.parent_id === c.id);
  const act = async (fn) => { try { await fn(); reload(); } catch (e) { errorToast(e); } };
  return (
    <div class={'comment' + (c.resolved ? ' resolved' : '')} id={'comment-' + c.id}>
      <div class="comment-head">{c.author && <Avatar name={c.author.name} size={24} />} <strong>{c.author ? c.author.name : 'Unknown'}</strong>
        <span class="muted small">{timeAgo(c.created_at)}{c.updated_at && !c.deleted ? ' · edited' : ''}</span>
        {c.anchor && <span class="quote-ref" title="Inline comment">“{c.anchor.text.slice(0, 60)}”</span>}
        {c.resolved && <span class="pill green">Resolved</span>}</div>
      {edit ? <div class="comment-form"><textarea value={text} onInput={(e) => setText(e.target.value)} aria-label="Edit comment" />
        <button class="btn small primary" onClick={() => act(async () => { await api.put(`/comments/${c.id}`, { body: text }); setEdit(false); })}>Save</button>
        <button class="btn small" onClick={() => setEdit(false)}>Cancel</button></div>
        : <div class="comment-body" dangerouslySetInnerHTML={{ __html: c.html }} />}
      {!c.deleted && me && <div class="comment-actions">
        {perms.comment && depth < 3 && <button class="link" onClick={() => setReply(!reply)}>Reply</button>}
        {REACTIONS.slice(0, 4).map(e => { const r = c.reactions.find(x => x.emoji === e); return <button class={'react' + (r && r.mine ? ' mine' : '')} aria-label={`React ${e}`} onClick={() => act(() => api.post('/reactions', { ttype: 'comment', tid: String(c.id), emoji: e }))}>{e}{r ? ' ' + r.count : ''}</button>; })}
        {c.author && c.author.username === me.username && <button class="link" onClick={() => { setText(c.body); setEdit(true); }}>Edit</button>}
        {!c.parent_id && perms.comment && <button class="link" onClick={() => act(() => api.put(`/comments/${c.id}`, { resolved: !c.resolved }))}>{c.resolved ? 'Reopen' : 'Resolve'}</button>}
        {(c.author && c.author.username === me.username || perms.admin) && <button class="link danger" onClick={() => confirm('Delete this comment?') && act(() => api.del(`/comments/${c.id}`))}>Delete</button>}
      </div>}
      {reply && <CommentForm pageId={c.page_id} parent={c.id} onDone={() => { setReply(false); reload(); }} pageIdOverride={all.pageId} />}
      {replies.length > 0 && <div class="replies">{replies.map(r => <Comment c={r} all={all} perms={perms} me={me} reload={reload} depth={depth + 1} />)}</div>}
    </div>
  );
}

function CommentForm({ parent, anchor, onDone, pageIdOverride }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const pid = pageIdOverride || CommentForm.pageId;
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try { await api.post(`/pages/${pid}/comments`, { body: text, parent_id: parent, anchor }); setText(''); onDone && onDone(); }
    catch (e) { errorToast(e); } finally { setBusy(false); }
  };
  return (
    <div class="comment-form">
      {anchor && <div class="quote-ref">Commenting on “{anchor.text.slice(0, 120)}”</div>}
      <textarea placeholder={parent ? 'Write a reply… (@mention people, Markdown ok)' : 'Add a comment… (@mention people, Markdown ok)'} aria-label={parent ? 'Reply' : 'Add a comment'}
        value={text} onInput={(e) => setText(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit(); }} />
      <button class="btn primary small" disabled={busy || !text.trim()} onClick={submit}>{parent ? 'Reply' : 'Comment'}</button>
    </div>
  );
}

function MoveModal({ page, onClose }) {
  const [spaces, setSpaces] = useState([]);
  const [space, setSpace] = useState(page.space);
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState([]);
  const [parent, setParent] = useState(null);
  useEffect(() => { api.get('/spaces').then(s => setSpaces(s.filter(x => ['editor', 'admin'].includes(x.role)))); }, []);
  useEffect(() => { api.get(`/suggest/pages?q=${encodeURIComponent(q)}&space=${space}&limit=20`).then(r => setOpts(r.filter(x => x.space === space && x.id !== page.id))); }, [q, space]);
  const move = async () => {
    try { await api.post(`/pages/${page.id}/move`, { space, parent: parent ? parent.id : null }); toast('Page moved', 'success'); onClose(true); }
    catch (e) { errorToast(e); }
  };
  return (
    <Modal title="Move page" onClose={() => onClose(false)}>
      <label>Space <select value={space} onChange={(e) => { setSpace(e.target.value); setParent(null); }}>{spaces.map(s => <option value={s.key}>{s.name} ({s.key})</option>)}</select></label>
      <label>New parent page <input value={q} placeholder="Search pages…" onInput={(e) => setQ(e.target.value)} /></label>
      <ul class="pick-list">{opts.map(o => <li><button class={parent && parent.id === o.id ? 'active' : ''} onClick={() => setParent(o)}>{o.title}</button></li>)}</ul>
      <p class="muted">Selected parent: <strong>{parent ? parent.title : '(top level of space)'}</strong></p>
      <div class="modal-actions"><button class="btn primary" onClick={move}>Move</button><button class="btn" onClick={() => onClose(false)}>Cancel</button></div>
    </Modal>
  );
}

function ShareModal({ page, onClose }) {
  const [users, setUsers] = useState('');
  const [msg, setMsg] = useState('');
  const link = location.origin + `/p/${page.id}`;
  const send = async () => {
    try {
      const r = await api.post(`/pages/${page.id}/share`, { users: users.split(',').map(s => s.trim()).filter(Boolean), message: msg });
      toast(r.delivered.length ? `Shared with ${r.delivered.join(', ')}` : 'Nobody to notify', r.skipped.length ? 'warn' : 'success');
      if (r.skipped.length) toast(`Skipped (unknown or no access): ${r.skipped.join(', ')}`, 'warn', 6000);
      onClose();
    } catch (e) { errorToast(e); }
  };
  return (
    <Modal title="Share page" onClose={onClose}>
      <label>Link <input readOnly value={link} onFocus={(e) => e.target.select()} /></label>
      <button class="btn small" onClick={() => { navigator.clipboard && navigator.clipboard.writeText(link); toast('Link copied', 'success'); }}>Copy link</button>
      <label>Notify people (usernames, comma separated) <input value={users} placeholder="e.g. bob, carol" onInput={(e) => setUsers(e.target.value)} /></label>
      <label>Message (optional) <textarea value={msg} onInput={(e) => setMsg(e.target.value)} /></label>
      <div class="modal-actions"><button class="btn primary" onClick={send} disabled={!users.trim()}>Share</button><button class="btn" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

function RestrictionsModal({ page, onClose }) {
  const { data, loading } = useAsync(() => api.get(`/pages/${page.id}/restrictions`), [page.id]);
  const [view, setView] = useState(null);
  const [edit, setEdit] = useState(null);
  useEffect(() => { if (data) { setView(data.view.map(r => (r.ptype === 'group' ? 'group:' : '') + r.principal).join(', ')); setEdit(data.edit.map(r => (r.ptype === 'group' ? 'group:' : '') + r.principal).join(', ')); } }, [data]);
  const parse = (s) => s.split(',').map(x => x.trim()).filter(Boolean).map(x => x.startsWith('group:') ? { ptype: 'group', principal: x.slice(6) } : { ptype: 'user', principal: x.replace(/^@/, '') });
  const save = async () => {
    try { await api.put(`/pages/${page.id}/restrictions`, { view: parse(view), edit: parse(edit) }); toast('Restrictions saved', 'success'); onClose(true); } catch (e) { errorToast(e); }
  };
  return (
    <Modal title="Page restrictions" onClose={() => onClose(false)}>
      {loading || view === null ? <Loading /> : <>
        <p class="muted">Leave empty for no restriction. Separate entries with commas; prefix groups with <code>group:</code>. View restrictions also apply to child pages.</p>
        <label>Who can view <input value={view} onInput={(e) => setView(e.target.value)} placeholder="e.g. alice, group:finance" /></label>
        <label>Who can edit <input value={edit} onInput={(e) => setEdit(e.target.value)} placeholder="e.g. bob, group:km" /></label>
        <div class="modal-actions"><button class="btn primary" onClick={save}>Save</button><button class="btn" onClick={() => onClose(false)}>Cancel</button></div>
      </>}
    </Modal>
  );
}

export default function PageView({ params }) {
  const s = useSignal(session);
  const me = s.user;
  const { data, loading, error, reload, setData } = useAsync(() => api.get(`/pages/${params.id}`), [params.id]);
  const comments = useAsync(() => api.get(`/pages/${params.id}/comments`), [params.id]);
  const attachments = useAsync(() => api.get(`/pages/${params.id}/attachments`), [params.id]);
  const [menu, setMenu] = useState(false);
  const [modal, setModal] = useState(null);
  const [stale, setStale] = useState(null);
  const [sel, setSel] = useState(null);
  const [inlineAnchor, setInlineAnchor] = useState(null);
  const [editLabels, setEditLabels] = useState(false);
  const content = useRef(null);
  CommentForm.pageId = params.id;

  useEffect(() => {
    const off1 = onEvent('page', (e) => { if (e.id === params.id && (!me || e.by !== me.username)) setStale(e); });
    const off2 = onEvent('comment', (e) => { if (e.page === params.id) comments.reload(); });
    const off3 = onEvent('presence', (e) => { if (e.page === params.id) setData(d => d ? { ...d, presence: e.users } : d); });
    let hb;
    if (me) { const beat = () => api.post(`/pages/${params.id}/presence`, { editing: false }).catch(() => {}); beat(); hb = setInterval(beat, 20000); }
    return () => { off1(); off2(); off3(); clearInterval(hb); if (me) api.post(`/pages/${params.id}/presence`, { leave: true }).catch(() => {}); };
  }, [params.id]);

  useEffect(() => {
    if (!data || !content.current) return;
    renderEnhancements(content.current, { canEdit: data.perms.edit, pageId: data.page.id, markdown: data.markdown, onTaskToggled: () => {}, comments: comments.data || [] });
    if (location.hash) { const el = document.getElementById(decodeURIComponent(location.hash.slice(1))); if (el) el.scrollIntoView(); }
  }, [data && data.html, comments.data]);

  useEffect(() => {
    if (data) document.title = `${data.page.title} · ${data.space ? data.space.name : ''}`;
  }, [data]);

  if (loading && !data) return <Loading />;
  if (error) return <div class="page-layout"><div class="page-main"><ErrorBox error={error} /></div></div>;
  const { page, perms } = data;

  const act = async (fn, msg) => { setMenu(false); try { await fn(); if (msg) toast(msg, 'success'); reload(); } catch (e) { errorToast(e); } };
  const onMouseUp = () => {
    const selection = window.getSelection();
    const text = selection && selection.toString().trim();
    if (!text || text.length < 3 || !perms.comment || !content.current.contains(selection.anchorNode)) { setSel(null); return; }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setSel({ text: text.slice(0, 500), top: rect.top + window.scrollY - 40, left: rect.left + window.scrollX });
  };
  const topComments = (comments.data || []).filter(c => !c.parent_id);
  const allComments = Object.assign([...(comments.data || [])], { pageId: page.id });

  return (
    <div class="page-layout">
      <SpaceSidebar spaceKey={page.space} currentId={page.id} />
      <article class="page-main" aria-labelledby="page-title">
        {stale && <div class="banner info" role="status">This page was just updated by <strong>{stale.by}</strong>. <button class="link" onClick={() => { setStale(null); reload(); }}>Show latest</button></div>}
        {page.archived && <div class="banner warn">This page is archived. {perms.edit && <button class="link" onClick={() => act(() => api.post(`/pages/${page.id}/archive`, { archived: false }), 'Page restored from archive')}>Unarchive</button>}</div>}
        <nav class="breadcrumbs" aria-label="Breadcrumb"><a href={`/s/${page.space}`}>{data.space ? data.space.name : page.space}</a>{data.breadcrumbs.map(b => <> › <a href={`/p/${b.id}`}>{b.title}</a></>)}</nav>
        <div class="page-head">
          <h1 id="page-title">{page.kind === 'blog' ? '📰 ' : ''}{page.title}</h1>
          {page.status && <span class={'page-status ' + String(page.status).toLowerCase().replace(/\s+/g, '-')} title="Page status">{page.status}</span>}
          <div class="page-actions">
            {data.presence.filter(p => !me || p.username !== me.username).map(p => <span class="presence" title={`${p.name} is ${p.editing ? 'editing' : 'viewing'}`}><Avatar name={p.name} size={24} />{p.editing && <span class="dot" />}</span>)}
            {perms.edit && <a class="btn primary" href={`/p/${page.id}/edit`} accessKey="e">✎ Edit</a>}
            {me && <button class={'btn icon' + (data.favorite ? ' on' : '')} aria-pressed={data.favorite ? 'true' : 'false'} title={data.favorite ? 'Unstar' : 'Star'} onClick={() => act(() => api.post(`/pages/${page.id}/favorite`, { favorite: !data.favorite }))}>{data.favorite ? '★' : '☆'}</button>}
            {me && <button class={'btn' + (data.watching ? ' on' : '')} aria-pressed={data.watching ? 'true' : 'false'} onClick={() => act(() => api.post(`/pages/${page.id}/watch`, { watch: !data.watching }), data.watching ? 'Stopped watching' : 'Watching this page')}>{data.watching ? '👁 Watching' : '👁 Watch'}</button>}
            <button class="btn" onClick={() => me ? setModal('share') : (navigator.clipboard && navigator.clipboard.writeText(location.origin + `/p/${page.id}`), toast('Link copied', 'success'))}>🔗 Share</button>
            <div class="dropdown">
              <button class="btn" aria-haspopup="menu" aria-expanded={menu ? 'true' : 'false'} onClick={() => setMenu(!menu)}>⋯ More</button>
              {menu && <div class="menu" role="menu">
                <a role="menuitem" href={`/p/${page.id}/history`}>🕘 Page history</a>
                <a role="menuitem" href={`/graph?page=${page.id}`}>🕸 Page graph</a>
                {perms.edit && <button role="menuitem" onClick={() => { setMenu(false); setModal('move'); }}>↔ Move</button>}
                {me && <button role="menuitem" onClick={() => act(async () => { const r = await api.post(`/pages/${page.id}/copy`, {}); navigate(`/p/${r.page.id}`); }, 'Page copied')}>⎘ Copy</button>}
                {perms.edit && <button role="menuitem" onClick={() => { setMenu(false); setModal('restrict'); }}>🔒 Restrictions</button>}
                {perms.edit && !page.archived && <button role="menuitem" onClick={() => act(() => api.post(`/pages/${page.id}/archive`, { archived: true }), 'Page archived')}>🗄 Archive</button>}
                <button role="menuitem" onClick={() => { setMenu(false); download(`/api/v1/pages/${page.id}/export?format=md`); }}>⬇ Export Markdown</button>
                <button role="menuitem" onClick={() => { setMenu(false); download(`/api/v1/pages/${page.id}/export?format=html`); }}>⬇ Export HTML</button>
                <a role="menuitem" href={`/api/v1/pages/${page.id}/export?format=pdf`} target="_blank" rel="noopener">🖨 Export PDF / print</a>
                <a role="menuitem" href={`/api/v1/pages/${page.id}/source`} target="_blank" rel="noopener">{'</>'} View source</a>
                {perms.edit && <button role="menuitem" class="danger" onClick={() => { setMenu(false); if (confirm(`Move "${page.title}" to the trash? Child pages move up a level.`)) api.del(`/pages/${page.id}`).then(() => { toast('Page moved to trash', 'success'); navigate(`/s/${page.space}`); }).catch(errorToast); }}>🗑 Delete</button>}
              </div>}
            </div>
          </div>
        </div>
        <div class="page-meta muted">
          <span>{typeIcon(page.type)} {page.type}</span> ·
          <span> Created by <a href={`/people/${page.created_by}`}>{page.created_by}</a></span> ·
          <span title={fmtDate(page.updated_at)}> Last updated {timeAgo(page.updated_at)} by <a href={`/people/${page.updated_by}`}>{page.updated_by}</a></span> ·
          <a href={`/p/${page.id}/history`}> history</a> · <span>{data.views} views</span>
          {data.restricted && <span class="pill">🔒 Restricted</span>}
          {page.review_by && <span class={'pill' + (page.review_by <= new Date().toISOString().slice(0, 10) ? ' red' : '')}>Review by {page.review_by}</span>}
        </div>
        <div class="labels">
          {editLabels && perms.edit
            ? <><TagEditor tags={page.tags} onChange={(tags) => { const add = tags.filter(t => !page.tags.includes(t)); const remove = page.tags.filter(t => !tags.includes(t)); act(() => api.post(`/pages/${page.id}/labels`, { add, remove })); }} /><button class="link" onClick={() => setEditLabels(false)}>Done</button></>
            : <>{page.tags.map(t => <TagChip tag={t} />)}{perms.edit && <button class="link" onClick={() => setEditLabels(true)}>{page.tags.length ? '✎ labels' : '+ Add labels'}</button>}</>}
        </div>
        {perms.edit && data.ontologyIssues.filter(i => i.level === 'warning').length > 0 && <div class="banner warn small" role="note">
          <strong>Knowledge quality:</strong> {data.ontologyIssues.filter(i => i.level === 'warning').map(i => i.message).join(' ')} <a href={`/p/${page.id}/edit`}>Fix in editor</a></div>}
        {(data.relations.length > 0 || Object.keys(page.props).some(k => !Array.isArray(page.props[k]))) && <dl class="properties" aria-label="Properties">
          {Object.entries(page.props).filter(([, v]) => !Array.isArray(v)).map(([k, v]) => <><dt>{k.replace(/_/g, ' ')}</dt><dd>{String(v)}</dd></>)}
          {data.relations.map(r => <><dt>{r.label}</dt><dd>{r.id ? <a href={`/p/${r.id}`}>{r.title}</a> : <a class="wikilink missing" href={`/new?space=${page.space}&title=${encodeURIComponent(r.target)}`}>{r.target}</a>}</dd></>)}
        </dl>}
        <div class="page-content rendered" ref={content} onMouseUp={onMouseUp} dangerouslySetInnerHTML={{ __html: data.html }} />
        {sel && <button class="inline-comment-btn" style={`top:${sel.top}px;left:${sel.left}px`} onMouseDown={(e) => { e.preventDefault(); setInlineAnchor({ text: sel.text }); setSel(null); setTimeout(() => document.getElementById('comments').scrollIntoView({ behavior: 'smooth' }), 50); }}>💬 Comment</button>}
        <div class="reactions">
          {REACTIONS.map(e => { const r = data.reactions.find(x => x.emoji === e); return (r || me) ? <button class={'react' + (r && r.mine ? ' mine' : '')} aria-label={`React ${e}`} disabled={!me} onClick={() => act(() => api.post('/reactions', { ttype: 'page', tid: page.id, emoji: e }))}>{e}{r ? ' ' + r.count : ''}</button> : null; })}
        </div>
        <section class="comments" id="comments" aria-label="Comments">
          <h2>Comments ({topComments.filter(c => !c.deleted).length})</h2>
          {comments.data && topComments.map(c => <Comment c={c} all={allComments} perms={perms} me={me} reload={comments.reload} />)}
          {perms.comment && <CommentForm key={inlineAnchor ? inlineAnchor.text : 'main'} anchor={inlineAnchor} pageIdOverride={page.id} onDone={() => { setInlineAnchor(null); comments.reload(); }} />}
          {inlineAnchor && <button class="link" onClick={() => setInlineAnchor(null)}>Cancel inline comment</button>}
        </section>
      </article>
      <aside class="page-rail" aria-label="Page details">
        {data.headings.length > 1 && <div class="rail-card"><h3>On this page</h3><ul class="rail-toc">{data.headings.filter(h => h.level <= 3).map(h => <li class={'l' + h.level}><a href={'#' + h.id}>{h.text}</a></li>)}</ul></div>}
        <div class="rail-card"><h3>Linked from ({data.backlinks.length})</h3>
          {data.backlinks.length ? <ul>{data.backlinks.map(b => <li><a href={`/p/${b.id}`}>{b.title}</a>{b.rel !== 'link' && <small class="muted"> · {b.rel}</small>}</li>)}</ul> : <p class="muted small">No pages link here yet.</p>}</div>
        {data.unlinked.length > 0 && <div class="rail-card"><h3>Unlinked mentions ({data.unlinked.length})</h3><ul>{data.unlinked.map(u => <li><a href={`/p/${u.id}`}>{u.title}</a>
          {me && <button class="link small" title="Turn the mention into a link" onClick={() => api.post(`/pages/${page.id}/link-mention`, { source: u.id }).then(() => { toast(`Linked from ${u.title}`, 'success'); reload(); }).catch(errorToast)}>Link</button>}</li>)}</ul></div>}
        {data.children.length > 0 && <div class="rail-card"><h3>Child pages</h3><ul>{data.children.map(c => <li><a href={`/p/${c.id}`}>{typeIcon(c.type)} {c.title}</a></li>)}</ul></div>}
        <div class="rail-card"><h3>Attachments ({(attachments.data || []).length})</h3>
          <ul>{(attachments.data || []).map(a => <li><a href={a.url} target="_blank" rel="noopener">{a.name}</a> <small class="muted">{Math.ceil(a.size / 1024)} KB</small>
            {perms.edit && <button class="link danger small" aria-label={`Delete ${a.name}`} onClick={() => confirm(`Delete ${a.name}?`) && api.del(`/pages/${page.id}/attachments/${encodeURIComponent(a.name)}`).then(attachments.reload).catch(errorToast)}>×</button>}</li>)}</ul>
          {perms.edit && <label class="btn small upload-btn">Upload file<input type="file" hidden onChange={async (e) => {
            for (const f of e.target.files) { try { await api(`/pages/${page.id}/attachments?name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f, headers: { 'content-type': 'application/octet-stream' } }); toast(`Uploaded ${f.name}`, 'success'); } catch (err) { errorToast(err); } }
            attachments.reload(); e.target.value = '';
          }} /></label>}
        </div>
        <div class="rail-card"><h3>Explore</h3><ul><li><a href={`/graph?page=${page.id}`}>🕸 Local graph</a></li><li><a href={`/ask?q=${encodeURIComponent(page.title)}`}>✨ Ask about this page</a></li></ul></div>
      </aside>
      {modal === 'move' && <MoveModal page={page} onClose={(changed) => { setModal(null); if (changed) reload(); }} />}
      {modal === 'share' && <ShareModal page={page} onClose={() => setModal(null)} />}
      {modal === 'restrict' && <RestrictionsModal page={page} onClose={(changed) => { setModal(null); if (changed) reload(); }} />}
    </div>
  );
}
