// Autocomplete: [[ page links, # tags, @ mentions and the / slash-command menu.
import { Extension } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { api } from '../lib.js';

function popupRenderer(renderItem) {
  let el, items = [], index = 0, props;
  const draw = () => {
    if (!el) return;
    el.innerHTML = '';
    if (!items.length) { const d = document.createElement('div'); d.className = 'suggest-empty'; d.textContent = 'No matches'; el.appendChild(d); return; }
    items.forEach((it, i) => {
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'suggest-item' + (i === index ? ' active' : '');
      d.innerHTML = renderItem(it);
      d.addEventListener('mousedown', (e) => { e.preventDefault(); props.command(it); });
      el.appendChild(d);
    });
    const act = el.querySelector('.active'); if (act) act.scrollIntoView({ block: 'nearest' });
  };
  const place = () => {
    const r = props.clientRect && props.clientRect();
    if (!r || !el) return;
    el.style.left = Math.min(r.left, window.innerWidth - 340) + window.scrollX + 'px';
    el.style.top = r.bottom + window.scrollY + 6 + 'px';
  };
  return {
    onStart(p) { props = p; items = p.items; index = 0; el = document.createElement('div'); el.className = 'suggest-popup'; el.setAttribute('role', 'listbox'); document.body.appendChild(el); draw(); place(); },
    onUpdate(p) { props = p; items = p.items; index = Math.min(index, Math.max(0, items.length - 1)); draw(); place(); },
    onKeyDown({ event }) {
      if (event.key === 'ArrowDown') { index = (index + 1) % Math.max(items.length, 1); draw(); return true; }
      if (event.key === 'ArrowUp') { index = (index - 1 + items.length) % Math.max(items.length, 1); draw(); return true; }
      if (event.key === 'Enter' || event.key === 'Tab') { if (items[index]) { props.command(items[index]); return true; } return false; }
      if (event.key === 'Escape') { el && el.remove(); el = null; return true; }
      return false;
    },
    onExit() { el && el.remove(); el = null; },
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** After inserting a block atom (macro, embed…) put the caret in a paragraph below it, so typing never replaces it. */
export function caretAfterBlock(editor) {
  const sel = editor.state.selection;
  if (sel.node && sel.node.isBlock) editor.chain().focus().createParagraphNear().run();
}

export const SLASH_ITEMS = [
  { title: 'Heading 1', hint: 'Large section heading', icon: 'H1', run: (c) => c.setNode('heading', { level: 1 }) },
  { title: 'Heading 2', hint: 'Medium section heading', icon: 'H2', run: (c) => c.setNode('heading', { level: 2 }) },
  { title: 'Heading 3', hint: 'Small section heading', icon: 'H3', run: (c) => c.setNode('heading', { level: 3 }) },
  { title: 'Bulleted list', hint: 'Simple list', icon: '•', run: (c) => c.toggleBulletList() },
  { title: 'Numbered list', hint: 'Ordered list', icon: '1.', run: (c) => c.toggleOrderedList() },
  { title: 'Task list', hint: 'Checklist with @assignees and 📅 dates', icon: '☑', run: (c) => c.toggleTaskList() },
  { title: 'Table', hint: '3×3 table with header row', icon: '▦', run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  { title: 'Info panel', hint: 'Blue callout', keywords: 'callout note', icon: 'ℹ', run: (c) => c.insertContent({ type: 'callout', attrs: { type: 'info' }, content: [{ type: 'paragraph' }] }) },
  { title: 'Note panel', hint: 'Callout', icon: '📝', run: (c) => c.insertContent({ type: 'callout', attrs: { type: 'note' }, content: [{ type: 'paragraph' }] }) },
  { title: 'Tip panel', hint: 'Green callout', icon: '💡', run: (c) => c.insertContent({ type: 'callout', attrs: { type: 'tip' }, content: [{ type: 'paragraph' }] }) },
  { title: 'Warning panel', hint: 'Yellow callout', icon: '⚠', run: (c) => c.insertContent({ type: 'callout', attrs: { type: 'warning' }, content: [{ type: 'paragraph' }] }) },
  { title: 'Error panel', hint: 'Red callout', icon: '⛔', run: (c) => c.insertContent({ type: 'callout', attrs: { type: 'danger' }, content: [{ type: 'paragraph' }] }) },
  { title: 'Expand', hint: 'Collapsible section', icon: '▸', run: (c) => c.insertContent({ type: 'details', attrs: { summary: 'Click to expand' }, content: [{ type: 'paragraph' }] }) },
  { title: 'Code block', hint: 'Code with syntax highlighting', icon: '</>', run: (c) => c.toggleCodeBlock() },
  { title: 'Diagram (Mermaid)', hint: 'Flowchart, sequence, Gantt…', keywords: 'mermaid chart flow', icon: '◇', run: (c) => c.insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: 'graph TD\n  A[Start] --> B[Finish]' }] }) },
  { title: 'Quote', hint: 'Block quote', icon: '❝', run: (c) => c.toggleBlockquote() },
  { title: 'Divider', hint: 'Horizontal rule', icon: '—', run: (c) => c.setHorizontalRule() },
  { title: 'Status', hint: 'Coloured status lozenge', icon: '◉', run: (c) => c.insertContent({ type: 'status', attrs: { color: 'blue', text: 'IN PROGRESS' } }) },
  { title: 'Link to page', hint: 'Type [[ to search pages', icon: '🔗', run: (c) => c.insertContent('[[') },
  { title: 'Mention someone', hint: 'Type @ to notify a person', icon: '@', run: (c) => c.insertContent('@') },
  { title: 'Date', hint: "Insert today's date", icon: '📅', run: (c) => c.insertContent(new Date().toISOString().slice(0, 10)) },
  { title: 'Table of contents', hint: 'Macro: headings on this page', keywords: 'toc', icon: '☰', run: (c) => c.insertContent({ type: 'macro', attrs: { macro: 'toc', params: '' } }) },
  { title: 'Child pages', hint: 'Macro: list pages below this one', icon: '⤷', run: (c) => c.insertContent({ type: 'macro', attrs: { macro: 'children', params: '' } }) },
  { title: 'Page query', hint: 'Macro: live table of pages by tag/type', keywords: 'dataview report', icon: '⌕', run: (c) => c.insertContent({ type: 'macro', attrs: { macro: 'query', params: 'tag:#' } }) },
  { title: 'Recently updated', hint: 'Macro: latest changes', icon: '⟳', run: (c) => c.insertContent({ type: 'macro', attrs: { macro: 'recent', params: 'limit: 10' } }) },
  { title: 'Task report', hint: 'Macro: open tasks', icon: '☑', run: (c) => c.insertContent({ type: 'macro', attrs: { macro: 'tasks', params: 'assignee: me\ndone: false' } }) },
  { title: 'Tag cloud', hint: 'Macro: popular tags', icon: '#', run: (c) => c.insertContent({ type: 'macro', attrs: { macro: 'tagcloud', params: '' } }) },
  { title: 'Embed page', hint: 'Transclude another page', icon: '↪', run: (c) => { const t = prompt('Page title to embed'); if (t) c.insertContent({ type: 'embed', attrs: { target: t } }); } },
  { title: 'Image / file', hint: 'Upload an attachment', icon: '🖼', run: (c, editor) => { editor.storage.gitwiki?.upload?.(); } },
];

function suggestion(editor, { key, char, items, command, renderItem, allowSpaces = false }) {
  return Suggestion({ editor, char, pluginKey: new PluginKey(key), allowSpaces, items, command, render: () => popupRenderer(renderItem) });
}

export const Autocomplete = Extension.create({
  name: 'gitwikiAutocomplete',
  addOptions() { return { space: null, slash: true }; },
  addStorage() { return { gitwiki: {} }; },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const space = () => this.options.space;
    const plugins = [
      suggestion(editor, {
        key: 'wikilinkSuggest', char: '[[', allowSpaces: true,
        items: async ({ query }) => {
          const q = query.replace(/\]+$/, '');
          const rows = await api.get(`/suggest/pages?q=${encodeURIComponent(q)}&space=${encodeURIComponent(space() || '')}`).catch(() => []);
          const out = rows.map(r => ({ ...r, kind: 'page' }));
          if (q.trim() && !rows.some(r => r.title.toLowerCase() === q.trim().toLowerCase())) out.push({ title: q.trim(), kind: 'new' });
          return out;
        },
        renderItem: (it) => it.kind === 'new' ? `<span class="si-icon">＋</span><span>Link to new page “${esc(it.title)}”</span>` : `<span class="si-icon">📄</span><span>${esc(it.title)}</span><small>${esc(it.space)}</small>`,
        command: ({ editor, range, props }) => {
          const { state } = editor;
          const after = state.doc.textBetween(range.to, Math.min(range.to + 2, state.doc.content.size));
          editor.chain().focus().deleteRange({ from: range.from, to: range.to + (after === ']]' ? 2 : 0) })
            .insertContent([{ type: 'wikilink', attrs: { target: props.title } }, { type: 'text', text: ' ' }]).run();
        },
      }),
      suggestion(editor, {
        key: 'tagSuggest', char: '#',
        items: async ({ query }) => {
          const rows = await api.get(`/suggest/tags?q=${encodeURIComponent(query)}`).catch(() => []);
          const out = rows.slice(0, 8);
          if (query && !rows.some(r => r.tag === query.toLowerCase())) out.push({ tag: query.toLowerCase(), count: 0, isNew: true });
          return out;
        },
        renderItem: (it) => `<span class="si-icon">#</span><span>${esc(it.tag)}</span><small>${it.isNew ? 'new tag' : it.count + ' pages'}</small>`,
        command: ({ editor, range, props }) => editor.chain().focus().deleteRange(range).insertContent([{ type: 'tag', attrs: { tag: props.tag } }, { type: 'text', text: ' ' }]).run(),
      }),
      suggestion(editor, {
        key: 'mentionSuggest', char: '@',
        items: async ({ query }) => (await api.get(`/users?q=${encodeURIComponent(query)}`).catch(() => [])).slice(0, 8),
        renderItem: (it) => `<span class="si-icon">@</span><span>${esc(it.name)}</span><small>@${esc(it.username)}</small>`,
        command: ({ editor, range, props }) => editor.chain().focus().deleteRange(range).insertContent([{ type: 'mention', attrs: { user: props.username } }, { type: 'text', text: ' ' }]).run(),
      }),
    ];
    if (this.options.slash) plugins.push(suggestion(editor, {
      key: 'slashSuggest', char: '/',
      items: ({ query }) => SLASH_ITEMS.filter(i => (i.title + ' ' + i.hint + ' ' + (i.keywords || '')).toLowerCase().includes(query.toLowerCase())).slice(0, 12),
      renderItem: (it) => `<span class="si-icon">${esc(it.icon)}</span><span>${esc(it.title)}</span><small>${esc(it.hint)}</small>`,
      command: ({ editor, range, props }) => { const c = editor.chain().focus().deleteRange(range); props.run(c, editor); c.run(); caretAfterBlock(editor); },
    }));
    return plugins;
  },
});
