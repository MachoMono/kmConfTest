import { useState } from 'preact/hooks';
import { api, navigate, toast, errorToast, timeAgo, fmtDate } from '../lib.js';
import { useAsync, Loading, ErrorBox, Avatar } from '../ui.jsx';

export default function History({ params }) {
  const page = useAsync(() => api.get(`/pages/${params.id}?track=0`), [params.id]);
  const hist = useAsync(() => api.get(`/pages/${params.id}/history`), [params.id]);
  const [sel, setSel] = useState([]);
  const [diff, setDiff] = useState(null);
  const [view, setView] = useState(null);
  if (page.loading || hist.loading) return <Loading />;
  if (page.error || hist.error) return <ErrorBox error={page.error || hist.error} />;
  const versions = hist.data;
  const toggle = (rev) => setSel(s => s.includes(rev) ? s.filter(x => x !== rev) : [...s, rev].slice(-2));
  const compare = async (from, to) => {
    try { setView(null); setDiff({ from, to, ...(await api.get(`/pages/${params.id}/diff?from=${from}&to=${to}`)) }); } catch (e) { errorToast(e); }
  };
  const order = (a, b) => versions.findIndex(v => v.rev === a) > versions.findIndex(v => v.rev === b) ? [a, b] : [b, a];
  const restore = async (rev) => {
    if (!confirm('Restore this version? A new version will be created; nothing is lost.')) return;
    try { await api.post(`/pages/${params.id}/restore`, { rev }); toast('Version restored', 'success'); navigate(`/p/${params.id}`); } catch (e) { errorToast(e); }
  };
  return (
    <div class="narrow wide">
      <nav class="breadcrumbs"><a href={`/p/${params.id}`}>← {page.data.page.title}</a></nav>
      <h1>Page history</h1>
      <p class="muted">Every published change is a version. Select two versions to compare them.</p>
      <div class="history-actions">
        <button class="btn" disabled={sel.length !== 2} onClick={() => { const [a, b] = order(sel[0], sel[1]); compare(a, b); }}>Compare selected</button>
      </div>
      <table class="grid-table history">
        <thead><tr><th /><th>Version</th><th>Changed by</th><th>When</th><th>Description</th><th /></tr></thead>
        <tbody>{versions.map((v, i) => (
          <tr class={sel.includes(v.rev) ? 'selected' : ''}>
            <td><input type="checkbox" aria-label={`Select version ${v.version}`} checked={sel.includes(v.rev)} onChange={() => toggle(v.rev)} /></td>
            <td><strong>v{v.version}</strong>{i === 0 && <span class="pill green">current</span>} <code class="muted">{v.rev.slice(0, 7)}</code></td>
            <td><Avatar name={v.author} size={20} /> {v.author}</td>
            <td title={fmtDate(v.date)}>{timeAgo(v.date)}</td>
            <td>{v.message}{/auto-merged/.test(v.message) && <span class="pill">merged</span>}</td>
            <td class="nowrap">
              <button class="link" onClick={async () => { setDiff(null); try { setView({ v, ...(await api.get(`/pages/${params.id}/versions/${v.rev}`)) }); } catch (e) { errorToast(e); } }}>View</button>
              {versions[i + 1] && <button class="link" onClick={() => compare(versions[i + 1].rev, v.rev)}>Changes</button>}
              {i > 0 && page.data.perms.edit && <button class="link" onClick={() => restore(v.rev)}>Restore</button>}
            </td>
          </tr>))}</tbody>
      </table>
      {diff && <section class="card diff-view" aria-label="Differences">
        <h2>Changes <small class="muted">{diff.from.slice(0, 7)} → {diff.to.slice(0, 7)} · +{diff.stats.added} / −{diff.stats.removed} lines</small></h2>
        {diff.meta.length > 0 && <ul class="meta-diff">{diff.meta.map(m => <li><strong>{m.field}</strong>: <del>{JSON.stringify(m.from)}</del> → <ins>{JSON.stringify(m.to)}</ins></li>)}</ul>}
        <div class="diff" dangerouslySetInnerHTML={{ __html: diff.html }} />
      </section>}
      {view && <section class="card" aria-label="Version preview">
        <h2>Version v{view.v.version} <small class="muted">by {view.v.author}, {fmtDate(view.v.date)}</small></h2>
        <h1>{view.title}</h1>
        <div class="page-content rendered" dangerouslySetInnerHTML={{ __html: view.html }} />
      </section>}
    </div>
  );
}
