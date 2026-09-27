// Isomorphic HTML -> Markdown converter. Inverse of shared/markdown.js: the WYSIWYG editor
// (and importers) hand us HTML, and we store clean, Obsidian-compatible Markdown in git.
import TurndownService from 'turndown';

function attr(node, name) { return node.getAttribute ? node.getAttribute(name) : null; }
function hasClass(node, cls) {
  return node.nodeType === 1 && (' ' + (node.getAttribute('class') || '') + ' ').includes(' ' + cls + ' ');
}
function cellText(content) {
  return content.trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|');
}

function embedMd(n) {
  const a = attr(n, 'data-anchor');
  return `\n\n![[${attr(n, 'data-target')}${a ? '#' + a : ''}]]\n\n`;
}
function macroMd(n) {
  const params = attr(n, 'data-params') || '';
  return `\n\n\`\`\`${attr(n, 'data-macro')}\n${params}${params ? '\n' : ''}\`\`\`\n\n`;
}

let _svc;
function service() {
  if (_svc) return _svc;
  const td = new TurndownService({
    headingStyle: 'atx', hr: '---', bulletListMarker: '-', codeBlockStyle: 'fenced',
    emDelimiter: '_', strongDelimiter: '**', linkStyle: 'inlined',
    // Macro/embed placeholders are empty divs; turndown would otherwise drop them as blank.
    blankReplacement: (content, node) => {
      if (node.nodeName === 'DIV' && hasClass(node, 'macro')) return macroMd(node);
      if (node.nodeName === 'DIV' && hasClass(node, 'embed')) return embedMd(node);
      return node.isBlock ? '\n\n' : '';
    },
  });
  const baseEscape = td.escape.bind(td);
  td.escape = (s) => baseEscape(s).replace(/<(?=[A-Za-z/!])/g, '&lt;');
  td.keep(['u', 'mark', 'sub', 'sup', 'kbd']);

  const inner = (node) => td.turndown(node.innerHTML || '').trim();

  td.addRule('wikilink', {
    filter: (n) => n.nodeName === 'A' && hasClass(n, 'wikilink'),
    replacement: (content, n) => {
      const target = attr(n, 'data-target') || content;
      const anchor = attr(n, 'data-anchor');
      const alias = attr(n, 'data-alias');
      return `[[${target}${anchor ? '#' + anchor : ''}${alias ? '|' + alias : ''}]]`;
    },
  });
  td.addRule('tag', {
    filter: (n) => (n.nodeName === 'A' || n.nodeName === 'SPAN') && hasClass(n, 'tag'),
    replacement: (content, n) => '#' + (attr(n, 'data-tag') || content.replace(/^\\?#/, '')),
  });
  td.addRule('mention', {
    filter: (n) => n.nodeName === 'SPAN' && hasClass(n, 'mention'),
    replacement: (content, n) => '@' + (attr(n, 'data-user') || content.replace(/^@/, '')),
  });
  td.addRule('status', {
    filter: (n) => n.nodeName === 'SPAN' && hasClass(n, 'status'),
    replacement: (content, n) => `{{status:${attr(n, 'data-color') || 'grey'}|${n.textContent.replace(/[{}|]/g, '')}}}`,
  });
  td.addRule('embed', {
    filter: (n) => n.nodeName === 'DIV' && hasClass(n, 'embed'),
    replacement: (_c, n) => embedMd(n),
  });
  td.addRule('macro', {
    filter: (n) => n.nodeName === 'DIV' && hasClass(n, 'macro'),
    replacement: (_c, n) => macroMd(n),
  });
  td.addRule('mermaid', {
    filter: (n) => n.nodeName === 'PRE' && hasClass(n, 'mermaid'),
    replacement: (_c, n) => `\n\n\`\`\`mermaid\n${n.textContent.replace(/\n$/, '')}\n\`\`\`\n\n`,
  });
  td.addRule('callout', {
    filter: (n) => n.nodeName === 'DIV' && hasClass(n, 'callout'),
    replacement: (_c, n) => {
      const type = attr(n, 'data-callout') || 'note';
      const titleEl = n.querySelector('.callout-title');
      const bodyEl = n.querySelector('.callout-body');
      const title = (attr(n, 'data-title') ?? (titleEl ? titleEl.textContent : '')).trim();
      const body = bodyEl ? inner(bodyEl) : '';
      const lines = [`> [!${type}]${title ? ' ' + title : ''}`];
      if (body) for (const l of body.split('\n')) lines.push(l ? '> ' + l : '>');
      return '\n\n' + lines.join('\n') + '\n\n';
    },
  });
  td.addRule('details', {
    filter: 'details',
    replacement: (_c, n) => {
      const sum = n.querySelector('summary');
      const title = sum ? sum.textContent.trim() : 'Details';
      const clone = n.cloneNode(true);
      const s2 = clone.querySelector('summary');
      if (s2) s2.parentNode.removeChild(s2);
      return `\n\n<details><summary>${title.replace(/</g, '&lt;')}</summary>\n\n${inner(clone)}\n\n</details>\n\n`;
    },
  });
  td.addRule('image', {
    filter: 'img',
    replacement: (_c, n) => {
      const wiki = attr(n, 'data-wikiembed');
      if (wiki) return `![[${wiki}]]`;
      const src = attr(n, 'data-src') || attr(n, 'src') || '';
      const alt = (attr(n, 'alt') || '').replace(/[[\]]/g, '');
      const title = attr(n, 'title');
      return `![${alt}](${src.replace(/ /g, '%20')}${title ? ` "${title.replace(/"/g, '')}"` : ''})`;
    },
  });
  td.addRule('listItem', {
    filter: 'li',
    replacement: (content, n, opts) => {
      const parent = n.parentNode;
      let prefix = opts.bulletListMarker + ' ';
      if (parent.nodeName === 'OL') {
        const start = parseInt(attr(parent, 'start') || '1', 10);
        const idx = Array.prototype.indexOf.call(parent.children, n);
        prefix = (start + idx) + '. ';
      }
      const pad = ' '.repeat(prefix.length);
      content = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n' + pad);
      return prefix + content + (n.nextSibling && !/\n$/.test(content) ? '\n' : '');
    },
  });
  td.addRule('taskItem', {
    filter: (n) => n.nodeName === 'LI' && attr(n, 'data-type') === 'taskItem',
    replacement: (_c, n) => {
      const checked = attr(n, 'data-checked') === 'true';
      const clone = n.cloneNode(true);
      for (const l of Array.from(clone.querySelectorAll('label'))) l.parentNode.removeChild(l);
      const body = inner(clone).replace(/\n/g, '\n  ');
      return `- [${checked ? 'x' : ' '}] ${body}` + (n.nextSibling ? '\n' : '');
    },
  });
  // GFM tables (cells may contain <p> from the editor, which must be flattened).
  td.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: (content, n) => {
      const idx = Array.prototype.indexOf.call(n.parentNode.children, n);
      return (idx === 0 ? '| ' : ' ') + cellText(content) + ' |';
    },
  });
  td.addRule('tableRow', {
    filter: 'tr',
    replacement: (content, n) => {
      const table = n.closest ? n.closest('table') : null;
      const rows = table ? Array.from(table.querySelectorAll('tr')) : [];
      let out = '\n' + content;
      if (rows[0] === n) {
        const cols = n.children.length;
        out += '\n' + '|' + ' --- |'.repeat(cols);
      }
      return out;
    },
  });
  td.addRule('table', { filter: 'table', replacement: (content) => '\n\n' + content.replace(/\n\n+/g, '\n').trim() + '\n\n' });
  td.addRule('tableSection', { filter: ['thead', 'tbody', 'tfoot', 'colgroup', 'col'], replacement: (content) => content });
  td.addRule('tableParagraph', {
    filter: (n) => n.nodeName === 'P' && n.parentNode && /^(TD|TH)$/.test(n.parentNode.nodeName),
    replacement: (content, n) => content + (n.nextSibling ? ' <br> ' : ''),
  });
  td.addRule('br', { filter: 'br', replacement: () => '\\\n' });
  td.addRule('strike', { filter: ['del', 's', 'strike'], replacement: (c) => `~~${c}~~` });
  _svc = td;
  return td;
}

/** Convert an HTML fragment into Markdown. */
export function htmlToMarkdown(html) {
  const md = service().turndown(html || '');
  return md.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim() + '\n';
}
