# GitWiki — session handoff (2026-09-27)

**End state (the /goal):** a GitHub-backed CMS that rivals and surpasses Confluence: Markdown pages in git, WYSIWYG so nobody has to write Markdown or touch git, Obsidian-style links and tags, its own ontology, GraphRAG for in-app and external use, silent merge handling, a KM admin panel, enterprise-ready. Plan first (done: `PLAN.md`, 20 refinement passes). **Done when:** all tests (including the A/B suite) pass and every feature is testable.

## Status: feature-complete, all tests green
Last full run: `npm test` exits 0 with **129 tests**: 29 unit, 74 API, 4 A/B, 3 coverage-matrix, 19 Playwright E2E. That run came before the last small visual fixes (see "In progress").

- Coverage matrix: `test/features.json` (~180 features) × `[F:id]` tags in test names. `test/coverage/coverage.test.js` fails on any untested or unknown feature.
- A/B results: merge engine keeps 100% of concurrent edits vs 50% for last-write-wins; GraphRAG recall@5 is 1.000 vs 0.875 for keyword search; boosted ranking MRR 1.0 vs 0.889.
- Performance at 2,000+ pages: search p95 ~9 ms, page view ~6 ms, GraphRAG ~220 ms, save ~55 ms.

## Done in the 2026-09-27 follow-up session
- The visual polish from the screenshot review is finished. The graph (`web/src/pages/Graph.jsx`) now places labels with a greedy screen-space collision pass: hovered, focused and highlighted nodes go first, then nodes by size. Labels are drawn after all nodes.
- The default LLM is now `claude-opus-5-5` (`server/llm.js`, the admin placeholder, and the tests).
- `README.md`, `Dockerfile` and `.dockerignore` are written. The image was built and smoke-tested with podman: seed, login, search, and SPA all worked. The README's curl and MCP examples were checked against a live instance.
- System dark mode (the OS setting, with no in-app theme picked) left callouts, highlights and status chips on light backgrounds, so their text was unreadable. They now use theme tokens in `styles.css` that both dark-mode paths set.
- `.gitignore` now covers `node_modules/`, `data/`, `web/dist/` and `test-results/`.
- `npm test` exits 0, with all 129 tests passing.

## Remaining ideas (optional)
- Real-time CRDT co-editing (Yjs) was deliberately deferred in plan pass 19.
- The graph label pass is O(n²) in the worst case. It's fine at the current scale, but it could use a spatial grid if graphs get very large.
- Nothing is committed yet (repo on `main`, no commits). Commit only when the user asks.

## Layout
- `server/`: plain `node:http`, Node 26 ESM.
  - `app.js`: composition, Settings/feature flags, auth/CSRF handling, JSON access logs.
  - `pages.js`: all mutations run under a reentrant lock (`withLock`, AsyncLocalStorage). This is required; without it, concurrent saves lost edits.
  - `merge.js`: line → word → preferred-side diff3; conflict records store `regionKept`/`regionDiscarded`.
  - `git.js`: `pageLog` follows renames by frontmatter `id`, not `--follow`.
  - Other services: `indexer.js`, `search.js`, `graph.js` (PageRank, Louvain with self-loop fix), `graphrag.js` (weighted RRF: BM25, vectors, graph, explicit-entity list; ontology tag-description seeding), `render.js` (sanitize + macros), `sync.js` (GitHub), `importers.js` (Confluence, Obsidian), `mcp.js`, `oidc.js`, `mailer.js` (SMTP), `llm.js` (Claude via SDK, `claude-opus-5`, fallbacks on).
  - Routes in `api/*.js`.
- `shared/`: isomorphic `markdown.js` (md→html) and `tomd.js` (html→md). Their contract must match the TipTap node `parseHTML`/`renderHTML` in `web/src/editor/nodes.js`.
- `web/src/`: Preact SPA, esbuild bundle (`npm run build` → `web/dist`). The editor is TipTap v3.
- Tests: `test/{unit,api,ab,coverage,e2e}`, helpers in `test/helpers.js`, seed data in `scripts/seed-data.js`. E2E starts `test/e2e/server.js` on port 4799.

## Commands
- `npm test`: full pipeline.
- Single suites: `npm run test:unit`, `test:api`, `test:ab`, `test:coverage`, `test:e2e`.
- Demo: `GITWIKI_ADMIN_PASSWORD=… npm run seed && npm start`, then open http://127.0.0.1:3000. Demo users: alice/password-alice (KM admin), bob, carol, dave (guest).

## Gotchas learned
- In Node 26, `node --test` needs globs, not directories (quoted in `package.json`).
- npm 11 holds install scripts; esbuild still works. Playwright needs chromium-1243, which is already installed.
- Test-owned servers (SMTP, webhooks) must be `unref()`'d and closed in `finally`, or a failing test looks like a hang.
- Nodemailer RFC 2047-encodes subjects; decode them before matching.
- In the editor, block atoms (macros) must move the caret afterwards (`caretAfterBlock`), or the next keystroke replaces them.
- Page tree rows must be rendered by a plain function, not a nested component, or drag-and-drop breaks.
