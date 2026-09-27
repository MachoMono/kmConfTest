# GitWiki

A git-backed knowledge base that aims to rival Confluence. Every page is a Markdown file in a git repository, but nobody has to write Markdown or touch git. People edit in a WYSIWYG editor, and concurrent edits merge silently.

- **Editing:** TipTap WYSIWYG editor with a slash menu, templates, tables, tasks, callouts, diagrams (Mermaid) and macros. An optional Markdown source mode round-trips with the visual editor. Drafts autosave.
- **Obsidian-style links:** `[[wikilinks]]`, aliases, embeds, `#tags` (hierarchical), `@mentions`, backlinks and unlinked mentions.
- **Ontology:** typed pages (System, Team, Person, Policy, …) with typed relations (`owner`, `depends_on`, …), a tag taxonomy, and validation. Exports to Turtle, JSON-LD and GraphML.
- **GraphRAG:** hybrid retrieval that fuses BM25, vectors, the link graph and explicit entities with weighted RRF, plus Louvain topic clusters. It powers the in-app **Ask** page (answers from Claude, with citations) and external agents through **MCP**.
- **Silent merges:** a line → word → preferred-side diff3 engine. Edits to the same page by two people both survive, and any discarded region is recorded for KM review.
- **KM admin panel:** content health (orphans, broken links, stale pages, review dates, ontology violations), analytics, tag rename and merge, conflict review, users and groups, settings, feature flags, webhooks, backup, and audit log.
- **Enterprise:** RBAC with space roles and page restrictions, OIDC SSO, SCIM provisioning, API tokens, CSRF protection, SMTP notifications, GitHub sync, Confluence and Obsidian import, JSON access logs, and health/readiness probes.

## Requirements

- Node.js **22.5+** (uses the built-in `node:sqlite`; developed on Node 26)
- `git` on the `PATH`

## Quick start

```sh
npm install
npm run build                                   # bundle the SPA into web/dist
GITWIKI_ADMIN_PASSWORD=change-me npm run seed   # optional: demo content
GITWIKI_ADMIN_PASSWORD=change-me npm start
```

Open http://127.0.0.1:3000 and sign in as `admin`. If `GITWIKI_ADMIN_PASSWORD` isn't set on first start, a random password is generated and printed once.

The seed adds demo users: `alice` / `password-alice` (KM admin), `bob` and `carol` (regular users), and `dave` (guest). Each user's password is `password-<name>`.

## Configuration

Deployment settings come from environment variables. Everything else (SSO, SMTP, the LLM, GitHub sync, feature flags) is configured at runtime in **Admin → Settings** and stored in the database.

| Variable | Default | Purpose |
|---|---|---|
| `GITWIKI_DATA` | `./data` | Data directory. It holds `repo/` (the content git repo) and `gitwiki.db` (SQLite operational data). |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Listen address. Use `HOST=0.0.0.0` in containers. |
| `GITWIKI_BASE_URL` | – | Public URL, used for OIDC redirects and links in emails. |
| `GITWIKI_ADMIN_USER` / `GITWIKI_ADMIN_PASSWORD` | `admin` / random | Bootstrap admin account, created on first start. The password must be at least 8 characters. |
| `GITWIKI_SECURE_COOKIES` | off | Set to `1` behind HTTPS. |
| `GITWIKI_SESSION_HOURS` | `168` | Session lifetime. |
| `GITWIKI_COMMITTER_NAME` / `_EMAIL` | `GitWiki` / `gitwiki@localhost` | Committer identity. The author of each commit is the editing user. |
| `GITWIKI_SYNC_INTERVAL` | `60` | GitHub sync poll interval, in seconds. |
| `GITWIKI_LOG` | `info` | Log level. Access logs are JSON on stdout. |
| `ANTHROPIC_API_KEY` | – | Fallback key for the Ask page when none is set in Admin → Settings → LLM (default model `claude-opus-5-5`). |

### Integrations (Admin → Settings)

- **GitHub sync:** set the remote URL, branch and a token with contents write access. GitWiki pulls on an interval and pushes after saves; upstream edits merge through the same engine. For instant pulls, add a GitHub webhook pointing at `POST /api/v1/webhooks/github` (push events) and set the same secret in `github_webhook_secret`.
- **SSO (OIDC):** set the issuer, client ID and secret. Register `<GITWIKI_BASE_URL>/api/v1/auth/oidc/callback` as the redirect URI. Group claims map to GitWiki groups.
- **SCIM 2.0:** `/scim/v2/Users`, authenticated with an admin API token.
- **Email:** SMTP host, port, credentials and from-address, for watch and mention notifications and review reminders.
- **Embeddings:** the default local embedder needs no network. It can be switched to any OpenAI-compatible `/embeddings` endpoint.

## Docker

```sh
docker build -t gitwiki .
docker run -d -p 3000:3000 -v gitwiki-data:/data \
  -e GITWIKI_ADMIN_PASSWORD=change-me -e GITWIKI_BASE_URL=https://wiki.example.com \
  gitwiki
# optional demo content (run once, same volume):
docker run --rm -v gitwiki-data:/data gitwiki node scripts/seed.js
```

The image runs as the unprivileged `node` user and keeps everything under the `/data` volume. Its health check calls `/healthz`. Back up the volume, or use **Admin → Backup** to download an archive. Podman works the same way; use `--format docker` if you want the `HEALTHCHECK` kept.

## API

REST API under `/api/v1`, JSON in and out.

- **Browser sessions** use a cookie. Mutating requests must send `X-GitWiki-CSRF: 1`.
- **Scripts and integrations** use a personal API token (Profile → API tokens, or `POST /api/v1/auth/tokens`), sent as `Authorization: Bearer <token>`. Token requests don't need the CSRF header.

```sh
TOKEN=...   # from Profile → API tokens
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/v1/search?q=billing+tag:payments"
curl -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"space":"ENG","title":"New page","markdown":"Hello [[Billing Service]] #draft"}' \
  http://localhost:3000/api/v1/pages
```

The main routes are:

| Area | Routes |
|---|---|
| Pages | `GET/PUT/DELETE /pages/:id`, `POST /pages` (`markdown` or `html` body), `…/history`, `…/diff`, `…/versions/:rev`, `…/move`, `…/copy`, `…/archive`, `…/restore`, `…/export`, `…/attachments`, `…/comments`, `…/restrictions`, `…/share`, `…/watch` |
| Spaces | `GET/POST /spaces`, `GET/PUT /spaces/:key`, `…/permissions`, `…/blog`, `…/export`, `POST …/import` (Confluence HTML or Obsidian zip) |
| Discovery | `GET /search`, `GET /tags`, `GET /tags/:tag`, `GET /resolve`, `GET /suggest/pages`, `GET /suggest/tags`, `GET /tasks` |
| Knowledge | `GET /graph`, `/graph/neighbors/:id`, `/graph/communities`, `/graph/export`; `GET/POST /graphrag/query`; `GET/PUT /ontology`, `/ontology/schema.ttl`, `POST /ontology/validate` |
| Collaboration | `GET /events` (SSE), `POST /pages/:id/presence`, `/drafts`, `/notifications`, `/reactions` |
| Admin | `/admin/{overview,health,analytics,audit,conflicts,users,groups,spaces,settings,webhooks,outbox,git,backup}`, `POST /admin/reindex`, `/admin/tags/{rename,delete}` |
| Ops | `GET /healthz`, `GET /readyz` |

## MCP (for external agents)

`POST /mcp` is a Model Context Protocol endpoint (Streamable HTTP, JSON responses). Authenticate with a bearer API token; results respect that user's permissions.

Tools: `search`, `graphrag_query` (returns an LLM-ready context with citations, entities and relations), `get_page`, `list_spaces`, `get_neighbors`, `get_ontology`, `create_page`, `append_to_page` (merged safely with concurrent edits).

```json
{ "mcpServers": { "gitwiki": { "type": "http", "url": "https://wiki.example.com/mcp",
  "headers": { "Authorization": "Bearer <token>" } } } }
```

## Development

```sh
npm run dev          # build + start
npm test             # build, then unit → API → A/B → coverage matrix → Playwright E2E
npm run test:unit    # also: test:api, test:ab, test:coverage, test:e2e
```

- **Coverage matrix:** `test/features.json` lists every feature. Each one must be referenced by an `[F:id]` tag in at least one test name, or `test:coverage` fails.
- **A/B suite:** compares the merge engine with last-write-wins, GraphRAG with keyword search, and boosted ranking with plain BM25.
- **E2E:** starts `test/e2e/server.js` on port 4799 and needs Playwright's Chromium (`npx playwright install chromium`).

The layout:

```
server/      node:http app; api/*.js route modules; pages, merge, git, indexer, search, graph, graphrag, mcp, sync, …
shared/      isomorphic markdown.js (md→html) and tomd.js (html→md); must match web/src/editor/nodes.js
web/src/     Preact SPA and TipTap editor, bundled by esbuild into web/dist
scripts/     build, seed
test/        unit, api, ab, coverage, e2e
```

See `PLAN.md` for the design rationale.
