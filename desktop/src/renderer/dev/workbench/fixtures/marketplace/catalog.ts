// Marketplace overhaul fixture (design 2026-08-27): the catalog block for the
// sampled plugins in registry.ts, the member rows that a real catalog would
// ship for skills/specialists/tools living INSIDE bundles, a few standalone
// items mirrored from the sources the strategy doc ranks first, and fake
// feedback (thumbs + comments) served by worker-api-mock.ts.
//
// SHAPES mirror the Worker's GET /catalog contract: `{ generated_at, entries }`
// where each entry is an index.json row plus a `catalog` block. That contract is
// real now (wecoded-marketplace worker/src/catalog/), so this file is no longer a
// guess about the shape — keep it in step with catalog-types.ts.
//
// The VALUES are still invented: capabilities here are what a file scan would
// plausibly find, not what these plugins actually do. The real catalog computes
// them from the files at each repo's current commit. The workbench never talks to
// the network, so nothing in this file ships.
/* eslint-disable */
import type { SkillEntry } from '../../../../../shared/types';
import type { CatalogMeta, Capability } from '../../../../../shared/catalog-types';

const adds = (label: string): Capability => ({ kind: 'adds', label });
const net = (host: string): Capability => ({ kind: 'network', label: 'Connects to the internet', detail: host });
const key = (name: string, where: string): Capability => ({ kind: 'secret', label: `Needs a ${where} key`, detail: name });
const shell = (label = 'Runs commands on your computer'): Capability => ({ kind: 'shell', label });
const files = (label: string): Capability => ({ kind: 'files', label });
const auto = (label: string): Capability => ({ kind: 'auto', label });

const CHECKED = { status: 'checked' as const, checkedAt: '2026-08-25T09:00:00Z' };
const UNCHECKED = { status: 'unchecked' as const };
const OFFICIAL = 'anthropics/claude-plugins-official';

/** Catalog block per registry id. Plugins absent here render as
 *  "plugin · community · not checked yet" — the honest default. */
export const CATALOG_META: Record<string, CatalogMeta> = {
  'civic-report': {
    itemType: 'plugin',
    origin: { tier: 'youcoded' },
    scan: CHECKED,
    capabilities: [net('api.congress.gov'), key('CONGRESS_API_KEY', 'Congress.gov'), files('Saves reports to your Encyclopedia'), adds('Adds 1 skill and 1 command')],
    license: 'MIT', sourceCommit: '4f1c2a9',
  },
  'youcoded-encyclopedia': {
    itemType: 'plugin',
    origin: { tier: 'youcoded' },
    scan: CHECKED,
    capabilities: [files('Reads and writes your Encyclopedia folder'), adds('Adds 5 skills')],
    license: 'MIT', sourceCommit: 'b7e0d13',
  },
  'superpowers': {
    itemType: 'plugin',
    origin: { tier: 'verified', mirroredFrom: OFFICIAL },
    scan: CHECKED,
    capabilities: [auto('Runs when a conversation starts, to load its rules'), adds('Adds 14 skills')],
    license: 'MIT', sourceCommit: 'e91a6c0',
  },
  'youcoded-inbox': { itemType: 'plugin', origin: { tier: 'youcoded' }, scan: CHECKED, capabilities: [files('Reads and writes your Inbox folder'), adds('Adds 1 skill')], license: 'MIT', sourceCommit: '0a2f77e' },
  'wecoded-themes-plugin': { itemType: 'plugin', origin: { tier: 'youcoded' }, scan: CHECKED, capabilities: [files('Writes theme packs to your themes folder'), adds('Adds 1 skill')], license: 'MIT', sourceCommit: 'c3d9e11' },
  'remember': { itemType: 'plugin', origin: { tier: 'community', mirroredFrom: OFFICIAL }, scan: CHECKED, capabilities: [files('Keeps notes in a memory file in your project'), adds('Adds 1 skill and 1 command')], license: 'MIT', sourceCommit: '7d21b5f' },
  'notion': {
    itemType: 'plugin',
    origin: { tier: 'verified', mirroredFrom: OFFICIAL },
    scan: CHECKED,
    capabilities: [net('api.notion.com'), key('NOTION_TOKEN', 'Notion'), adds('Adds 6 commands and 1 connection')],
    license: 'MIT', sourceCommit: '12ab9c4',
  },
  'skill-creator': { itemType: 'plugin', origin: { tier: 'verified', mirroredFrom: OFFICIAL }, scan: CHECKED, capabilities: [files('Writes new skill folders into your project'), adds('Adds 1 skill')], license: 'Apache-2.0', sourceCommit: '5e6f7a8' },
  'plugin-dev': { itemType: 'plugin', origin: { tier: 'verified', mirroredFrom: OFFICIAL }, scan: CHECKED, capabilities: [adds('Adds 7 skills, 1 command and 3 specialists')], license: 'Apache-2.0', sourceCommit: '9b8c7d6' },
  'mcp-server-dev': { itemType: 'plugin', origin: { tier: 'verified', mirroredFrom: OFFICIAL }, scan: CHECKED, capabilities: [adds('Adds 3 skills')], license: 'Apache-2.0', sourceCommit: '3c4d5e6' },
  'wecoded-marketplace-publisher': { itemType: 'plugin', origin: { tier: 'youcoded' }, scan: CHECKED, capabilities: [shell('Runs git and gh to open a pull request for you'), net('github.com'), adds('Adds 1 skill and 1 command')], license: 'MIT', sourceCommit: 'f0e1d2c' },
  'claude-md-management': { itemType: 'plugin', origin: { tier: 'verified', mirroredFrom: OFFICIAL }, scan: CHECKED, capabilities: [files('Edits the CLAUDE.md files in your project'), adds('Adds 1 skill and 1 command')], license: 'Apache-2.0', sourceCommit: 'a1b2c3d' },
  'hookify': {
    itemType: 'plugin',
    origin: { tier: 'verified', mirroredFrom: OFFICIAL },
    scan: CHECKED,
    capabilities: [auto('Creates rules that run automatically before or after tool calls'), adds('Adds 1 skill, 4 commands and 1 specialist')],
    license: 'Apache-2.0', sourceCommit: '6f5e4d3',
  },
  'math-olympiad': { itemType: 'plugin', origin: { tier: 'verified', mirroredFrom: OFFICIAL }, scan: CHECKED, capabilities: [adds('Adds 1 skill')], license: 'Apache-2.0', sourceCommit: '2e3f4a5' },
  'session-report': { itemType: 'plugin', origin: { tier: 'verified', mirroredFrom: OFFICIAL }, scan: UNCHECKED, capabilities: [files('Writes a report file at the end of a session'), adds('Adds 1 skill')], license: 'Apache-2.0', sourceCommit: '8a9b0c1' },
  'ralph-loop': {
    itemType: 'plugin',
    origin: { tier: 'verified', mirroredFrom: OFFICIAL },
    scan: CHECKED,
    capabilities: [auto('Runs every time the assistant stops, and can restart it'), adds('Adds 3 commands and 1 hook')],
    license: 'Apache-2.0', sourceCommit: 'd4e5f6a',
  },
  'code-review': { itemType: 'plugin', origin: { tier: 'verified', mirroredFrom: OFFICIAL }, scan: CHECKED, capabilities: [adds('Adds 1 command')], license: 'Apache-2.0', sourceCommit: 'b2c3d4e' },
  'browser-use': {
    itemType: 'plugin',
    origin: { tier: 'community', mirroredFrom: OFFICIAL },
    scan: {
      status: 'caution',
      checkedAt: '2026-08-26T14:00:00Z',
      findings: ['Downloads and runs a helper program the first time it is used', 'Can open any website and read what is on the page, including pages you are signed in to'],
    },
    capabilities: [shell('Runs a helper program on your computer'), net('any website'), key('BROWSER_USE_API_KEY', 'Browser Use'), adds('Adds 1 connection')],
    license: 'MIT', sourceCommit: '1f2e3d4',
  },
  'synthflow': { itemType: 'plugin', origin: { tier: 'community', mirroredFrom: OFFICIAL }, scan: UNCHECKED, capabilities: [net('api.synthflow.ai'), key('SYNTHFLOW_API_KEY', 'Synthflow'), adds('Adds 2 skills and 1 connection')], license: 'MIT' },
  'aiven': { itemType: 'plugin', origin: { tier: 'community', mirroredFrom: OFFICIAL }, scan: UNCHECKED, capabilities: [net('api.aiven.io'), key('AIVEN_TOKEN', 'Aiven'), adds('Adds 1 skill and 1 connection')], license: 'Apache-2.0' },
  'alloydb': { itemType: 'plugin', origin: { tier: 'verified', mirroredFrom: OFFICIAL }, scan: UNCHECKED, capabilities: [adds('Adds 7 skills')], license: 'Apache-2.0' },
  'azure': { itemType: 'plugin', origin: { tier: 'verified', mirroredFrom: OFFICIAL }, scan: UNCHECKED, capabilities: [net('management.azure.com'), shell('Runs the Azure command-line tool'), adds('Adds 28 skills and 1 connection')], license: 'MIT' },
  'cloudflare': {
    itemType: 'plugin',
    origin: { tier: 'verified', mirroredFrom: OFFICIAL },
    scan: CHECKED,
    capabilities: [net('api.cloudflare.com'), key('CLOUDFLARE_API_TOKEN', 'Cloudflare'), adds('Adds 13 skills, 2 commands and 1 connection')],
    license: 'Apache-2.0', sourceCommit: '7c8d9e0',
  },
  'adobe-for-creativity': { itemType: 'plugin', origin: { tier: 'community', mirroredFrom: OFFICIAL }, scan: UNCHECKED, capabilities: [net('firefly-api.adobe.io'), key('ADOBE_CLIENT_ID', 'Adobe'), adds('Adds 7 skills and 1 connection')] },
  'agent-sdk-dev': { itemType: 'plugin', origin: { tier: 'verified', mirroredFrom: OFFICIAL }, scan: CHECKED, capabilities: [adds('Adds 1 command and 2 specialists')], license: 'Apache-2.0', sourceCommit: '5d6e7f8' },
  'agentforce-adlc': { itemType: 'plugin', origin: { tier: 'verified', mirroredFrom: OFFICIAL }, scan: UNCHECKED, capabilities: [adds('Adds 3 skills and 3 specialists')], license: 'Apache-2.0' },
  'apple-services': {
    itemType: 'plugin',
    origin: { tier: 'youcoded' },
    scan: CHECKED,
    capabilities: [shell('Runs AppleScript to control Mail, Notes, Reminders and Calendar'), files('Reads your Apple app data on this Mac'), adds('Adds 15 skills and 1 command')],
    license: 'MIT', sourceCommit: '9e8d7c6',
  },
};

// ── Member rows ──────────────────────────────────────────────────────────────
// A real catalog ships one row per skill / specialist / tool inside a bundle
// so type-filtered views and search can show them on their own. Ids follow
// `<bundle>/<name>` for the fixture; the catalog design fixes the real scheme.

const SUPERPOWERS_SKILLS: Array<[string, string]> = [
  ['brainstorming', 'Turns a rough idea into a design through a short back-and-forth before any code is written.'],
  ['dispatching-parallel-agents', 'Splits independent work across several helpers at once.'],
  ['executing-plans', 'Works through a written plan step by step, with review checkpoints.'],
  ['finishing-a-development-branch', 'Wraps up a branch: merge, pull request, or clean up — your choice.'],
  ['receiving-code-review', 'Takes review feedback seriously without blindly applying it.'],
  ['requesting-code-review', 'Asks for a review before merging anything substantial.'],
  ['subagent-driven-development', 'Hands each task of a plan to a fresh helper and checks the result.'],
  ['systematic-debugging', 'Finds the cause of a bug before proposing a fix.'],
  ['test-driven-development', 'Writes the failing test first, then the code that makes it pass.'],
  ['using-git-worktrees', 'Keeps each piece of work in its own folder so sessions never collide.'],
  ['using-superpowers', 'Teaches the assistant how to find and use the other skills.'],
  ['verification-before-completion', 'Runs the checks before saying something is done.'],
  ['writing-plans', 'Turns a design into a numbered implementation plan.'],
  ['writing-skills', 'How to write a skill others can reuse.'],
];

function member(bundle: SkillEntry, itemType: CatalogMeta['itemType'], name: string, displayName: string, description: string, extra: Partial<CatalogMeta> = {}): SkillEntry {
  const parent = CATALOG_META[bundle.id];
  return {
    id: `${bundle.id}/${name}`,
    type: 'plugin',
    displayName,
    description,
    category: bundle.category,
    prompt: `/${name}`,
    source: 'marketplace',
    visibility: 'published',
    author: bundle.author,
    version: bundle.version,
    repoUrl: bundle.repoUrl,
    tags: bundle.tags,
    lifeArea: bundle.lifeArea,
    publishedAt: (bundle as any).publishedAt,
    updatedAt: (bundle as any).updatedAt,
    pluginName: bundle.id,
    // Task 21: the UI hides Install on any row whose sourceType the installer
    // cannot take. Members install via their bundle, so they carry its source.
    sourceType: (bundle as any).sourceType ?? 'url',
    sourceRef: (bundle as any).sourceRef ?? bundle.repoUrl,
    catalog: {
      itemType,
      partOf: { id: bundle.id, displayName: bundle.displayName },
      origin: parent?.origin ?? { tier: 'community' },
      scan: parent?.scan ?? { status: 'unchecked' },
      capabilities: [],
      license: parent?.license,
      sourceCommit: parent?.sourceCommit,
      ...extra,
    },
  } as SkillEntry;
}

const title = (name: string) => name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Rows for members of the sampled bundles. */
export function buildMemberEntries(plugins: SkillEntry[]): SkillEntry[] {
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const out: SkillEntry[] = [];
  const sp = byId.get('superpowers');
  if (sp) for (const [name, desc] of SUPERPOWERS_SKILLS) out.push(member(sp, 'skill', name, title(name), desc));
  const pd = byId.get('plugin-dev');
  if (pd) {
    out.push(member(pd, 'specialist', 'agent-creator', 'Agent creator', 'Drafts a new specialist from a one-line brief and checks its instructions for gaps.'));
    out.push(member(pd, 'specialist', 'plugin-validator', 'Plugin validator', 'Reads a plugin folder and reports what is missing or malformed before you publish.'));
    out.push(member(pd, 'specialist', 'skill-reviewer', 'Skill reviewer', 'Reviews a skill the way a picky maintainer would: clarity, triggers, examples.'));
    for (const s of ['skill-development', 'hook-development', 'mcp-integration']) out.push(member(pd, 'skill', s, title(s), `Guide to ${s.replace('-', ' ')} for Claude Code plugins.`));
  }
  const hk = byId.get('hookify');
  if (hk) out.push(member(hk, 'specialist', 'conversation-analyzer', 'Conversation analyzer', 'Reads a past conversation and proposes rules that would have prevented the mistakes in it.'));
  const nt = byId.get('notion');
  if (nt) out.push(member(nt, 'tool', 'notion-mcp', 'Notion', 'Search, read and create pages and database rows in your Notion workspace.', { capabilities: [net('api.notion.com'), key('NOTION_TOKEN', 'Notion')] }));
  const bu = byId.get('browser-use');
  if (bu) out.push(member(bu, 'tool', 'browser-use-mcp', 'Browser Use', 'Gives the assistant a real browser it can drive.', { capabilities: [shell('Runs a helper program on your computer'), net('any website')] }));
  const cf = byId.get('cloudflare');
  if (cf) {
    out.push(member(cf, 'tool', 'cloudflare-mcp', 'Cloudflare', 'Manage Workers, DNS and storage from a conversation.', { capabilities: [net('api.cloudflare.com'), key('CLOUDFLARE_API_TOKEN', 'Cloudflare')] }));
    for (const s of ['workers-best-practices', 'wrangler', 'durable-objects']) out.push(member(cf, 'skill', s, title(s), `Cloudflare guidance: ${s.replace(/-/g, ' ')}.`));
  }
  return out;
}

// ── Standalone rows ──────────────────────────────────────────────────────────
// Items that are NOT bundles — mirrored from the sources ranked first in the
// strategy doc. These are what the "Skills / Tools / Prompts" tabs are for.

const standalone = (e: Partial<SkillEntry> & { id: string; displayName: string; description: string; catalog: CatalogMeta }): SkillEntry => ({
  type: 'plugin',
  category: 'development',
  prompt: `/${e.id.split('/').pop()}`,
  source: 'marketplace',
  visibility: 'published',
  publishedAt: '2026-08-20T00:00:00Z',
  updatedAt: '2026-08-26T00:00:00Z',
  // Task 21: a Connection mirrored from the MCP registry genuinely CANNOT be
  // installed as a plugin yet, so the fixture says so and the workbench shows
  // the real "Open source" state. Everything else clones from git like a plugin.
  sourceType: e.catalog.itemType === 'tool' ? 'mcp-registry' : 'url',
  sourceRef: e.repoUrl ?? '',
  ...e,
} as SkillEntry);

export const STANDALONE_ENTRIES: SkillEntry[] = [
  standalone({
    id: 'awesome-copilot/commit-message',
    displayName: 'Commit message',
    description: 'Writes a clear commit message from the staged changes — one line of intent, then the why.',
    tagline: 'Commit messages that say why, not what.',
    author: 'GitHub',
    version: '1.3.0',
    repoUrl: 'https://github.com/github/awesome-copilot',
    tags: ['git', 'productivity'],
    category: 'development',
    catalog: { itemType: 'skill', origin: { tier: 'verified', mirroredFrom: 'github/awesome-copilot' }, scan: CHECKED, capabilities: [shell('Reads your staged changes with git')], license: 'MIT', sourceCommit: '3a7f9c2' },
  }),
  standalone({
    id: 'awesome-copilot/proofread',
    displayName: 'Proofread',
    description: 'Fixes spelling, grammar and awkward phrasing in a document without changing what it says.',
    tagline: 'A careful second pair of eyes.',
    author: 'GitHub',
    version: '1.0.4',
    repoUrl: 'https://github.com/github/awesome-copilot',
    tags: ['writing'],
    category: 'personal',
    lifeArea: ['school', 'work'],
    catalog: { itemType: 'skill', origin: { tier: 'verified', mirroredFrom: 'github/awesome-copilot' }, scan: CHECKED, capabilities: [], license: 'MIT', sourceCommit: '3a7f9c2' },
  }),
  standalone({
    id: 'mcp-registry/io.github.modelcontextprotocol/filesystem',
    displayName: 'Filesystem',
    description: 'Lets the assistant read, write and search files in folders you choose.',
    tagline: 'Read and write files in folders you pick.',
    author: 'modelcontextprotocol',
    version: '2026.7.1',
    repoUrl: 'https://github.com/modelcontextprotocol/servers',
    tags: ['files'],
    catalog: { itemType: 'tool', origin: { tier: 'verified', mirroredFrom: 'Official MCP Registry' }, scan: CHECKED, capabilities: [files('Reads and writes files in folders you choose')], license: 'MIT', sourceCommit: 'c0ffee1' },
  }),
  standalone({
    id: 'mcp-registry/io.github.someuser/weather-now',
    displayName: 'Weather Now',
    description: 'Current conditions and a 5-day forecast for any city.',
    author: 'someuser',
    version: '0.3.1',
    repoUrl: 'https://github.com/someuser/weather-now-mcp',
    tags: ['fun'],
    category: 'personal',
    catalog: { itemType: 'tool', origin: { tier: 'community', mirroredFrom: 'Official MCP Registry' }, scan: UNCHECKED, capabilities: [net('api.open-meteo.com')] },
  }),
  standalone({
    id: 'awesome-cursorrules/react-best-practices',
    displayName: 'React best practices',
    description: 'A set of instructions that keeps generated React code idiomatic: hooks, composition, no prop drilling.',
    tagline: 'Paste-in rules for cleaner React.',
    author: 'PatrickJS',
    version: '2026.05',
    repoUrl: 'https://github.com/PatrickJS/awesome-cursorrules',
    tags: ['development'],
    catalog: { itemType: 'prompt', origin: { tier: 'community', mirroredFrom: 'PatrickJS/awesome-cursorrules' }, scan: CHECKED, capabilities: [], license: 'CC0-1.0', sourceCommit: '88ab01d' },
  }),
  standalone({
    id: 'awesome-cursorrules/essay-feedback',
    displayName: 'Essay feedback',
    description: 'Instructions that make the assistant critique an essay the way a writing tutor would — structure first, sentences second.',
    tagline: 'Tutor-style feedback on any essay.',
    author: 'PatrickJS',
    version: '2026.05',
    repoUrl: 'https://github.com/PatrickJS/awesome-cursorrules',
    tags: ['writing'],
    category: 'personal',
    lifeArea: ['school'],
    catalog: { itemType: 'prompt', origin: { tier: 'community', mirroredFrom: 'PatrickJS/awesome-cursorrules' }, scan: CHECKED, capabilities: [], license: 'CC0-1.0', sourceCommit: '88ab01d' },
  }),
  standalone({
    id: 'community/security-reviewer',
    displayName: 'Security reviewer',
    description: 'A specialist that reads a change and lists the ways it could be abused, ranked by how likely.',
    tagline: 'Thinks like an attacker so you don\'t have to.',
    author: 'jdoe',
    version: '0.9.0',
    repoUrl: 'https://github.com/jdoe/security-reviewer',
    tags: ['development'],
    catalog: { itemType: 'specialist', origin: { tier: 'community' }, scan: UNCHECKED, capabilities: [shell('Runs the project\'s test and lint commands')] },
  }),
];

/** What `skills.listMarketplace` returns in the workbench: the sampled
 *  bundles with their catalog block, their member rows, and the standalone
 *  items. Order matters for the discovery grid (bundles first, as today). */
export function buildCatalog(plugins: readonly unknown[]): SkillEntry[] {
  // registry.ts is a trimmed copy of the published index and drops sourceType;
  // the UI needs it to know an Install button would work (Task 21), so default
  // the bundles to the git clone every real plugin row uses.
  const bundles = (plugins as SkillEntry[]).map((p) => ({
    sourceType: 'url', sourceRef: (p as any).repoUrl ?? '', ...p, catalog: CATALOG_META[p.id],
  }));
  return [...bundles, ...STANDALONE_ENTRIES, ...buildMemberEntries(bundles)];
}

/** Render-cost plan (docs/archive/investigations/2026-09-18-list-render-cost-sweep.md,
 *  Task 0 step 2b): the workbench `stress` scenario's marketplace. The sampled
 *  catalog is ~60 rows, so "Explore everything" never showed what drawing the
 *  whole list costs; this pads it with generated standalone rows (same shape as
 *  STANDALONE_ENTRIES, unique ids) until it holds `total` entries. */
export function buildStressCatalog(plugins: readonly unknown[], total: number): SkillEntry[] {
  const real = buildCatalog(plugins);
  const extra: SkillEntry[] = [];
  for (let i = 0; real.length + extra.length < total; i++) {
    const src = STANDALONE_ENTRIES[i % STANDALONE_ENTRIES.length];
    extra.push({
      ...src,
      id: `stress/${src.id.split('/').pop()}-${i}`,
      displayName: `${src.displayName} ${i}`,
      prompt: `/${src.id.split('/').pop()}-${i}`,
    });
  }
  return [...real, ...extra];
}

// ── Fake feedback ────────────────────────────────────────────────────────────

export const FAKE_STATS: Record<string, { installs: number; review_count: number; rating: number; thumbs_up: number; thumbs_down: number }> = {
  'civic-report': { installs: 412, review_count: 0, rating: 0, thumbs_up: 118, thumbs_down: 9 },
  'youcoded-encyclopedia': { installs: 1287, review_count: 0, rating: 0, thumbs_up: 402, thumbs_down: 21 },
  'superpowers': { installs: 30984, review_count: 0, rating: 0, thumbs_up: 6210, thumbs_down: 340 },
  'superpowers/brainstorming': { installs: 30984, review_count: 0, rating: 0, thumbs_up: 1504, thumbs_down: 61 },
  'superpowers/test-driven-development': { installs: 30984, review_count: 0, rating: 0, thumbs_up: 980, thumbs_down: 210 },
  'notion': { installs: 8801, review_count: 0, rating: 0, thumbs_up: 1203, thumbs_down: 88 },
  'browser-use': { installs: 15420, review_count: 0, rating: 0, thumbs_up: 2011, thumbs_down: 1290 },
  'plugin-dev': { installs: 5120, review_count: 0, rating: 0, thumbs_up: 640, thumbs_down: 30 },
  'hookify': { installs: 2210, review_count: 0, rating: 0, thumbs_up: 301, thumbs_down: 44 },
  'ralph-loop': { installs: 3980, review_count: 0, rating: 0, thumbs_up: 420, thumbs_down: 260 },
  'cloudflare': { installs: 6600, review_count: 0, rating: 0, thumbs_up: 812, thumbs_down: 40 },
  'remember': { installs: 940, review_count: 0, rating: 0, thumbs_up: 77, thumbs_down: 12 },
  'awesome-copilot/commit-message': { installs: 12030, review_count: 0, rating: 0, thumbs_up: 2980, thumbs_down: 95 },
  'awesome-copilot/proofread': { installs: 3310, review_count: 0, rating: 0, thumbs_up: 700, thumbs_down: 25 },
  'mcp-registry/io.github.modelcontextprotocol/filesystem': { installs: 40210, review_count: 0, rating: 0, thumbs_up: 5100, thumbs_down: 300 },
  'awesome-cursorrules/react-best-practices': { installs: 2100, review_count: 0, rating: 0, thumbs_up: 310, thumbs_down: 60 },
  'wecoded-themes-plugin': { installs: 2004, review_count: 0, rating: 0, thumbs_up: 388, thumbs_down: 14 },
};

export interface FakeComment {
  id: string;
  user_id: string;
  user_login: string;
  user_avatar_url: string;
  text: string;
  created_at: number;
}

const day = 86400;
const now = Math.floor(Date.now() / 1000);
export const FAKE_COMMENTS: Record<string, FakeComment[]> = {
  'civic-report': [
    { id: 'c1', user_id: 'github:1001', user_login: 'maria_k', user_avatar_url: '', text: 'Used this before the midterms to figure out who my rep actually was. The source links are the best part — I could check every claim.', created_at: now - 2 * day },
    { id: 'c2', user_id: 'github:1002', user_login: 'tomsawyer', user_avatar_url: '', text: 'Setup asks for a Congress.gov key. Free, took 2 minutes, but say so in the description?', created_at: now - 9 * day },
  ],
  'superpowers': [
    { id: 'c3', user_id: 'github:1003', user_login: 'devon', user_avatar_url: '', text: 'Brainstorming alone is worth it. It stopped me from building the wrong thing twice this week.', created_at: now - 1 * day },
    { id: 'c4', user_id: 'github:1004', user_login: 'priya', user_avatar_url: '', text: 'Heads up: it adds a hook that runs at the start of every conversation. Fine for me, but you should know.', created_at: now - 4 * day },
    { id: 'c5', user_id: 'github:1005', user_login: 'sam_o', user_avatar_url: '', text: 'Does this work with local models too, or only Claude?', created_at: now - 12 * day },
  ],
  'browser-use': [
    { id: 'c6', user_id: 'github:1006', user_login: 'lena', user_avatar_url: '', text: 'Powerful but be careful — it can see anything your browser is signed in to. I run it in a separate profile.', created_at: now - 3 * day },
    { id: 'c7', user_id: 'github:1007', user_login: 'kwame', user_avatar_url: '', text: 'First run downloaded ~200 MB without asking. Would have liked a prompt.', created_at: now - 20 * day },
  ],
  'superpowers/brainstorming': [
    { id: 'c8', user_id: 'github:1003', user_login: 'devon', user_avatar_url: '', text: 'One question at a time is exactly right. I wish it offered to skip when the answer is obvious.', created_at: now - 5 * day },
  ],
};
