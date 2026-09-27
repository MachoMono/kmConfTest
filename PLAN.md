# GitWiki — Plan, 20 Refinement/Evaluation Passes, Final Plan

Goal: a GitHub-backed CMS that rivals and surpasses Confluence. Pages are Markdown in git,
but users never have to see Markdown or git. Obsidian-style links/tags, its own ontology,
GraphRAG retrieval for in-app and external systems, silent merge handling, a Knowledge
Management (KM) admin panel, enterprise-ready. End state: all tests pass and every feature
is exercised by automated tests.

---

## v0 — Initial plan

- Node.js server, git CLI for storage, SQLite for indexing, SPA front end with a WYSIWYG editor.
- Pages = `.md` files with YAML frontmatter; one commit per save.
- Wikilinks `[[Page]]`, `#tags`, backlinks, graph view.
- Admin panel: users, spaces, tags.
- Tests: unit + API.

## Refinement passes

Each pass evaluates the current plan against the goal (Confluence parity, "surpasses",
no-markdown/no-git UX, merge handling, ontology/GraphRAG, KM admin, enterprise, speed,
testability), finds the weakest point, and fixes it.

### Pass 1 — Confluence parity audit
Gap: v0 misses most Confluence surface area. Added the full feature inventory (see §F):
spaces, page tree, templates/blueprints, blog posts, page and inline comments, reactions,
labels, watches/notifications, @mentions, tasks, page restrictions, history/diff/restore,
drafts/autosave, export/import, trash, archive, favorites, recently viewed, analytics,
macros (TOC, children, include, excerpt, status, panel/callout, expand, code, content-by-label).

### Pass 2 — Where content vs. operational data lives
Evaluation: putting everything in git makes comments/notifications slow and merge-prone;
putting everything in SQLite breaks "git-backed". Decision:
- **git (source of truth, portable):** pages, blog posts, attachments, space metadata
  (`_space.yml`), templates, ontology (`_system/ontology.yml`), page-level restrictions
  (in frontmatter). Anyone cloning the repo gets the whole knowledge base.
- **SQLite (operational, rebuildable where derived):** users, groups, sessions, API tokens,
  comments, reactions, watches, notifications, audit log, view analytics, drafts, plus
  **derived** indexes (search FTS, link graph, tags, chunks, embeddings) that can be rebuilt
  from git at any time (`reindex`).

### Pass 3 — "Users never write markdown"
Evaluation: a plain contenteditable is not enterprise quality. Decision: TipTap (ProseMirror)
WYSIWYG with slash-command menu, toolbar, `[[` link autocomplete, `#` tag autocomplete,
`@` mention autocomplete, tables, task lists, callouts, macros, images/attachments
(paste/drag-drop). Markdown source mode is optional (toggle) for power users.
Conversion: a single shared (isomorphic) module converts Markdown→HTML (markdown-it + custom
plugins) and HTML→Markdown (turndown + custom rules), so the browser and server agree.
Property-based round-trip test: `md → html → md` must be stable (idempotent after one pass).

### Pass 4 — "Users never interact with git"
Evaluation: commits, authorship and history must be implicit. Decision: every publish is a
commit authored as the user (`--author "Name <email>"`), committer = service account. History
view, diff and restore are UI features backed by `git log`/`git show`. Drafts and autosave
live in SQLite, so the git history only contains meaningful published versions. Power users
can clone the GitHub repo and push; the server pulls and reindexes (webhook + polling).

### Pass 5 — Merge handling without bothering users
Evaluation: "last write wins" loses work; showing conflict markers bothers users. Decision —
a layered auto-merge engine:
1. Every save carries `baseRev` (the commit the editor loaded). If the file has not changed
   since, fast path.
2. Else **3-way line merge** (diff3 via `git merge-file` semantics, implemented in JS for speed
   and testability).
3. On conflicting hunks, **block-level merge** (Markdown blocks: paragraphs, list items, table
   rows) then **word-level merge** inside a conflicting block.
4. Frontmatter is merged **structurally** (union of tags, per-key 3-way).
5. If a true conflict remains (both changed the same words), the newest save wins for that hunk,
   the losing text is preserved in a **conflict record** (visible to KM in the admin panel and
   to the author as a gentle "we merged your change" note, with one-click restore). Nothing is
   ever lost and nobody sees conflict markers.
Same engine is used when syncing with GitHub (remote commits vs. local commits).
Plus presence (who else is editing) via Server-Sent Events to reduce conflicts in the first place.

### Pass 6 — Obsidian semantics fidelity
Added: `[[Page]]`, `[[Page|alias]]`, `[[Page#Heading]]`, `![[Page]]` transclusion,
`![[file.png]]` embeds, nested tags `#team/platform`, frontmatter `tags:` and `aliases:`,
inline fields `key:: value` (Dataview style), unresolved links shown as "create page" links,
backlinks + unlinked mentions, local and global graph view. Link resolution by title, alias or
slug, case-insensitive, space-scoped first then global. Renaming a page rewrites inbound links
(so links never break) — a commit authored by the renamer.

### Pass 7 — Ontology
Evaluation: tags alone are not an ontology. Decision: `_system/ontology.yml` in git, edited
from the KM admin panel, defines:
- **Entity (node) types:** Page, Person, Team, System, Project, Process, Concept, Policy,
  Glossary term, Tag, Space (extensible). A page declares `type:` in frontmatter.
- **Relation types:** `links_to`, `tagged_with`, `in_space`, `child_of`, `authored_by`,
  `mentions`, plus typed ones: `owned_by`, `depends_on`, `part_of`, `supersedes`,
  `related_to`, `implements`, `defined_by` … with domain/range constraints, inverse names.
- **Properties per type** (required/optional, datatype) → validation warnings in editor,
  and the KM "content health" report.
Typed relations come from frontmatter (`owner: "[[Jane Doe]]"`) or inline fields
(`depends_on:: [[Billing API]]`). Tag taxonomy (hierarchy, synonyms, descriptions) also lives
in the ontology so KM can merge/rename/deprecate tags.
Export: JSON-LD (schema.org-aligned context), RDF Turtle, and GraphML.

### Pass 8 — GraphRAG
Evaluation: must work in-app and for other systems, without a mandatory LLM. Decision:
- **Indexing:** pages chunked by heading sections (with breadcrumb context); chunk FTS5 (BM25);
  local dense vectors via feature-hashed TF-IDF (zero external deps, deterministic, testable);
  pluggable embedding provider (OpenAI-compatible/Ollama/…) via admin settings.
- **Graph:** entities (pages, tags, people, spaces) + typed edges from the ontology; unlinked
  mention detection (title/alias occurrence) adds `mentions` edges.
- **Communities:** Louvain-style modularity clustering (label propagation fallback) with
  extractive community summaries (top terms, key pages, central entities).
- **Query modes:** `local` (seed entities from query → k-hop expansion → rank chunks),
  `global` (rank communities → summaries), `hybrid` (default: fused BM25 + vector + graph
  proximity via reciprocal rank fusion).
- **Outputs:** ranked chunks with citations (page, section, rev, URL), entities, relations,
  communities, and a ready-to-use `context` string for any LLM. Optional answer synthesis
  through a configured LLM (Anthropic Claude by default) — off unless configured.
- **Interfaces:** REST (`/api/v1/graphrag/query`), an **MCP server endpoint** (`/mcp`, JSON-RPC
  over HTTP) so AI agents can use the knowledge base as a tool, and "Ask" UI in the app.
- Retrieval respects permissions of the calling principal (API token → user).

### Pass 9 — KM admin panel
Sections: Dashboard (content stats, activity), Users & Groups, Spaces & permissions,
Ontology editor (types, relations, properties, tag taxonomy), Tag management
(rename/merge/delete across all pages as a single commit), Content health (orphans, broken
links, stale / review-overdue pages, untagged, ontology violations, duplicate titles),
Merge/conflict review, Git sync (remote URL, branch, token, status, sync now, webhook secret),
Templates, Audit log (filterable, exportable CSV), Analytics (views, top pages, search
queries with zero results → content gaps), Settings (site name, anonymous access, LLM /
embedding provider, SMTP), API tokens, Webhooks, Reindex/backup.

### Pass 10 — Enterprise requirements
Added: RBAC (global roles: admin, km_admin, user, guest), space roles (admin/editor/commenter/
viewer) for users and groups, page restrictions (view/edit lists inherited down the tree),
password hashing (scrypt), session cookies (HttpOnly, SameSite=Lax, Secure configurable),
CSRF protection (double-submit header), rate limiting on auth, API tokens (hashed at rest),
OIDC SSO (authorization-code + PKCE, group claim mapping) with a mock IdP for tests, SCIM-lite
user provisioning endpoint, audit log of every mutating action, security headers (CSP),
HTML sanitisation of rendered Markdown (no stored XSS), health/readiness endpoints, structured
logs, config via env vars, Dockerfile, backup (git bundle + SQLite backup).

### Pass 11 — Performance
Evaluation: spawning git per read would be slow. Decision:
- Reads come from the working tree + an in-memory LRU of rendered HTML keyed by blob hash.
- Writes are serialised through a single async write queue (no index.lock races);
  commits use `git` plumbing where possible.
- SQLite WAL mode, prepared statements, FTS5.
- Link graph kept in memory (adjacency maps) and rebuilt incrementally per page save.
- Incremental reindex on save and on pull (only changed paths from `git diff --name-status`).
- Front end: one esbuild bundle, gzip/brotli + immutable caching, code-split editor.
- Benchmark test: seed 2,000 pages, assert p95 read/search latency budgets.

### Pass 12 — Testability ("able to test all features")
Decision: three tiers, all run by `npm test`:
1. Unit (node:test): markdown round-trip, wikilink/tag parsing, merge engine (incl.
   property-style randomized concurrent edit tests: no lost text), ontology validation,
   graph/community, search query parser, permission evaluation, OIDC helpers.
2. API integration: boot the server against a temp data dir and a local bare repo acting as
   "GitHub"; exercise every endpoint, including concurrent edits and remote sync conflicts.
3. E2E (Playwright/Chromium): the WYSIWYG editor, slash menu, `[[`/`#`/`@` autocomplete,
   history/diff/restore, comments, admin panel flows, graph view, Ask.
Plus a **feature-coverage matrix** test that maps every item in §F to at least one test id
and fails if a feature is untested.

### Pass 13 — "A/B tests"
Interpretation: the end-state phrase "all ab tests pass" most likely means "all tests pass".
To be safe, we also make it literal: an A/B comparison test suite (`test/ab/`) that compares
variants of key algorithms and asserts the chosen variant is at least as good — e.g.
(A) naive last-write-wins vs (B) our merge engine on randomized concurrent edits (B must lose
zero edits), (A) BM25-only vs (B) hybrid GraphRAG retrieval on a labelled query set (B must have
≥ recall@5), (A) plain FTS search vs (B) tag/graph-boosted search. The admin panel exposes
feature flags so KM can A/B enable features (e.g. hybrid vs. keyword search) per group.

### Pass 14 — Rich content and macros detail
Markdown representation chosen so files stay readable in GitHub/Obsidian:
- Callouts: Obsidian `> [!info] Title` (info, note, tip, warning, danger, success).
- Status lozenge: `{{status:green|Done}}`.
- Macros as fenced blocks: ```` ```toc ````, ```` ```children ````, ```` ```query ```` (Dataview-like
  table: `tag:#x type:System sort:updated`), ```` ```recent ````, ```` ```tasks ````,
  ```` ```mermaid ```` diagrams.
- Expand: `<details><summary>`.
- Tasks: GFM `- [ ]` with `@user` assignee and `📅 YYYY-MM-DD` due date → "My tasks" report.
- Mentions: `@username`.
- Excerpt: first paragraph or `excerpt:` frontmatter; used by include/children macros.
All render server-side safely; mermaid renders client side.

### Pass 15 — Import/Export & migration from Confluence
Surpass point: one-click migration. Import: Confluence space HTML export (zip) →
Markdown pages preserving hierarchy, attachments, and labels→tags; Markdown/Obsidian vault
zip import (links preserved). Export: page as Markdown/HTML/PDF (print stylesheet), space
as zip, whole knowledge base = `git clone`.

### Pass 16 — Notifications & collaboration
Watches (page/space, auto-watch on edit/comment), @mentions, comment replies, task
assignment → in-app notification centre (SSE live) + email outbox (SMTP transport pluggable;
tests assert outbox). Presence: "Alex is editing" avatars. Reactions on pages and comments.
Inline comments anchored by quoted text + context (robust to edits; re-anchored after merge).

### Pass 17 — Git/GitHub sync detail
Content repo at `DATA_DIR/repo` (non-bare working tree, branch `main`). Optional remote
(`https://<token>@github.com/org/kb.git` or any git URL). Sync loop: `fetch` → if diverged,
merge remote into local with our merge engine per file (never produce conflict markers)
→ commit merge → `push`. Triggered by: interval, GitHub webhook (`/api/v1/webhooks/github`,
HMAC-verified), admin "sync now", and after local commits (debounced). Tests use a local
bare repo as the remote plus a second clone acting as a "power user" editing markdown directly.

### Pass 18 — Search experience
Quick search (Ctrl/Cmd-K) with instant results; advanced search page with filters (space,
tag, type, author, updated range) and a small query language (`tag:x space:ENG type:Policy
author:jane "exact phrase" -exclude`); tag-and-graph boosted ranking; highlighted snippets;
search analytics feed KM content-gap report.

### Pass 19 — Simplicity/risk review (cut or defer)
Evaluation of risks: TipTap bundle size (mitigate: lazy-load editor chunk); Yjs real-time
co-editing adds a whole CRDT server — **defer** behind the merge engine + presence (which
already guarantees no lost work); SAML — defer, OIDC covers modern IdPs; PDF generation —
use print CSS rather than a headless browser dependency; embeddings — local hashing default.
Keep dependencies small and well-known: fastify-free plain `node:http` router (fewer moving
parts, faster cold start), `markdown-it`, `turndown`, `sanitize-html`, `yaml`, `diff`,
TipTap, Preact, esbuild, Playwright (dev).

### Pass 20 — Final evaluation against the goal
| Requirement | Covered by |
|---|---|
| GitHub-backed, git versioning | Pass 4, 17 |
| All Confluence functionality | §F inventory, Pass 1/14/15/16/18 |
| Markdown backend, no markdown required | Pass 3, 14 |
| No git exposure unless wanted | Pass 4, 17 |
| Obsidian-style tagging/linking | Pass 6 |
| Own ontology | Pass 7 |
| GraphRAG in-app & for other systems | Pass 8 (REST + MCP) |
| Fast and efficient | Pass 11 (+ perf test) |
| Merge issues handled silently | Pass 5, 17 |
| KM admin panel | Pass 9 |
| Enterprise ready | Pass 10 |
| All (A/B) tests pass, all features testable | Pass 12, 13 |
Verdict: plan is complete; proceed to build.

---

## Final architecture

```
server/            Node 26 ESM, plain node:http router
  index.js         boot, routes, static
  config.js
  db.js            node:sqlite schema + migrations
  git.js           git CLI wrapper + serial write queue
  store.js         page/space/attachment persistence in the repo
  markdown/        shared md<->html (also bundled for browser)
  merge.js         3-way line/block/word + frontmatter merge engine
  links.js         wikilinks, tags, inline fields, mentions, tasks parsing
  indexer.js       FTS, link graph, tags, chunks, vectors
  ontology.js      ontology load/validate/export (JSON-LD, Turtle, GraphML)
  graphrag.js      communities, local/global/hybrid retrieval
  mcp.js           MCP JSON-RPC endpoint
  auth.js          sessions, passwords, tokens, OIDC, CSRF, rate limit
  perms.js         RBAC + space roles + page restrictions
  sync.js          GitHub remote sync
  notify.js        watches, notifications, SSE, email outbox
  importers/       confluence html zip, markdown zip
  api/*.js         route modules
web/               Preact SPA + TipTap editor, bundled by esbuild
test/unit, test/api, test/ab, test/e2e, test/coverage-matrix
```

## §F Feature inventory (each must map to ≥1 test)
See `test/features.json` — the coverage-matrix test enforces it.
