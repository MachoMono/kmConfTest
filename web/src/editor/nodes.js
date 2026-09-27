// Custom TipTap nodes. Their parseHTML/renderHTML match exactly what shared/markdown.js emits
// and what shared/tomd.js consumes, so WYSIWYG edits round-trip to clean Markdown.
import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { CodeBlock } from '@tiptap/extension-code-block';

const data = (el, k) => el.getAttribute('data-' + k);

export const Wikilink = Node.create({
  name: 'wikilink', group: 'inline', inline: true, atom: true, selectable: true,
  addAttributes() {
    return {
      target: { default: '', parseHTML: el => data(el, 'target') || el.textContent },
      anchor: { default: null, parseHTML: el => data(el, 'anchor') },
      alias: { default: null, parseHTML: el => data(el, 'alias') },
      missing: { default: false, parseHTML: el => el.classList.contains('missing'), renderHTML: () => ({}) },
    };
  },
  parseHTML() { return [{ tag: 'a.wikilink', priority: 1000 }]; },
  renderHTML({ node }) {
    const { target, anchor, alias, missing } = node.attrs;
    const attrs = { class: 'wikilink' + (missing ? ' missing' : ''), href: '#', 'data-target': target };
    if (anchor) attrs['data-anchor'] = anchor;
    if (alias) attrs['data-alias'] = alias;
    return ['a', attrs, alias || (target + (anchor ? ' › ' + anchor : ''))];
  },
  renderText({ node }) { return node.attrs.alias || node.attrs.target; },
  addInputRules() {
    return [new InputRule({
      find: /\[\[([^\]\n]+)\]\]$/,
      handler: ({ state, range, match }) => {
        let inner = match[1], alias = null, anchor = null;
        const p = inner.indexOf('|'); if (p >= 0) { alias = inner.slice(p + 1); inner = inner.slice(0, p); }
        const h = inner.indexOf('#'); if (h >= 0) { anchor = inner.slice(h + 1); inner = inner.slice(0, h); }
        state.tr.replaceWith(range.from, range.to, this.type.create({ target: inner.trim(), anchor, alias }));
      },
    })];
  },
});

export const Tag = Node.create({
  name: 'tag', group: 'inline', inline: true, atom: true,
  addAttributes() { return { tag: { default: '', parseHTML: el => data(el, 'tag') || el.textContent.replace(/^#/, '') } }; },
  parseHTML() { return [{ tag: 'a.tag', priority: 1000 }, { tag: 'span.tag', priority: 1000 }]; },
  renderHTML({ node }) { return ['a', { class: 'tag', href: '#', 'data-tag': node.attrs.tag }, '#' + node.attrs.tag]; },
  renderText({ node }) { return '#' + node.attrs.tag; },
});

export const Mention = Node.create({
  name: 'mention', group: 'inline', inline: true, atom: true,
  addAttributes() { return { user: { default: '', parseHTML: el => data(el, 'user') || el.textContent.replace(/^@/, '') } }; },
  parseHTML() { return [{ tag: 'span.mention', priority: 1000 }]; },
  renderHTML({ node }) { return ['span', { class: 'mention', 'data-user': node.attrs.user }, '@' + node.attrs.user]; },
  renderText({ node }) { return '@' + node.attrs.user; },
});

export const STATUS_COLORS = ['grey', 'blue', 'green', 'yellow', 'red', 'purple'];
export const Status = Node.create({
  name: 'status', group: 'inline', inline: true, atom: true,
  addAttributes() {
    return { color: { default: 'grey', parseHTML: el => data(el, 'color') || 'grey' }, text: { default: 'STATUS', parseHTML: el => el.textContent } };
  },
  parseHTML() { return [{ tag: 'span.status', priority: 1000 }]; },
  renderHTML({ node }) { return ['span', { class: 'status', 'data-color': node.attrs.color }, node.attrs.text]; },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('span');
      dom.className = 'status'; dom.dataset.color = node.attrs.color; dom.textContent = node.attrs.text;
      dom.title = 'Click to edit status';
      dom.addEventListener('click', () => {
        if (!editor.isEditable) return;
        const text = prompt('Status text', node.attrs.text);
        if (text == null) return;
        const color = prompt(`Colour (${STATUS_COLORS.join(', ')})`, node.attrs.color);
        editor.chain().command(({ tr }) => { tr.setNodeMarkup(getPos(), undefined, { text: text.trim() || 'STATUS', color: STATUS_COLORS.includes(color) ? color : node.attrs.color }); return true; }).run();
      });
      return { dom };
    };
  },
});

export const CALLOUT_TYPES = ['info', 'note', 'tip', 'success', 'warning', 'danger', 'question', 'quote', 'example'];
export const Callout = Node.create({
  name: 'callout', group: 'block', content: 'block+', defining: true,
  addAttributes() {
    return {
      type: { default: 'info', parseHTML: el => data(el, 'callout') || 'info' },
      title: { default: '', parseHTML: el => (el.querySelector(':scope > .callout-title') || {}).textContent || data(el, 'title') || '' },
    };
  },
  parseHTML() {
    return [{ tag: 'div.callout', priority: 1000, contentElement: (el) => el.querySelector(':scope > .callout-body') || el }];
  },
  renderHTML({ node }) {
    return ['div', { class: 'callout', 'data-callout': node.attrs.type, 'data-title': node.attrs.title },
      ['div', { class: 'callout-title' }, node.attrs.title || ''], ['div', { class: 'callout-body' }, 0]];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'callout'; dom.dataset.callout = node.attrs.type;
      const head = document.createElement('div'); head.className = 'callout-head'; head.contentEditable = 'false';
      const sel = document.createElement('select'); sel.className = 'callout-type'; sel.setAttribute('aria-label', 'Panel type');
      for (const t of CALLOUT_TYPES) { const o = document.createElement('option'); o.value = t; o.textContent = t; sel.appendChild(o); }
      sel.value = node.attrs.type;
      const title = document.createElement('input'); title.className = 'callout-title-input'; title.placeholder = 'Title (optional)'; title.setAttribute('aria-label', 'Panel title'); title.value = node.attrs.title;
      const update = (attrs) => editor.chain().command(({ tr }) => { tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, ...attrs }); return true; }).run();
      sel.addEventListener('change', () => update({ type: sel.value }));
      title.addEventListener('change', () => update({ title: title.value }));
      title.addEventListener('keydown', (e) => e.stopPropagation());
      head.append(sel, title);
      const body = document.createElement('div'); body.className = 'callout-body';
      dom.append(head, body);
      return {
        dom, contentDOM: body,
        update(n) { if (n.type.name !== 'callout') return false; node = n; dom.dataset.callout = n.attrs.type; sel.value = n.attrs.type; if (document.activeElement !== title) title.value = n.attrs.title; return true; },
        stopEvent: (e) => head.contains(e.target), ignoreMutation: (m) => head.contains(m.target),
      };
    };
  },
});

export const MACRO_LABELS = { toc: 'Table of contents', children: 'Child pages', query: 'Page query', recent: 'Recently updated', tasks: 'Task report', include: 'Include page', tagcloud: 'Tag cloud', excerpt: 'Page excerpt' };
export const Macro = Node.create({
  name: 'macro', group: 'block', atom: true, selectable: true, draggable: true,
  addAttributes() {
    return { macro: { default: 'toc', parseHTML: el => data(el, 'macro') }, params: { default: '', parseHTML: el => data(el, 'params') || '' } };
  },
  parseHTML() { return [{ tag: 'div.macro', priority: 1000 }]; },
  renderHTML({ node }) { return ['div', { class: 'macro', 'data-macro': node.attrs.macro, 'data-params': node.attrs.params }]; },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'macro-chip'; dom.contentEditable = 'false';
      const render = () => {
        dom.innerHTML = '';
        const label = document.createElement('strong'); label.textContent = '⚙ ' + (MACRO_LABELS[node.attrs.macro] || node.attrs.macro);
        const params = document.createElement('code'); params.textContent = node.attrs.params || '(default settings)';
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn small'; btn.textContent = 'Configure';
        btn.addEventListener('click', () => {
          const hint = { query: 'e.g. tag:#runbook type:System\ncolumns: title, owner, updated', children: 'depth: 2\nexcerpt: true', recent: 'limit: 10\nspace: all', tasks: 'assignee: me\ndone: false', include: 'page: Page Title\nsection: Heading', toc: 'maxlevel: 3', tagcloud: 'limit: 50', excerpt: 'page: Page Title' }[node.attrs.macro] || '';
          const v = prompt(`Parameters for ${MACRO_LABELS[node.attrs.macro] || node.attrs.macro} (one per line)\n${hint}`, node.attrs.params);
          if (v == null) return;
          editor.chain().command(({ tr }) => { tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, params: v.replace(/\\n/g, '\n') }); return true; }).run();
        });
        dom.append(label, ' ', params, ' ', btn);
      };
      render();
      return { dom, update(n) { if (n.type.name !== 'macro') return false; node = n; render(); return true; }, stopEvent: (e) => e.target.tagName === 'BUTTON' };
    };
  },
});

export const Embed = Node.create({
  name: 'embed', group: 'block', atom: true, selectable: true, draggable: true,
  addAttributes() { return { target: { default: '', parseHTML: el => data(el, 'target') }, anchor: { default: null, parseHTML: el => data(el, 'anchor') } }; },
  parseHTML() { return [{ tag: 'div.embed', priority: 1000 }]; },
  renderHTML({ node }) { const a = { class: 'embed', 'data-target': node.attrs.target }; if (node.attrs.anchor) a['data-anchor'] = node.attrs.anchor; return ['div', a]; },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'macro-chip embed-chip'; dom.contentEditable = 'false';
      dom.textContent = `↪ Embedded page: ${node.attrs.target}${node.attrs.anchor ? ' › ' + node.attrs.anchor : ''}`;
      return { dom };
    };
  },
});

export const Details = Node.create({
  name: 'details', group: 'block', content: 'block+', defining: true,
  addAttributes() { return { summary: { default: 'Details', parseHTML: el => (el.querySelector(':scope > summary') || {}).textContent || 'Details' } }; },
  parseHTML() {
    return [{ tag: 'details', priority: 1000, contentElement: (el) => {
      const wrap = el.querySelector(':scope > div[data-details-content]');
      if (wrap) return wrap;
      const c = el.cloneNode(true); const s = c.querySelector(':scope > summary'); if (s) s.remove(); return c;
    } }];
  },
  renderHTML({ node }) { return ['details', { open: 'open' }, ['summary', node.attrs.summary], ['div', { 'data-details-content': '' }, 0]]; },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div'); dom.className = 'details-block';
      const head = document.createElement('div'); head.className = 'details-head'; head.contentEditable = 'false';
      const input = document.createElement('input'); input.value = node.attrs.summary; input.className = 'details-summary'; input.setAttribute('aria-label', 'Expand section title');
      input.addEventListener('change', () => editor.chain().command(({ tr }) => { tr.setNodeMarkup(getPos(), undefined, { summary: input.value || 'Details' }); return true; }).run());
      input.addEventListener('keydown', (e) => e.stopPropagation());
      head.append('▸ ', input);
      const body = document.createElement('div'); body.className = 'details-body';
      dom.append(head, body);
      return { dom, contentDOM: body, update(n) { if (n.type.name !== 'details') return false; node = n; if (document.activeElement !== input) input.value = n.attrs.summary; return true; },
        stopEvent: (e) => head.contains(e.target), ignoreMutation: (m) => head.contains(m.target) };
    };
  },
});

export const WikiImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      wikiembed: { default: null, parseHTML: el => data(el, 'wikiembed'), renderHTML: a => a.wikiembed ? { 'data-wikiembed': a.wikiembed } : {} },
      datasrc: { default: null, parseHTML: el => data(el, 'src'), renderHTML: a => a.datasrc ? { 'data-src': a.datasrc } : {} },
    };
  },
});

export const CodeBlockPlus = CodeBlock.extend({
  parseHTML() {
    return [{ tag: 'pre.mermaid', preserveWhitespace: 'full', priority: 60, getAttrs: () => ({ language: 'mermaid' }) }, ...this.parent()];
  },
});

export { mergeAttributes };
