import type { SessionInfo } from '../../../shared/types';
import type { TagRecord } from '../../../shared/tags';
import type { StoredProject } from '../../../shared/permission-types';
import type { FlagName } from '../../components/resume-browser-filters';
import { sessions, siteSessions, studentSessions } from './fixtures/sessions';
import { permissions as seedPermissions, stressPermissions } from './fixtures/permissions';
import { providers as seedProviders, catalog as seedCatalog, type ProviderRow, type CatalogRow } from './fixtures/providers';
import { tags as seedTags, studentTags } from './fixtures/tags';
import { defaults as seedDefaults, type MockDefaults } from './fixtures/defaults';

export type ScenarioId =
  | 'default' | 'empty' | 'no-providers' | 'refused' | 'stress'
  // Status-bar relevance design review (Task 9): each isolates ONE session so the
  // bar is the only thing on screen worth looking at. 'statusbar-cc' reuses wb-1
  // (Claude Code); the other four reuse wb-2 (native) with different totals —
  // see STATUSBAR_TOTALS_OVERRIDE in seed-chat.ts for the exact numbers.
  | 'statusbar-cc' | 'statusbar-local' | 'statusbar-metered' | 'statusbar-unpriced' | 'statusbar-delegated'
  // Landing-page embed + its recorded loops (site/1.3-rebuild).
  | 'site'
  // Welcome back (design 2026-09-24): a cold start after a crash — nothing in
  // the strip, four conversations that were open when the app went down.
  | 'welcome-back';

export const SCENARIO_IDS: readonly ScenarioId[] = [
  'default', 'empty', 'no-providers', 'refused', 'stress',
  'statusbar-cc', 'statusbar-local', 'statusbar-metered', 'statusbar-unpriced', 'statusbar-delegated',
  'site', 'welcome-back',
];

/** A row in the Resume Browser's list. Mirrors ResumeBrowser.tsx's local
 *  `PastSession` — that interface is not exported, so this is a hand-kept copy.
 *  Fields omitted here (device) are optional and unused by the surfaces under
 *  design; add them when a design needs them rather than speculatively —
 *  `lastUsedModel` was added on 2026-07-31 when the card started showing it. */
export interface PastSession {
  sessionId: string;
  name: string;
  projectSlug: string;
  projectPath: string;
  lastModified: number;
  size: number;
  flags?: Partial<Record<FlagName, boolean>>;
  tags?: string[];
  note?: string;
  provider?: string;
  harnessId?: string;
  /** Project folder is not on this device — Resume is disabled. */
  missingProject?: boolean;
  /** Folder is here but the transcript hasn't synced yet — also disabled. */
  notSyncedYet?: boolean;
  /** Model this conversation last ran a turn on. Native sessions only in the
   *  real app — see the long note on ResumeBrowser's copy of this field. */
  lastUsedModel?: { modelId: string; providerType: string; providerLabel: string };
}

/** Per-session tags/note/flags for LIVE sessions — what session.getMeta reads.
 *  Kept separate from `past` because the two are keyed by different id spaces:
 *  a live session's id is never a row in the resume list. The writers mirror
 *  into `past` as well when a row with the same id happens to exist, so the
 *  Resume Browser and the in-session chip can't disagree about the same
 *  conversation. */
export interface MockSessionMeta {
  tags: string[];
  note: string;
  flags: Record<string, boolean>;
}

export interface MockState {
  sessions: SessionInfo[];
  past: PastSession[];
  meta: Record<string, MockSessionMeta>;
  providers: ProviderRow[];
  catalog: CatalogRow[];
  tags: TagRecord[];
  defaults: MockDefaults;
  permissions: StoredProject[];
  /** Welcome back: ids open at the "last shutdown" (session.reopenList). */
  reopen: string[];
}

const PROJECTS = [
  ['/home/destin/youcoded-dev/youcoded', 'youcoded'],
  ['/home/destin/youcoded-dev/wecoded-themes', 'wecoded-themes'],
  ['/home/destin/youcoded-dev/wecoded-marketplace', 'wecoded-marketplace'],
] as const;

// Fixed base timestamp, not Date.now(): a seed that moves with the clock makes
// "2 minutes ago" vs "3 days ago" groupings non-reproducible between reviews.
const T0 = 1_753_800_000_000;

function past(i: number, name: string, extra: Partial<PastSession> = {}): PastSession {
  const [path, slug] = PROJECTS[i % PROJECTS.length];
  return {
    sessionId: `wb-past-${i}`,
    name,
    projectSlug: slug,
    projectPath: path,
    lastModified: T0 - i * 3_600_000,
    size: 4096 + i * 137,
    ...extra,
  };
}

// `lastUsedModel` is deliberately present on SOME rows and absent on others.
// That asymmetry is real, not fixture laziness: a conversation whose transcript
// records no real model carries none (see PastSession.lastUsedModel in
// ResumeBrowser.tsx for the trace), so a design that assumes every card can
// show a model chip would look fine here and wrong in the app. Row 3 stays bare
// on purpose.
//
// Row 0 is the CLAUDE CODE case — providerType 'claude-code', which is what
// session-browser.ts writes for a CC row. It was missing until 2026-09-04, and
// its absence is why the card line and the Model picker could disagree about
// which mark a CC session wears without the workbench ever showing it. (The
// note here used to say "only native sessions record a model ref today"; that
// stopped being true when the CC side landed.)
function defaultPast(): PastSession[] {
  return [
    past(0, 'fix chat scroll stick', {
      flags: { priority: true },
      tags: ['tag_bug'],
      lastUsedModel: { modelId: 'claude-opus-5', providerType: 'claude-code', providerLabel: 'Claude Code' },
    }),
    past(1, 'theme contrast pass', {
      provider: 'native',
      harnessId: 'coder',
      lastUsedModel: { modelId: 'gpt-5.6-sol', providerType: 'openrouter', providerLabel: 'OpenRouter' },
    }),
    past(2, 'sync health primary system', {
      note: 'blocked on the gh dead-end',
      provider: 'native',
      lastUsedModel: { modelId: 'qwen3-coder-30b-a3b-instruct', providerType: 'local-engine', providerLabel: 'Local' },
    }),
    past(3, 'menu internals tranche 3', { flags: { complete: true }, tags: ['tag_work'] }),
    past(4, 'ask-about-this reference UX', {
      tags: ['tag_idea', 'tag_work'],
      provider: 'native',
      lastUsedModel: { modelId: 'claude-sonnet-4-6', providerType: 'anthropic', providerLabel: 'Anthropic' },
    }),
  ];
}

// 220 rows with 80+ char names, holes in the optional fields, and the two
// resume-disabled states. This is the scenario that catches designs which only
// work on tidy data (spec §4) — including the ones that assume every row can
// be resumed.
//
// The count is overridable via `?stressRows=N` so a perf harness can drive the
// list to Destin's real scale (~1,642 rows) WITHOUT editing this file. It used
// to require a temporary source edit that had to be remembered and reverted;
// the default stays 220 on purpose, because that is the size at which the
// stress scenario is still usable for design work.
export function stressRowCount(): number {
  // The fixture factories are unit-tested under vitest's `node` environment,
  // where there is no `location` — reading it unguarded fails workbench-store.test.ts.
  if (typeof location === 'undefined') return 220;
  const raw = Number(new URLSearchParams(location.search).get('stressRows'));
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 20000) : 220;
}

function stressPast(): PastSession[] {
  return Array.from({ length: stressRowCount() }, (_, i) => {
    const extra: Partial<PastSession> = {};
    if (i % 5 === 0) extra.tags = ['tag_work', 'tag_bug', 'tag_idea'];
    if (i % 11 === 0) extra.missingProject = true;
    if (i % 13 === 0) extra.notSyncedYet = true;
    if (i % 7 === 0) extra.note = 'a note long enough to wrap past the row it belongs to, which is the point';
    if (i % 4 === 0) extra.provider = 'native';
    // Long model ids are the stress case for the card's bottom line, which now
    // carries project + model + timestamp on one row.
    if (i % 4 === 0) extra.lastUsedModel = i % 8 === 0
      ? { modelId: 'qwen3-coder-30b-a3b-instruct-1m', providerType: 'local-engine', providerLabel: 'Local' }
      : { modelId: 'gpt-5.6-sol', providerType: 'openrouter', providerLabel: 'OpenRouter' };
    return past(
      i,
      i % 3 === 0
        ? `refactor the transcript watcher byte-offset reader and its eight downstream consumers (${i})`
        : `session ${i}`,
      extra,
    );
  });
}

// Render-cost plan (docs/archive/investigations/2026-09-18-list-render-cost-sweep.md,
// Task 0 step 2b): generated model rows so the model picker's search results
// reach the same size as the other stress lists. Every label contains "a" on
// purpose — the DOM-size sweep types "a", and a sample the search filters down
// to a handful would prove nothing. Same CatalogRow shape as fixtures/providers.ts;
// they sit on the ready OpenRouter provider so the picker lists them.
function stressCatalog(): CatalogRow[] {
  const families = ['Atlas', 'Aurora', 'Nova Alpha', 'Galaxy', 'Panda', 'Llama Variant'];
  return Array.from({ length: stressRowCount() }, (_, i) => ({
    id: `stress/${families[i % families.length].toLowerCase().replace(/ /g, '-')}-${i}`,
    providerId: 'pv-openrouter',
    label: `${families[i % families.length]} ${i}`,
  }));
}

// Landing-page embed (scenario=site): two short past rows so the Resume list
// isn't empty behind the one live session, without dragging in the full
// eleven-row developer fixture (spec: a visitor sees a friendly conversation,
// not a dev harness).
function sitePast(): PastSession[] {
  return [
    past(0, 'draft the club newsletter', {
      provider: 'native',
      lastUsedModel: { modelId: 'qwen3-coder-30b-a3b-instruct', providerType: 'local-engine', providerLabel: 'Local' },
    }),
    past(1, 'compare two laptops', { tags: ['tag_work'] }),
  ];
}

// Promo (scenario=site&student=1): the Resume list a student would have. Every
// name, folder, tag and note is in the `site` persona (courses, a club, a job
// hunt) because the Resume browser, the Organize sheet and the strip all put
// this text on screen. Dates are relative to NOW, unlike `past()`'s fixed T0:
// the clip is shown to strangers, and a list of "7/29/2025" rows reads as an
// abandoned app, while "2h ago / 1d ago" reads as one in use. The search word
// the scene types is "econ" — exactly one row matches it, on purpose.
function studentPast(): PastSession[] {
  const now = Date.now();
  const HOUR = 3_600_000, DAY = 24 * HOUR;
  const row = (i: number, name: string, folder: string, ago: number, extra: Partial<PastSession> = {}): PastSession => ({
    ...past(i, name, extra),
    projectSlug: folder.split('/').pop()!,
    projectPath: folder,
    lastModified: now - ago,
  });
  return [
    row(0, 'econ midterm brief', '/home/you/School/Econ 201', 2 * HOUR, { tags: ['tag_econ'] }),
    row(1, 'club budget spreadsheet', '/home/you/Robotics Club', 1 * DAY, {
      tags: ['tag_club'],
      note: 'send to Maya before Friday',
      provider: 'native',
      lastUsedModel: { modelId: 'qwen3-coder-30b-a3b-instruct', providerType: 'local-engine', providerLabel: 'Local' },
    }),
    row(2, 'bio lab report outline', '/home/you/School/Bio 110', 3 * DAY, { flags: { complete: true } }),
    row(3, 'internship search', '/home/you/Job hunt', 6 * DAY, {
      tags: ['tag_jobhunt'],
      provider: 'native',
      lastUsedModel: { modelId: 'claude-sonnet-4-6', providerType: 'anthropic', providerLabel: 'Anthropic' },
    }),
    row(4, 'week plan', '/home/you/Documents', 12 * DAY, {}),
  ];
}

/** Builds a fresh state for a scenario. Every call re-runs the fixture
 *  factories, so two stores never share a mutable array. */
function siteParam(name: 'title' | 'model' | 'student'): string | null {
  if (typeof location === 'undefined') return null;   // Node unit tests import this module
  return new URLSearchParams(location.search).get(name);
}

export function seed(scenario: ScenarioId): MockState {
  const base: MockState = {
    sessions: sessions(),
    past: defaultPast(),
    // The live CC session starts with a tag and Priority set, so the StatusBar
    // chip and the close prompt both have something to render without the
    // reviewer having to click first.
    // Enough variety for the All Sessions menu's tag marks to be reviewable:
    // a priority + tag row, a two-tag row, and a row whose only mark is a note.
    meta: {
      'wb-1': { tags: ['tag_work'], note: '', flags: { priority: true } },
      'wb-3': { tags: ['tag_bug', 'tag_idea'], note: '', flags: {} },
      'wb-5': { tags: [], note: 'check the openrouter key before resuming', flags: {} },
    },
    providers: seedProviders(),
    catalog: seedCatalog(),
    tags: seedTags(),
    defaults: seedDefaults(),
    permissions: seedPermissions(),
    reopen: [],
  };
  switch (scenario) {
    case 'empty':
      return { ...base, sessions: [], past: [], tags: [], permissions: [] };
    case 'no-providers':
      // Native runtime is still "supported" — it is the providers that are
      // absent, which is the state the empty-provider guidance renders for.
      return { ...base, providers: base.providers.map((p) => ({ ...p, ready: false })), catalog: [] };
    case 'stress':
      // WHY catalog too (render-cost plan, Task 0 step 2b, 2026-09-18): the model
      // picker's search list is one of the unbounded surfaces that plan fixes, and
      // with the default ~11 models it could never show the cost — so `stress`
      // grows the catalog to `?stressRows=` rows like the Resume list.
      return { ...base, past: stressPast(), permissions: stressPermissions(), catalog: [...base.catalog, ...stressCatalog()] };
    case 'site':
      // Landing-page embed: providers/catalog/tags/defaults as default, one
      // native session, two past rows, no pre-set meta.
      // `?title=` renames the one session — a loop that starts empty (`?seed=none`)
      // should not sit under a "plan my week" tab either.
      // `&student=1` (promo-conversations): five student sessions on the strip,
      // a student's Resume list and tag set, and tag/note marks on two live
      // sessions so the All Sessions menu has something to show. Off, the
      // scenario is exactly what every other landing loop films.
      if (siteParam('student') === '1') {
        return {
          ...base,
          sessions: studentSessions(),
          past: studentPast(),
          tags: studentTags(),
          meta: {
            'site-2': { tags: ['tag_econ'], note: '', flags: { priority: true } },
            'site-3': { tags: ['tag_club'], note: 'send to Maya before Friday', flags: {} },
            'site-5': { tags: ['tag_jobhunt'], note: '', flags: {} },
          },
        };
      }
      return { ...base, sessions: siteSessions().map((r) => ({ ...r, name: siteParam('title') ?? r.name, model: siteParam('model') ?? r.model })), past: sitePast(), meta: {} };
    // Status-bar relevance review: ONE session on screen, nothing else to
    // scroll past. `sessions()` always puts wb-1 (Claude Code) first and wb-2
    // (native) second, so `list[0]` — the workbench's own default-session pick
    // (App.tsx: `setSessionId((prev) => prev ?? list[0].id)`) — lands correctly
    // with no extra wiring. Totals for the four native scenarios are applied to
    // wb-2's chat state in seed-chat.ts (STATUSBAR_TOTALS_OVERRIDE), keyed off
    // the same `?scenario=` the caller is already reading here.
    case 'statusbar-cc':
      return { ...base, sessions: base.sessions.filter((s) => s.id === 'wb-1') };
    case 'statusbar-local':
    case 'statusbar-metered':
    case 'statusbar-unpriced':
    case 'statusbar-delegated':
      return { ...base, sessions: base.sessions.filter((s) => s.id === 'wb-2') };
    case 'welcome-back':
      // Rows 0–2 and 4: a Claude Code row, a native row whose model IS set up
      // here, a local-model row, and a native row on Anthropic — so the batch
      // resume meets both "reuse the model" and "that model isn't here".
      // Row 3 (already complete) is left out: it was closed, not crashed.
      // Rows 1 and 4 are pointed at models the fixture catalog carries, so they
      // reopen on their own; row 2's local model is NOT installed here, which is
      // the "pick a model first" case.
      return {
        ...base,
        sessions: [],
        past: base.past.map((r) =>
          r.sessionId === 'wb-past-1' ? { ...r, lastUsedModel: { modelId: 'gpt-5.6-sol', providerType: 'chatgpt', providerLabel: 'ChatGPT Plan' } }
          : r.sessionId === 'wb-past-4' ? { ...r, lastUsedModel: { modelId: 'anthropic/claude-sonnet-4-6', providerType: 'openrouter', providerLabel: 'OpenRouter' } }
          : r),
        reopen: ['wb-past-0', 'wb-past-1', 'wb-past-2', 'wb-past-4'],
      };
    case 'refused':
    case 'default':
    default:
      return base;
  }
}
