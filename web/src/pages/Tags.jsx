import { useState } from 'preact/hooks';
import { api, timeAgo, typeIcon } from '../lib.js';
import { useAsync, Loading, ErrorBox, Empty, TagChip } from '../ui.jsx';

export function TagsIndex() {
  const { data, loading, error } = useAsync(() => api.get('/tags'), []);
  const [f, setF] = useState('');
  const [view, setView] = useState('tree');
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const list = data.filter(t => t.tag.includes(f.toLowerCase()));
  const roots = list.filter(t => !t.parent || !list.some(x => x.tag === t.parent));
  const kids = (tag) => list.filter(t => t.parent === tag);
  const Node = ({ t }) => <li><TagChip tag={t.tag} /> <small class="muted">{t.count}</small>{t.deprecated && <span class="pill red">deprecated</span>}{t.description && <span class="muted small"> — {t.description}</span>}
    {kids(t.tag).length > 0 && <ul>{kids(t.tag).map(k => <Node t={k} />)}</ul>}</li>;
  const max = Math.max(1, ...list.map(t => t.count));
  return (
    <div class="narrow wide">
      <div class="page-head"><h1>Tags</h1>
        <div class="seg"><button class={view === 'tree' ? 'active' : ''} onClick={() => setView('tree')}>Hierarchy</button><button class={view === 'cloud' ? 'active' : ''} onClick={() => setView('cloud')}>Cloud</button></div></div>
      <p class="muted">Tags work like Obsidian: type <code>#tag</code> or nested <code>#team/platform</code> anywhere in a page, or add labels. Knowledge managers curate synonyms and descriptions in the ontology.</p>
      <input class="filter" placeholder="Filter tags…" aria-label="Filter tags" value={f} onInput={(e) => setF(e.target.value)} />
      {!list.length ? <Empty>No tags yet.</Empty> : view === 'tree'
        ? <ul class="tag-tree">{roots.map(t => <Node t={t} />)}</ul>
        : <div class="tagcloud">{list.map(t => <a class="tag" style={`font-size:${(0.85 + (t.count / max) * 1.1).toFixed(2)}em`} href={`/tags/${encodeURIComponent(t.tag)}`}>#{t.tag}</a>)}</div>}
    </div>
  );
}

export function TagPage({ params }) {
  const { data, loading, error } = useAsync(() => api.get(`/tags/${encodeURIComponent(params.tag)}`), [params.tag]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return (
    <div class="narrow wide">
      <h1>#{data.tag}</h1>
      {data.definition && data.definition.description && <p class="lead">{data.definition.description}</p>}
      {data.children.length > 0 && <p>Sub-tags: {data.children.map(c => <TagChip tag={c} />)}</p>}
      {data.related.length > 0 && <p class="muted">Often used with: {data.related.map(r => <TagChip tag={r.tag} />)}</p>}
      <p><a href={`/graph?tag=${encodeURIComponent(data.tag)}`}>🕸 View in graph</a> · <a href={`/search?q=${encodeURIComponent('tag:' + data.tag)}`}>Search within tag</a></p>
      {data.pages.length ? <table class="grid-table"><thead><tr><th>Page</th><th>Type</th><th>Space</th><th>Updated</th></tr></thead>
        <tbody>{data.pages.map(p => <tr><td><a href={`/p/${p.id}`}>{typeIcon(p.type)} {p.title}</a></td><td>{p.type}</td><td>{p.space}</td><td>{timeAgo(p.updated_at)}</td></tr>)}</tbody></table>
        : <Empty>No pages with this tag.</Empty>}
    </div>
  );
}
