import { api, session, timeAgo, typeIcon } from '../lib.js';
import { useSignal } from '../signal.js';
import { useAsync, Loading, ErrorBox, Empty, Avatar } from '../ui.jsx';

function PageList({ pages, empty }) {
  if (!pages || !pages.length) return <Empty>{empty}</Empty>;
  return <ul class="plist">{pages.map(p => <li><a href={`/p/${p.id}`}>{typeIcon(p.type)} {p.title}</a> <small class="muted">{p.space} · {timeAgo(p.updated_at)}</small></li>)}</ul>;
}

export default function Dashboard() {
  const s = useSignal(session);
  const { data, loading, error } = useAsync(() => api.get('/dashboard'), []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const u = s.user;
  return (
    <div class="dashboard">
      <section class="hero">
        <h1>{u ? `Welcome back, ${u.name.split(' ')[0]}` : 'Welcome'}</h1>
        <p class="muted">Search with <kbd>Ctrl K</kbd>, ask questions on <a href="/ask">Ask</a>, or explore how knowledge connects in the <a href="/graph">graph</a>.</p>
      </section>
      <div class="dash-grid">
        <div class="col">
          {u && <div class="card"><h2>Recently viewed</h2><PageList pages={data.recentlyViewed} empty="Pages you open will show up here." /></div>}
          <div class="card"><h2>Activity</h2>
            {data.activity.length ? <ul class="feed">{data.activity.map(a => (
              <li><Avatar name={a.author} size={24} /> <div><strong>{a.author}</strong> <span class="muted">{a.message.replace(/"[^"]*"/, '').trim().toLowerCase() || 'updated'}</span> <a href={`/p/${a.page.id}`}>{a.page.title}</a>
                <div class="muted small">{a.page.space} · {timeAgo(a.date)}</div></div></li>))}</ul> : <Empty>No activity yet.</Empty>}
          </div>
        </div>
        <div class="col">
          {u && <div class="card"><h2>My open tasks</h2>
            {data.tasks.length ? <ul class="tasklist">{data.tasks.map(t => <li><span class="cb" aria-hidden="true">☐</span> {t.text.replace(/@\S+/g, '').replace(/📅\s*\S+/, '')} {t.due && <span class={'due' + (t.due < new Date().toISOString().slice(0, 10) ? ' overdue' : '')}>{t.due}</span>} <a class="muted small" href={`/p/${t.page_id}`}>{t.title}</a></li>)}</ul>
              : <Empty>No tasks assigned to you. Assign tasks with <code>@name</code> in a task list.</Empty>}</div>}
          {u && <div class="card"><h2>★ Starred</h2><PageList pages={data.favorites} empty="Star pages to keep them handy." /></div>}
          {u && data.drafts.length > 0 && <div class="card"><h2>Unpublished drafts</h2><ul class="plist">{data.drafts.map(d => <li><a href={d.page_id ? `/p/${d.page_id}/edit` : `/new?draft=${encodeURIComponent(d.key)}`}>✎ {d.title || 'Untitled'}</a> <small class="muted">{timeAgo(d.updated_at)}</small></li>)}</ul></div>}
          <div class="card"><h2>Recently updated</h2><PageList pages={data.recentlyUpdated.slice(0, 10)} empty="Nothing yet — create the first page!" /></div>
          {data.blog.length > 0 && <div class="card"><h2>Latest blog posts</h2><PageList pages={data.blog} empty="" /></div>}
        </div>
      </div>
    </div>
  );
}
