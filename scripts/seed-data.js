// Demo / fixture knowledge base: people, teams, systems, policies, runbooks and decisions
// wired together with wikilinks, typed relations, tags, tasks and macros.
export const USERS = [
  { username: 'alice', name: 'Alice Chen', email: 'alice@example.com', role: 'km_admin', password: 'password-alice' },
  { username: 'bob', name: 'Bob Martinez', email: 'bob@example.com', role: 'user', password: 'password-bob' },
  { username: 'carol', name: 'Carol Singh', email: 'carol@example.com', role: 'user', password: 'password-carol' },
  { username: 'dave', name: 'Dave Okafor', email: 'dave@example.com', role: 'guest', password: 'password-dave' },
];

export const SPACES = [
  { key: 'ENG', name: 'Engineering', description: 'Systems, architecture and runbooks.' },
  { key: 'HR', name: 'People & HR', description: 'Policies and onboarding.' },
  { key: 'FIN', name: 'Finance', description: 'Finance operations (restricted).' },
];

export const PAGES = [
  { space: 'ENG', title: 'Platform Team', type: 'Team', tags: ['team/platform'], md: `The platform team runs shared infrastructure.\n\nlead:: [[Alice Chen]]\n\n## Members\n\n- @alice\n- @bob\n\n## Systems we own\n\n\`\`\`query\ntype:System owner:platform-team\ncolumns: title, lifecycle, updated\n\`\`\`\n` },
  { space: 'ENG', title: 'Payments Team', type: 'Team', tags: ['team/payments'], md: `The payments team owns billing and invoicing.\n\nlead:: [[Bob Martinez]]\n` },
  { space: 'ENG', title: 'Alice Chen', type: 'Person', tags: ['people'], md: `Staff engineer and knowledge manager.\n\nmember_of:: [[Platform Team]]\n` },
  { space: 'ENG', title: 'Bob Martinez', type: 'Person', tags: ['people'], md: `Engineering manager for payments.\n\nmember_of:: [[Payments Team]]\n` },
  { space: 'ENG', title: 'Billing Service', type: 'System', tags: ['engineering', 'payments'], props: { lifecycle: 'active', owner: '[[Payments Team]]' },
    md: `The **Billing Service** generates invoices, applies discounts and records payments in the [[Ledger Service]].\n\ndepends_on:: [[Ledger Service]]\ndepends_on:: [[Auth Service]]\n\n> [!warning] Month-end freeze\n> No deploys during the last two business days of the month.\n\n## API\n\n| Endpoint | Purpose |\n| --- | --- |\n| POST /invoices | Create an invoice |\n| GET /invoices/:id | Fetch an invoice |\n\n## Operations\n\nSee [[Billing Incident Runbook]] when invoices fail. Status: {{status:green|Healthy}}\n\n- [ ] Document retry policy @carol 📅 2026-10-15\n- [x] Add invoice metrics @bob\n` },
  { space: 'ENG', title: 'Ledger Service', type: 'System', tags: ['engineering', 'payments'], props: { lifecycle: 'active', owner: '[[Payments Team]]' },
    md: `The ledger is the double-entry source of truth for all money movements. Every transfer is immutable and auditable.\n\ndepends_on:: [[Postgres Cluster]]\n\n## Reconciliation\n\nNightly reconciliation compares the ledger with bank statements.\n` },
  { space: 'ENG', title: 'Auth Service', type: 'System', tags: ['engineering', 'security'], props: { lifecycle: 'active', owner: '[[Platform Team]]' },
    md: `Issues OAuth tokens and manages SSO sessions for all internal services.\n\ndepends_on:: [[Postgres Cluster]]\n` },
  { space: 'ENG', title: 'Postgres Cluster', type: 'System', tags: ['engineering', 'database'], props: { lifecycle: 'active', owner: '[[Platform Team]]' },
    md: `Primary relational database cluster with streaming replication and point-in-time recovery.\n\n\`\`\`mermaid\ngraph LR\n  A[Primary] --> B[Replica 1]\n  A --> C[Replica 2]\n\`\`\`\n` },
  { space: 'ENG', title: 'Legacy Invoicing', type: 'System', tags: ['engineering', 'payments'], props: { lifecycle: 'retired' },
    md: `The old invoicing monolith, replaced by [[Billing Service]]. Kept for historical reference.\n` },
  { space: 'ENG', title: 'Billing Incident Runbook', type: 'Process', tags: ['runbook', 'payments'], props: { owner: '[[Payments Team]]' },
    md: `> [!info] When to use\n> Invoices fail to generate or payments are not recorded.\n\n## Steps\n\n1. Check the [[Billing Service#Operations|billing dashboards]].\n2. Verify the [[Ledger Service]] is accepting writes.\n3. Page the on-call via #oncall.\n\n## Escalation\n\nEscalate to @bob if unresolved after 30 minutes.\n` },
  { space: 'ENG', title: 'Database Failover Runbook', type: 'Process', tags: ['runbook', 'database'], props: { owner: '[[Platform Team]]' },
    md: `How to fail over the [[Postgres Cluster]] to a replica.\n\n1. Confirm the primary is down.\n2. Promote the most up-to-date replica.\n3. Update the service discovery record.\n` },
  { space: 'ENG', title: 'ADR 001 Use Event Sourcing for Ledger', type: 'Decision', tags: ['decision', 'architecture'], props: { decision_status: 'accepted' },
    md: `## Context\n\nWe need a complete audit trail of balances in the [[Ledger Service]].\n\n## Decision\n\nUse event sourcing. {{status:green|ACCEPTED}}\n\n## Consequences\n\nReplays are possible; storage grows linearly.\n` },
  { space: 'ENG', title: 'Architecture Overview', type: 'Document', tags: ['architecture', 'engineering'],
    md: `\`\`\`toc\n\`\`\`\n\n## Services\n\nOur core services are [[Billing Service]], [[Ledger Service]] and [[Auth Service]], all backed by the [[Postgres Cluster]].\n\n## Decisions\n\n\`\`\`query\ntype:Decision\ncolumns: title, decision_status, updated\n\`\`\`\n\n## Embedded summary\n\n![[Ledger Service#Reconciliation]]\n` },
  { space: 'ENG', title: 'Glossary: Idempotency', type: 'Concept', tags: ['glossary'], md: `An operation is **idempotent** if repeating it has the same effect as doing it once. The [[Billing Service]] uses idempotency keys on POST /invoices.\n` },
  { space: 'HR', title: 'Onboarding Guide', type: 'HowTo', tags: ['onboarding'], md: `Welcome! Start with the [[ENG:Architecture Overview]] and meet the [[ENG:Platform Team]].\n\n- [ ] Set up your laptop @carol\n- [ ] Read the [[Security Policy]]\n` },
  { space: 'HR', title: 'Security Policy', type: 'Policy', tags: ['policy', 'security'], props: { owner: '[[ENG:Platform Team]]', review_by: '2026-01-31' },
    md: `All employees must use SSO and a hardware security key. Access to production requires approval.\n\n## Passwords\n\nMinimum 14 characters; never reuse passwords.\n` },
  { space: 'HR', title: 'Travel Policy', type: 'Policy', tags: ['policy'], md: `Book travel through the portal. Economy class for flights under six hours.\n` },
  { space: 'FIN', title: 'Quarterly Close Process', type: 'Process', tags: ['finance', 'runbook'], props: { owner: '[[ENG:Payments Team]]' },
    md: `Steps for closing the quarter. Reconcile the [[ENG:Ledger Service]] with bank statements first.\n` },
  { space: 'FIN', title: 'Salary Bands', type: 'Document', tags: ['finance', 'confidential'], md: `Confidential compensation data.\n` },
];

/** Populate an app instance (used by tests, E2E and `npm run seed`). Returns {users, pages}. */
export async function seed(app, { admin } = {}) {
  admin ||= app.users.byUsername(app.cfg.adminUser);
  const users = {};
  for (const u of USERS) users[u.username] = app.users.byUsername(u.username) || app.users.create(u);
  users.admin = admin;
  app.users.createGroup('finance', 'Finance department');
  app.users.setGroupMembers('finance', ['carol']);
  for (const s of SPACES) if (!app.db.get('SELECT 1 FROM spaces WHERE key = ?', s.key)) await app.pages.createSpace(admin, s);
  app.perms.setSpacePerms('FIN', [{ ptype: 'user', principal: 'admin', role: 'admin' }, { ptype: 'group', principal: 'finance', role: 'editor' }]);
  app.perms.setSpacePerms('HR', [{ ptype: 'user', principal: 'admin', role: 'admin' }, { ptype: 'all', principal: '*', role: 'commenter' }, { ptype: 'user', principal: 'carol', role: 'editor' }]);
  const pages = {};
  const author = { ENG: users.alice, HR: users.admin, FIN: users.admin };
  for (const p of PAGES) {
    const r = await app.pages.create(author[p.space], { space: p.space, title: p.title, markdown: p.md, tags: p.tags, type: p.type, props: p.props });
    pages[p.title] = r.page;
  }
  // hierarchy: runbooks under a Runbooks parent
  const rb = await app.pages.create(users.alice, { space: 'ENG', title: 'Runbooks', markdown: 'All operational runbooks.\n\n```children\n```\n', tags: ['runbook'] });
  pages.Runbooks = rb.page;
  for (const t of ['Billing Incident Runbook', 'Database Failover Runbook']) await app.pages.move(users.alice, pages[t].id, { parent: rb.page.id });
  const blog = await app.pages.create(users.bob, { space: 'ENG', kind: 'blog', title: 'Billing Service 2.0 launched', markdown: 'We shipped the new [[Billing Service]]! Thanks @alice.\n' });
  pages.blog = blog.page;
  return { users, pages };
}
