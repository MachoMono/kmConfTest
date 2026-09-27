import { useEffect, useRef, useState } from 'preact/hooks';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY } from 'd3-force';
import { api, navigate, typeIcon, TYPE_ICONS } from '../lib.js';
import { Loading, ErrorBox } from '../ui.jsx';

const TYPE_COLORS = { Document: '#6b7a90', Person: '#e07a5f', Team: '#f2a541', System: '#3d85c6', Project: '#8e6ad8', Process: '#2a9d8f', Policy: '#c0392b',
  Concept: '#e9c46a', Decision: '#9b5de5', Meeting: '#00a6a6', HowTo: '#4caf50', tag: '#a0a7b4', person: '#e07a5f' };
const COMM = ['#3d85c6', '#e07a5f', '#2a9d8f', '#8e6ad8', '#f2a541', '#c0392b', '#4caf50', '#00a6a6', '#9b5de5', '#e9c46a', '#6b7a90', '#d6336c'];

export default function GraphPage({ query }) {
  const canvas = useRef(null);
  const wrap = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [opts, setOpts] = useState({ tags: query.tags !== '0', people: true, color: 'type', depth: Number(query.depth) || 2 });
  const [hover, setHover] = useState(null);
  const [find, setFind] = useState('');
  const [list, setList] = useState(false);
  const [comms, setComms] = useState([]);
  const focus = query.page || null;

  useEffect(() => {
    setData(null);
    const p = new URLSearchParams({ tags: opts.tags ? '1' : '0', people: opts.people ? '1' : '0', depth: String(opts.depth) });
    if (focus) p.set('page', focus);
    api.get('/graph?' + p).then(g => {
      if (query.tag) {
        const t = 'tag:' + query.tag;
        const keep = new Set([t, ...g.edges.filter(e => e.target === t || e.source === t).map(e => e.source === t ? e.target : e.source)]);
        g = { nodes: g.nodes.filter(n => keep.has(n.id)), edges: g.edges.filter(e => keep.has(e.source) && keep.has(e.target)) };
      }
      setData(g);
    }).catch(setError);
    api.get('/graph/communities').then(setComms).catch(() => {});
  }, [focus, opts.tags, opts.people, opts.depth, query.tag]);

  useEffect(() => {
    if (!data || list || !canvas.current) return;
    const cv = canvas.current, ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.current.clientWidth, H = Math.max(480, window.innerHeight - 220);
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const nodes = data.nodes.map(n => ({ ...n }));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const links = data.edges.filter(e => byId.has(e.source) && byId.has(e.target)).map(e => ({ ...e }));
    const deg = new Map();
    for (const l of links) { deg.set(l.source, (deg.get(l.source) || 0) + 1); deg.set(l.target, (deg.get(l.target) || 0) + 1); }
    for (const n of nodes) n.r = n.kind === 'page' ? 4 + Math.min(10, Math.sqrt(deg.get(n.id) || 0) * 1.6) : 3;
    let t = { x: 0, y: 0, k: 1 };
    const sim = forceSimulation(nodes)
      .force('link', forceLink(links).id(d => d.id).distance(l => l.rel === 'tagged_with' ? 95 : 80).strength(0.3))
      .force('charge', forceManyBody().strength(-260).distanceMax(700))
      .force('center', forceCenter(W / 2, H / 2))
      .force('x', forceX(W / 2).strength(0.03)).force('y', forceY(H / 2).strength(0.03))
      .force('collide', forceCollide(d => d.r + (d.kind === 'page' ? 14 : 6)));
    const q = find.trim().toLowerCase();
    const color = (n) => opts.color === 'community' && n.community != null ? COMM[n.community % COMM.length] : TYPE_COLORS[n.kind === 'page' ? n.type : n.kind] || '#888';
    let hovered = null, dragging = null, panning = null;
    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.translate(t.x, t.y); ctx.scale(t.k, t.k);
      const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
      ctx.lineWidth = 1 / t.k;
      for (const l of links) {
        const hl = hovered && (l.source === hovered || l.target === hovered);
        ctx.strokeStyle = hl ? (dark ? '#dde3ea' : '#334') : l.rel === 'tagged_with' ? (dark ? '#3a4150' : '#dfe3ea') : l.rel.startsWith('links') || l.rel === 'embeds' ? (dark ? '#56607a' : '#b9c1cf') : (dark ? '#8a7' : '#6a8');
        ctx.beginPath(); ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y); ctx.stroke();
      }
      for (const n of nodes) {
        const match = q && n.label.toLowerCase().includes(q);
        ctx.fillStyle = color(n);
        ctx.beginPath();
        if (n.kind === 'tag') ctx.rect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2); else ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
        if (n.pageId === focus || match || n === hovered) { ctx.strokeStyle = match ? '#f5b700' : dark ? '#fff' : '#111'; ctx.lineWidth = 2 / t.k; ctx.stroke(); ctx.lineWidth = 1 / t.k; }
      }
      // Labels: greedy collision pass in screen space. Important nodes claim space first; a label that would overlap one already placed is skipped.
      const fs = 11 / Math.max(t.k, 0.8);
      ctx.font = `${fs}px system-ui, sans-serif`;
      ctx.fillStyle = dark ? '#dde3ea' : '#223';
      const must = (n) => n === hovered || n.pageId === focus || (q && n.label.toLowerCase().includes(q));
      const cands = nodes.filter(n => must(n) || n.kind !== 'tag' || t.k > 1.6)
        .sort((a, b) => (must(b) - must(a)) || (b.r - a.r));
      const placed = [];
      for (const n of cands) {
        const text = n.label.slice(0, 40);
        const x = n.x + n.r + 2, y = n.y + 3;
        const sx = x * t.k + t.x, sy = y * t.k + t.y, w = ctx.measureText(text).width * t.k, h = fs * t.k;
        const box = { x0: sx - 2, y0: sy - h, x1: sx + w + 2, y1: sy + 3 };
        if (box.x1 < 0 || box.x0 > W || box.y1 < 0 || box.y0 > H) continue;
        if (!must(n) && placed.some(b => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
        placed.push(box);
        ctx.fillText(text, x, y);
      }
    };
    sim.on('tick', draw);
    const toWorld = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left - t.x) / t.k, y: (e.clientY - r.top - t.y) / t.k }; };
    const pick = (p) => { for (let i = nodes.length - 1; i >= 0; i--) { const n = nodes[i]; if ((n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= (n.r + 3) ** 2) return n; } return null; };
    const onMove = (e) => {
      const p = toWorld(e);
      if (dragging) { dragging.fx = p.x; dragging.fy = p.y; dragging.moved = true; sim.alphaTarget(0.2).restart(); return; }
      if (panning) { t.x = panning.tx + e.clientX - panning.x; t.y = panning.ty + e.clientY - panning.y; draw(); return; }
      const n = pick(p);
      if (n !== hovered) { hovered = n; setHover(n ? { ...n, px: e.offsetX, py: e.offsetY } : null); cv.style.cursor = n ? 'pointer' : 'grab'; draw(); }
    };
    const onDown = (e) => { const n = pick(toWorld(e)); if (n) { dragging = n; n.moved = false; } else panning = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y }; };
    const onUp = () => {
      if (dragging) { const n = dragging; dragging = null; n.fx = null; n.fy = null; sim.alphaTarget(0);
        if (!n.moved) { if (n.kind === 'page') navigate(`/p/${n.pageId}`); else if (n.kind === 'tag') navigate(`/tags/${encodeURIComponent(n.tag)}`); else if (n.kind === 'person') navigate(`/people/${n.username}`); } }
      panning = null;
    };
    const onWheel = (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k = Math.min(6, Math.max(0.2, t.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      t = { k, x: mx - (mx - t.x) * (k / t.k), y: my - (my - t.y) * (k / t.k) };
      draw();
    };
    cv.addEventListener('mousemove', onMove); cv.addEventListener('mousedown', onDown); window.addEventListener('mouseup', onUp); cv.addEventListener('wheel', onWheel, { passive: false });
    return () => { sim.stop(); cv.removeEventListener('mousemove', onMove); cv.removeEventListener('mousedown', onDown); window.removeEventListener('mouseup', onUp); cv.removeEventListener('wheel', onWheel); };
  }, [data, opts.color, find, list]);

  if (error) return <ErrorBox error={error} />;
  const pages = data ? data.nodes.filter(n => n.kind === 'page') : [];
  return (
    <div class="graph-page">
      <div class="graph-toolbar">
        <h1>{focus ? 'Local graph' : query.tag ? `Graph: #${query.tag}` : 'Knowledge graph'}</h1>
        <input placeholder="Highlight…" aria-label="Highlight nodes" value={find} onInput={(e) => setFind(e.target.value)} />
        <label class="inline"><input type="checkbox" checked={opts.tags} onChange={(e) => setOpts({ ...opts, tags: e.target.checked })} /> Tags</label>
        <label class="inline"><input type="checkbox" checked={opts.people} onChange={(e) => setOpts({ ...opts, people: e.target.checked })} /> People</label>
        <label class="inline">Colour <select value={opts.color} onChange={(e) => setOpts({ ...opts, color: e.target.value })}><option value="type">by type</option><option value="community">by topic cluster</option></select></label>
        {focus && <label class="inline">Depth <select value={opts.depth} onChange={(e) => setOpts({ ...opts, depth: +e.target.value })}>{[1, 2, 3].map(d => <option>{d}</option>)}</select></label>}
        {focus && <a class="btn small" href="/graph">Whole graph</a>}
        <button class="btn small" onClick={() => setList(!list)}>{list ? 'Show graph' : 'Show as list'}</button>
        <span class="muted small">{data ? `${pages.length} pages · ${data.edges.length} connections` : ''}</span>
      </div>
      <div class="graph-body">
        <div class="graph-canvas" ref={wrap}>
          {!data ? <Loading /> : list
            ? <table class="grid-table"><thead><tr><th>Node</th><th>Kind</th><th>Type</th><th>Cluster</th><th>Rank</th></tr></thead>
              <tbody>{[...data.nodes].sort((a, b) => b.rank - a.rank).map(n => <tr><td>{n.kind === 'page' ? <a href={`/p/${n.pageId}`}>{n.label}</a> : n.label}</td><td>{n.kind}</td><td>{n.type || ''}</td><td>{n.community ?? ''}</td><td>{n.rank}</td></tr>)}</tbody></table>
            : <canvas ref={canvas} role="img" aria-label={`Knowledge graph with ${pages.length} pages. Use "Show as list" for an accessible view.`} />}
          {hover && !list && <div class="graph-tip" style={`left:${hover.px + 14}px;top:${hover.py + 10}px`}><strong>{hover.kind === 'page' ? typeIcon(hover.type) : ''} {hover.label}</strong><div class="muted small">{hover.kind === 'page' ? `${hover.type} · ${hover.space}` : hover.kind}</div>{hover.excerpt && <div class="small">{hover.excerpt.slice(0, 140)}</div>}</div>}
        </div>
        <aside class="graph-side">
          <h3>Legend</h3>
          <ul class="legend">{Object.keys(TYPE_ICONS).map(k => <li><span class="swatch" style={`background:${TYPE_COLORS[k]}`} />{k}</li>)}<li><span class="swatch sq" style={`background:${TYPE_COLORS.tag}`} />Tag</li></ul>
          <h3>Topic clusters</h3>
          <ol class="clusters">{comms.slice(0, 12).map(c => <li><span class="swatch" style={`background:${COMM[c.id % COMM.length]}`} /><strong>{c.title}</strong> <small class="muted">{c.pages.length} pages</small><div class="muted small">{c.terms.slice(0, 5).join(', ')}</div></li>)}</ol>
        </aside>
      </div>
    </div>
  );
}
