import { useEffect, useState } from 'preact/hooks';
import { api, navigate, timeAgo, typeIcon } from '../lib.js';
import { useAsync, Loading, ErrorBox, Empty, TagChip } from '../ui.jsx';

export default function SearchPage({ query }) {
  const q = query.q || '';
  const [input, setInput] = useState(q);
  const [spaces, setSpaces] = useState([]);
  const [types, setTypes] = useState([]);
  const page = Number(query.page || 0);
  useEffect(() => { api.get('/spaces').then(setSpaces).catch(() => {}); api.get('/ontology').then(o => setTypes(o.ontology.types.map(t => t.name))).catch(() => {}); }, []);
  const { data, loading, error } = useAsync(() => q.trim() ? api.get(`/search?q=${encodeURIComponent(q)}&limit=20&offset=${page * 20}`) : Promise.resolve(null), [q, page]);
  const addFilter = (f) => navigate(`/search?q=${encodeURIComponent((q + ' ' + f).trim())}`);
  return (
    <div class="narrow wide search-page">
      <form class="search-form" role="search" onSubmit={(e) => { e.preventDefault(); navigate(`/search?q=${encodeURIComponent(input)}`); }}>
        <input value={input} onInput={(e) => setInput(e.target.value)} placeholder='Search… e.g. deploy tag:runbook space:ENG "exact phrase" -draft' aria-label="Search query" autoFocus />
        <button class="btn primary">Search</button>
        <a class="btn" href={`/ask?q=${encodeURIComponent(input)}`}>✨ Ask instead</a>
      </form>
      <div class="filters">
        <select aria-label="Filter by space" onChange={(e) => e.target.value && addFilter('space:' + e.target.value)}><option value="">Space…</option>{spaces.map(s => <option value={s.key}>{s.name}</option>)}</select>
        <select aria-label="Filter by type" onChange={(e) => e.target.value && addFilter('type:' + e.target.value)}><option value="">Type…</option>{types.map(t => <option value={t}>{t}</option>)}</select>
        <select aria-label="Updated since" onChange={(e) => e.target.value && addFilter('updated>' + e.target.value)}><option value="">Updated…</option>
          {[7, 30, 90, 365].map(d => <option value={new Date(Date.now() - d * 86400000).toISOString().slice(0, 10)}>last {d} days</option>)}</select>
        <select aria-label="Sort" onChange={(e) => e.target.value && addFilter('sort:' + e.target.value)}><option value="">Sort…</option><option value="relevance">Relevance</option><option value="updated">Recently updated</option><option value="title">Title</option></select>
      </div>
      {!q.trim() ? <Empty>Type a query. Filters: <code>tag:x</code> <code>space:KEY</code> <code>type:System</code> <code>author:user</code> <code>updated&gt;2026-01-01</code> <code>"phrase"</code> <code>-exclude</code></Empty>
        : loading ? <Loading /> : error ? <ErrorBox error={error} /> : (
          <>
            <p class="muted" role="status">{data.total} result{data.total === 1 ? '' : 's'} in {data.ms} ms</p>
            {data.results.length ? <ol class="results">{data.results.map(r => (
              <li><a class="result-title" href={`/p/${r.id}`}>{typeIcon(r.type)} {r.title}</a> <small class="muted">{r.space} · {r.kind === 'blog' ? 'blog · ' : ''}updated {timeAgo(r.updated_at)} by {r.updated_by}</small>
                <div class="snippet" dangerouslySetInnerHTML={{ __html: r.snippet }} />
                <div>{r.tags.slice(0, 6).map(t => <TagChip tag={t} />)}</div></li>))}</ol>
              : <Empty>No pages match. Try fewer words, or <a href={`/ask?q=${encodeURIComponent(q)}`}>ask a question</a>.</Empty>}
            <div class="pager">
              {page > 0 && <a class="btn" href={`/search?q=${encodeURIComponent(q)}&page=${page - 1}`}>← Previous</a>}
              {(page + 1) * 20 < data.total && <a class="btn" href={`/search?q=${encodeURIComponent(q)}&page=${page + 1}`}>Next →</a>}
            </div>
          </>)}
    </div>
  );
}
