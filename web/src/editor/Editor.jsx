import { useEffect, useRef, useState } from 'preact/hooks';
import { Editor as TipTap } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { renderMarkdown } from '../../../shared/markdown.js';
import { htmlToMarkdown } from '../../../shared/tomd.js';
import { Wikilink, Tag, Mention, Status, Callout, Macro, Embed, Details, WikiImage, CodeBlockPlus } from './nodes.js';
import { Autocomplete, SLASH_ITEMS, caretAfterBlock } from './suggest.js';
import { api, toast, errorToast } from '../lib.js';

export function markdownToEditorHtml(md) { return renderMarkdown(md || '', {}); }

function Btn({ title, onClick, active, children, disabled }) {
  return <button type="button" class={'tb' + (active ? ' active' : '')} title={title} aria-label={title} aria-pressed={active ? 'true' : 'false'} disabled={disabled}
    onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{children}</button>;
}

/**
 * WYSIWYG editor over Markdown. Props: markdown, space, pageId, onChange(md), slash (bool).
 * Users never need to see Markdown; "Markdown" toggles a source view for power users.
 */
export default function Editor({ markdown, space, pageId, onChange, slash = true, autofocus = false }) {
  const host = useRef(null);
  const ed = useRef(null);
  const fileInput = useRef(null);
  const [, setTick] = useState(0);
  const [source, setSource] = useState(false);
  const [src, setSrc] = useState(markdown || '');
  const emit = useRef(onChange);
  emit.current = onChange;

  const uploadFiles = async (files) => {
    if (!pageId) { toast('Publish the page once before attaching files.', 'warn'); return; }
    for (const f of files) {
      try {
        const a = await api(`/pages/${pageId}/attachments?name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f, headers: { 'content-type': 'application/octet-stream' } });
        const e = ed.current;
        if (/^image\//.test(f.type)) e.chain().focus().insertContent({ type: 'image', attrs: { src: a.url, alt: a.name, wikiembed: a.name } }).run();
        else e.chain().focus().insertContent({ type: 'text', text: a.name, marks: [{ type: 'link', attrs: { href: `_attachments/${pageId}/${encodeURIComponent(a.name)}` } }] }).run();
        toast(`Attached ${a.name}`, 'success');
      } catch (err) { errorToast(err); }
    }
  };

  useEffect(() => {
    const editor = new TipTap({
      element: host.current,
      extensions: [
        StarterKit.configure({ codeBlock: false, link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer' } } }),
        CodeBlockPlus, TableKit.configure({ table: { resizable: false } }), TaskList, TaskItem.configure({ nested: true }),
        WikiImage.configure({ inline: false }), Wikilink, Tag, Mention, Status, Callout, Macro, Embed, Details,
        Placeholder.configure({ placeholder: 'Start writing… type / for commands, [[ to link a page, # to tag, @ to mention' }),
        Autocomplete.configure({ space, slash }),
      ],
      content: markdownToEditorHtml(markdown),
      autofocus: autofocus ? 'end' : false,
      editorProps: {
        attributes: { class: 'page-content editor-content', 'aria-label': 'Page content', role: 'textbox', 'aria-multiline': 'true' },
        handlePaste: (_v, event) => {
          const files = [...(event.clipboardData?.files || [])];
          if (files.length) { uploadFiles(files); return true; }
          return false;
        },
        handleDrop: (_v, event) => {
          const files = [...(event.dataTransfer?.files || [])];
          if (files.length) { event.preventDefault(); uploadFiles(files); return true; }
          return false;
        },
      },
      onUpdate: ({ editor }) => emit.current && emit.current(htmlToMarkdown(editor.getHTML())),
      onSelectionUpdate: () => setTick(t => t + 1),
      onTransaction: () => setTick(t => t + 1),
    });
    editor.storage.gitwikiAutocomplete.gitwiki.upload = () => fileInput.current && fileInput.current.click();
    ed.current = editor;
    window.__gitwikiEditor = editor; // exposed for tests/automation
    return () => { editor.destroy(); ed.current = null; };
  }, []);

  const e = ed.current;
  const chain = () => e.chain().focus();
  const toggleSource = () => {
    if (!source) { setSrc(htmlToMarkdown(e.getHTML())); setSource(true); }
    else { e.commands.setContent(markdownToEditorHtml(src)); emit.current && emit.current(src); setSource(false); }
  };
  const inTable = e && e.isActive('table');
  const setLink = () => {
    const prev = e.getAttributes('link').href || '';
    const url = prompt('Link URL (or page title for an internal link)', prev);
    if (url === null) return;
    if (!url) { chain().unsetLink().run(); return; }
    if (/^(https?:|mailto:|\/)/.test(url)) chain().extendMarkRange('link').setLink({ href: url }).run();
    else chain().insertContent({ type: 'wikilink', attrs: { target: url } }).run();
  };
  const block = e ? (e.isActive('heading', { level: 1 }) ? 'h1' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : e.isActive('codeBlock') ? 'code' : 'p') : 'p';

  return (
    <div class="editor">
      <div class="toolbar" role="toolbar" aria-label="Formatting">
        <Btn title="Undo (Ctrl+Z)" onClick={() => chain().undo().run()} disabled={!e || source}>↶</Btn>
        <Btn title="Redo (Ctrl+Shift+Z)" onClick={() => chain().redo().run()} disabled={!e || source}>↷</Btn>
        <span class="sep" />
        <select class="tb-select" aria-label="Text style" value={block} disabled={!e || source} onChange={(ev) => {
          const v = ev.target.value;
          if (v === 'p') chain().setParagraph().run(); else if (v === 'code') chain().setCodeBlock().run(); else chain().setHeading({ level: +v[1] }).run();
        }}>
          <option value="p">Normal text</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option><option value="code">Code block</option>
        </select>
        <Btn title="Bold (Ctrl+B)" active={e && e.isActive('bold')} onClick={() => chain().toggleBold().run()} disabled={source}><b>B</b></Btn>
        <Btn title="Italic (Ctrl+I)" active={e && e.isActive('italic')} onClick={() => chain().toggleItalic().run()} disabled={source}><i>I</i></Btn>
        <Btn title="Underline (Ctrl+U)" active={e && e.isActive('underline')} onClick={() => chain().toggleUnderline().run()} disabled={source}><u>U</u></Btn>
        <Btn title="Strikethrough" active={e && e.isActive('strike')} onClick={() => chain().toggleStrike().run()} disabled={source}><s>S</s></Btn>
        <Btn title="Inline code" active={e && e.isActive('code')} onClick={() => chain().toggleCode().run()} disabled={source}>{'<>'}</Btn>
        <Btn title="Link" active={e && e.isActive('link')} onClick={setLink} disabled={source}>🔗</Btn>
        <span class="sep" />
        <Btn title="Bulleted list" active={e && e.isActive('bulletList')} onClick={() => chain().toggleBulletList().run()} disabled={source}>•≡</Btn>
        <Btn title="Numbered list" active={e && e.isActive('orderedList')} onClick={() => chain().toggleOrderedList().run()} disabled={source}>1≡</Btn>
        <Btn title="Task list" active={e && e.isActive('taskList')} onClick={() => chain().toggleTaskList().run()} disabled={source}>☑</Btn>
        <Btn title="Quote" active={e && e.isActive('blockquote')} onClick={() => chain().toggleBlockquote().run()} disabled={source}>❝</Btn>
        <Btn title="Info panel" onClick={() => chain().insertContent({ type: 'callout', attrs: { type: 'info' }, content: [{ type: 'paragraph' }] }).run()} disabled={source}>ℹ</Btn>
        <Btn title="Insert table" onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} disabled={source}>▦</Btn>
        <Btn title="Insert image or file" onClick={() => fileInput.current.click()} disabled={source}>🖼</Btn>
        <select class="tb-select" aria-label="Insert" value="" disabled={!e || source} onChange={(ev) => {
          const it = SLASH_ITEMS.find(i => i.title === ev.target.value);
          ev.target.value = '';
          if (it) { const c = chain(); it.run(c, e); c.run(); caretAfterBlock(e); }
        }}>
          <option value="">+ Insert…</option>
          {SLASH_ITEMS.map(i => <option value={i.title}>{i.title}</option>)}
        </select>
        {inTable && !source && <span class="table-tools">
          <Btn title="Add row below" onClick={() => chain().addRowAfter().run()}>+row</Btn>
          <Btn title="Add column right" onClick={() => chain().addColumnAfter().run()}>+col</Btn>
          <Btn title="Delete row" onClick={() => chain().deleteRow().run()}>−row</Btn>
          <Btn title="Delete column" onClick={() => chain().deleteColumn().run()}>−col</Btn>
          <Btn title="Delete table" onClick={() => chain().deleteTable().run()}>✕tbl</Btn>
        </span>}
        <span class="grow" />
        <Btn title="Edit as Markdown (optional)" active={source} onClick={toggleSource}>{source ? 'Visual' : 'Markdown'}</Btn>
        <input ref={fileInput} type="file" multiple hidden onChange={(ev) => { uploadFiles([...ev.target.files]); ev.target.value = ''; }} />
      </div>
      <div ref={host} class="editor-host" style={source ? 'display:none' : ''} />
      {source && <textarea class="source" aria-label="Markdown source" value={src} onInput={(ev) => { setSrc(ev.target.value); emit.current && emit.current(ev.target.value); }} />}
    </div>
  );
}
