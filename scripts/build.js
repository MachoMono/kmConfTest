// Bundles the SPA with esbuild: ESM + code splitting (editor, graph, admin, mermaid and
// highlight.js load lazily), content-hashed immutable assets, and an index.html shell.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const out = path.join(root, 'web/dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
const t0 = Date.now();
const result = await esbuild.build({
  entryPoints: { app: path.join(root, 'web/src/main.jsx'), styles: path.join(root, 'web/src/styles.css') },
  bundle: true, splitting: true, format: 'esm', outdir: path.join(out, 'assets'), entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]',
  minify: process.env.NODE_ENV !== 'development', sourcemap: true, target: ['es2022'], jsx: 'automatic', jsxImportSource: 'preact',
  loader: { '.js': 'jsx' }, metafile: true, logLevel: 'warning', legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
});
const outputs = Object.entries(result.metafile.outputs);
const find = (entry) => path.basename(outputs.find(([, o]) => o.entryPoint && o.entryPoint.endsWith(entry))[0]);
const js = find('main.jsx');
const css = outputs.map(([f]) => path.basename(f)).find(f => /^styles-.*\.css$/.test(f));
const stylesJs = outputs.map(([f]) => path.basename(f)).find(f => /^styles-.*\.js$/.test(f));
if (stylesJs) fs.rmSync(path.join(out, 'assets', stylesJs), { force: true });
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitWiki</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/${css}">
<script type="module" src="/assets/${js}"></script>
</head>
<body><div id="app"></div><noscript>GitWiki needs JavaScript enabled.</noscript></body>
</html>
`);
for (const f of fs.readdirSync(path.join(root, 'web/public'))) fs.copyFileSync(path.join(root, 'web/public', f), path.join(out, f));
const size = (f) => (fs.statSync(path.join(out, 'assets', f)).size / 1024).toFixed(0) + ' KB';
console.log(`built in ${Date.now() - t0} ms: ${js} (${size(js)}), ${css} (${size(css)}), ${outputs.filter(([f]) => f.endsWith('.js')).length} js files`);
