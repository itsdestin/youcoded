import { useCallback, useRef, useEffect, useState, useSyncExternalStore } from 'react';
import { useChatStore } from '../state/chat-context';
import type { SpecialistRunView, ToolCallState, SpecialistDefinitionView, DelegatedModelsView, SubagentSegment, SpecialistsListResult } from '../../shared/types';

// Specialists 1c — narrow selectors over the chat store. A Task card carries
// ITS OWN run record on the tool prop (ToolCallState.specialistRun), so these
// exist only for the two reads that cross cards: a `task_id` management call
// naming another card's child, and the status-bar chip counting every child.
// Both return stable references (or primitives) so a subscriber re-renders
// only when the answer changes — never on every session update, which a plain
// useChatState() in a memoized ToolCard would do to the whole timeline.

/** The Task card whose child is `childId` (by run record, else stamped agentId). */
export function findSpecialistCardByChild(
  toolCalls: Map<string, ToolCallState>,
  childId: string,
): ToolCallState | undefined {
  for (const tool of toolCalls.values()) {
    if (tool.specialistRun?.childId === childId || tool.agentId === childId) return tool;
  }
  return undefined;
}

export function useSpecialistRunByChild(sessionId: string | undefined, childId: string | undefined): SpecialistRunView | undefined {
  const store = useChatStore();
  const subscribe = useCallback(
    (cb: () => void) => (sessionId ? store.subscribeSession(sessionId, cb) : () => {}),
    [store, sessionId],
  );
  const getSnapshot = useCallback(() => {
    if (!sessionId || !childId) return undefined;
    return findSpecialistCardByChild(store.getSession(sessionId).toolCalls, childId)?.specialistRun;
  }, [store, sessionId, childId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export type AskSegment = Extract<SubagentSegment, { type: 'tool' }>;

/** Everything the management popup shows for ONE helper — read off its Task card. */
export interface HelperView {
  run: SpecialistRunView;
  parentToolCallId: string;
  /** The Task card itself — the popup renders its Briefing/Activity/Report
   *  sections verbatim (AgentSections), so it must be the live object. */
  tool: ToolCallState;
  /** Asks waiting on the user, oldest first. */
  asks: AskSegment[];
  /** Total tool calls so far (a live step count the ledger only writes at the end). */
  toolCalls: number;
  group: 'needs-you' | 'working' | 'finished';
  /** Which engine hired this helper. 'native' helpers come with a real ledger
   *  record (name, model, background flag) and can be steered or stopped;
   *  'claude-code' ones are SYNTHESIZED below from the Agent card alone, so
   *  the popup must not offer controls the CC session cannot honor. */
  kind: HelperKind;
  /** CC only: the subagent type Claude Code launched ('Explore', 'Plan',
   *  'general-purpose'). Absent for native hires, whose `run.title` already
   *  names them. */
  agentTypeLabel?: string;
  /** True when nothing on this card carries a clock, so the status line must
   *  NOT print an elapsed figure. A CC Agent card gets its start time from its
   *  first timestamped segment; before any segment arrives there is genuinely
   *  no start time, and `Date.now() - 0` would render "56y 3m" (status-bar
   *  rule: a value we do not have renders nothing, never a fabricated one). */
  elapsedUnknown?: boolean;
}

export type HelperKind = 'native' | 'claude-code';

export interface SpecialistSummary {
  helpers: HelperView[];
  needsYou: number;
  working: number;
  finished: number;
  /** The word this session's helpers are called, singular. Destin (2026-09-05):
   *  a Claude Code session says "subagents" because that is what Claude Code
   *  itself calls them everywhere else in its own output; the app's native
   *  hires stay "specialists". A session is one runtime or the other, so a
   *  mixed list is not a real case — if it ever happened, 'specialist' wins
   *  because the native controls are the ones that need the precise word. */
  noun: 'specialist' | 'subagent';
}

const EMPTY: SpecialistSummary = { helpers: [], needsYou: 0, working: 0, finished: 0, noun: 'specialist' };

function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * A Claude Code subagent, in the shape the popup already knows how to draw.
 *
 * WHY this exists: the chip counts `tool.specialistRun`, a ledger record only
 * the app's OWN engine writes — so in a Claude Code conversation the chip was
 * silently absent even though the app was already tailing every subagent's log
 * and rendering its Briefing/Activity/Report on the Agent card. Everything the
 * chip needs is on that card; this reads it off rather than inventing a second
 * counting path (Destin, 2026-09-05: "do the same for Claude Code subagents").
 *
 * Returns undefined for anything that is not a STARTED subagent — a non-Agent
 * card, or an Agent call still waiting for the user's yes (nothing is running
 * yet, so counting it as "working" would be a false statement on the bar).
 */
export function ccRunFromCard(
  parentToolCallId: string,
  tool: ToolCallState,
): { run: SpecialistRunView; agentTypeLabel?: string; elapsedUnknown: boolean } | undefined {
  // 'Agent' is Claude Code's subagent tool; 'Task' is the native harness's
  // (ToolBody.tsx AgentView reads the same split). A card with neither name is
  // not a helper at all.
  if (tool.toolName !== 'Agent') return undefined;
  if (tool.status === 'awaiting-approval' || tool.preparing) return undefined;

  const agentType = asText(tool.input.subagent_type) || tool.agentType || 'general-purpose';
  const description = asText(tool.input.description);
  // The description is the only per-launch text, so it is the NAME here — two
  // `general-purpose` helpers are otherwise indistinguishable in the list. The
  // type still shows, as `agentTypeLabel`, on the line underneath.
  const title = description || agentType;

  // Earliest stamped segment = when this helper actually started working. CC
  // stamps every segment it routes (chat-reducer applySubagentEvent), but a
  // just-launched agent has no segment yet — hence elapsedUnknown rather than
  // a zero that would render as a 56-year runtime.
  let startedAt = Infinity;
  let lastAt = 0;
  let steps = 0;
  for (const seg of tool.subagentSegments ?? []) {
    if (seg.type === 'tool') steps++;
    if (seg.timestamp === undefined) continue;
    if (seg.timestamp < startedAt) startedAt = seg.timestamp;
    if (seg.timestamp > lastAt) lastAt = seg.timestamp;
  }
  const elapsedUnknown = startedAt === Infinity;

  const status: SpecialistRunView['status'] =
    tool.status === 'running' ? 'running'
      : tool.status === 'failed' ? 'failed'
        : 'completed';

  return {
    run: {
      // `agentId` is the id CC stamps on the log file; it is absent until the
      // watcher binds the subagent to this card, so the card's own id is the
      // fallback — either way this is stable for the life of the card, which
      // is what the popup's React key and the snapshot cache key need.
      childId: tool.agentId ?? tool.toolUseId,
      parentToolCallId,
      agentType,
      title,
      description: description && description !== title ? description : undefined,
      // CC does not report whether a subagent is detached, and the app has no
      // second signal for it — so this stays false rather than guessing.
      background: false,
      status,
      startedAt: elapsedUnknown ? 0 : startedAt,
      // A finished helper MUST carry an end time: without one the status line
      // measures against Date.now(), so "Finished in 4m" would keep climbing
      // every time the popup re-rendered. The last stamped segment is the
      // closest thing CC gives us to a finish time.
      endedAt: status === 'running' || elapsedUnknown ? undefined : lastAt,
      steps: steps || undefined,
    },
    agentTypeLabel: agentType,
    elapsedUnknown,
  };
}

/** Everything the status-bar chip + popup need for one session. Recomputed on
 *  every session change but returned by reference only when the KEY changes,
 *  so the chip does not re-render on each streamed token. */
export function useSpecialistSummary(sessionId: string | undefined): SpecialistSummary {
  const store = useChatStore();
  const cache = useRef<{ key: string; value: SpecialistSummary }>({ key: '', value: EMPTY });
  const subscribe = useCallback(
    (cb: () => void) => (sessionId ? store.subscribeSession(sessionId, cb) : () => {}),
    [store, sessionId],
  );
  const getSnapshot = useCallback(() => {
    if (!sessionId) return EMPTY;
    const session = store.getSession(sessionId);
    const helpers: HelperView[] = [];
    const keyParts: string[] = [];
    for (const [id, tool] of session.toolCalls) {
      // A native hire brings its own ledger record; a Claude Code subagent has
      // none, so one is derived from its Agent card (see ccRunFromCard). Both
      // then flow through the SAME grouping and key below — the popup renders
      // one shape, not two.
      const cc = tool.specialistRun ? undefined : ccRunFromCard(id, tool);
      const run = tool.specialistRun ?? cc?.run;
      if (!run) continue;
      const tools: AskSegment[] = [];
      for (const seg of tool.subagentSegments ?? []) if (seg.type === 'tool') tools.push(seg);
      // CC subagent asks never nest (Claude Code does not tell the app WHICH
      // subagent raised a permission prompt — chat-types.ts PERMISSION_REQUEST
      // `specialist` is set only by the native ask router), so this list is
      // always empty for a CC helper and its chip never turns amber. Decided
      // with Destin 2026-09-05: working/finished only, rather than guess at
      // attribution and risk pinning an ask on the wrong helper.
      const asks = cc ? [] : tools.filter(t => t.status === 'awaiting-approval' && !!t.requestId);
      // A held ask on a finished run still counts as 'needs-you' — the ask is
      // still answerable even after the helper is gone (Task 12). Do not
      // fold this into 'finished': `run` (with `run.status`) is already
      // carried on HelperView below, which is how SpecialistAskBlock knows
      // whether to show its running-helper or finished-helper held-ask copy.
      const group: HelperView['group'] = asks.length > 0 ? 'needs-you' : run.status === 'running' ? 'working' : 'finished';
      helpers.push({
        run, parentToolCallId: id, tool, asks, toolCalls: tools.length, group,
        kind: cc ? 'claude-code' : 'native',
        agentTypeLabel: cc?.agentTypeLabel,
        elapsedUnknown: cc?.elapsedUnknown,
      });
      // The card object is replaced immutably on EVERY change (reducer
      // `toolCalls.set(id, {...})`), so a version counter keyed on identity
      // would be ideal; a string key has to approximate it. Segment count +
      // last segment's shape/length + statuses of the tail + report/response
      // length catches every change the popup can display.
      const segs = tool.subagentSegments ?? [];
      const last = segs[segs.length - 1];
      keyParts.push([
        // `run.title` is in the key for the CC path: a synthesized helper takes
        // its name from the Agent call's `description`, and Claude Code rewrites
        // that tool_use line as the arguments stream in — so the name can change
        // while nothing else on the card does. Stable (and therefore free) for a
        // native hire, whose title is minted once at spawn.
        run.childId, run.status, run.title, run.stale ? 's' : '', run.steps ?? '', run.model?.label ?? '', segs.length,
        last ? `${last.type}:${last.id}:${'content' in last ? last.content.length : (last as AskSegment).status}` : '',
        tools.slice(-4).map(t => `${t.toolUseId}:${t.status}${t.askHeld ? 'h' : ''}${t.response ? t.response.length : ''}`).join('+'),
        asks.map(a => a.requestId).join('+'),
        tool.status, tool.response?.length ?? '', tool.specialistReport ? tool.specialistReport.status + tool.specialistReport.text.length : '',
      ].join(':'));
    }
    const key = keyParts.join('|');
    if (key === cache.current.key) return cache.current.value;
    const value: SpecialistSummary = helpers.length === 0 ? EMPTY : {
      helpers,
      needsYou: helpers.filter(h => h.group === 'needs-you').length,
      working: helpers.filter(h => h.group === 'working').length,
      finished: helpers.filter(h => h.group === 'finished').length,
      noun: helpers.some(h => h.kind === 'native') ? 'specialist' : 'subagent',
    };
    cache.current = { key, value };
    return value;
  }, [store, sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

// ---------------------------------------------------------------------------
// Roster — per-cwd cache shared by every card and the Settings screen. Real
// backend as of Task 8 (specialists:list on all five surfaces): the cache
// keys on cwd because the catalog reads a PROJECT'S OWN .claude/agents/
// folder in addition to the two global ones, so two sessions with different
// cwds genuinely see different rosters.
// ---------------------------------------------------------------------------

export type RosterCacheEntry =
  | { status: 'loading' }
  | { status: 'ready'; result: SpecialistsListResult }
  | { status: 'failed'; error: string }
  | { status: 'unavailable' };

/** The exact machine string SessionService.kt (and remote-shim, over a
 *  not-yet-upgraded peer) answers with for every specialists:* channel —
 *  the whole native harness is desktop-only until M8. Pinned here (not
 *  inlined below) so a wording change there is CAUGHT by a test instead of
 *  silently starting to read as a retryable 'failed' state — which would
 *  show an error message plus a Refresh button that can never work — rather
 *  than the honest 'unavailable' one. tests/specialist-roster-cache.test.ts. */
export const NOT_IMPLEMENTED_ON_MOBILE = 'not-implemented-on-mobile';

function cwdKey(cwd?: string): string {
  return cwd ?? '';
}

const rosterCache = new Map<string, RosterCacheEntry>();
const rosterSubs = new Map<string, Set<() => void>>();

function notify(key: string): void {
  for (const cb of rosterSubs.get(key) ?? []) cb();
}

async function loadRoster(cwd?: string, opts?: { ensurePersonalFolder?: boolean }): Promise<RosterCacheEntry> {
  try {
    const res: unknown = await window.claude.specialists.list({ cwd, ensurePersonalFolder: opts?.ensurePersonalFolder });
    if (res && typeof res === 'object' && Array.isArray((res as SpecialistsListResult).definitions)) {
      return { status: 'ready', result: res as SpecialistsListResult };
    }
    if (res && typeof res === 'object' && (res as { ok?: boolean }).ok === false) {
      const error = (res as { error?: unknown }).error;
      if (error === NOT_IMPLEMENTED_ON_MOBILE) return { status: 'unavailable' };
      return { status: 'failed', error: typeof error === 'string' ? error : 'Could not load specialists.' };
    }
    return { status: 'failed', error: 'Could not load specialists — unexpected response.' };
  } catch (e) {
    return { status: 'failed', error: (e as Error).message };
  }
}

/** Force a re-read for one cwd — Settings' Refresh button, the definition
 *  hook's refetch-on-miss, and Settings' own mount effect (see
 *  SpecialistsSection). `ensurePersonalFolder` is that mount effect's ONE
 *  deliberate bend of "the folder appears on first write" (spec §2): Open
 *  Folder needs somewhere to open even before the user has saved anything. */
export async function refreshSpecialistRoster(cwd?: string, opts?: { ensurePersonalFolder?: boolean }): Promise<void> {
  const key = cwdKey(cwd);
  rosterCache.set(key, { status: 'loading' });
  notify(key);
  const entry = await loadRoster(cwd, opts);
  rosterCache.set(key, entry);
  notify(key);
}

/** The roster for one cwd (global sources only when cwd is omitted).
 *  Auto-loads on first use per cwd; every subscriber sharing a cwd shares one
 *  cache entry, so a Task card and the Settings screen never race each other
 *  into two separate reads of the same folder.
 *
 *  `ensurePersonalFolder` (Settings only) rides THIS SAME auto-load call —
 *  Fix (Task 10 review, finding 2): SpecialistsSection used to run a SECOND,
 *  separate mount effect that unconditionally called refreshSpecialistRoster
 *  with ensurePersonalFolder:true, racing this effect's own (non-ensuring)
 *  call on every Settings open — two concurrent disk reads, outcome decided
 *  by whichever happened to resolve last. Threading it through here instead
 *  means there is exactly one load call site: the folder gets ensured on
 *  whichever call is this cwd's first-ever load (by any caller), and a later
 *  mount for an already-cached cwd is a no-op read either way. */
export function useSpecialistRoster(cwd?: string, opts?: { ensurePersonalFolder?: boolean }): RosterCacheEntry {
  const key = cwdKey(cwd);
  const [, force] = useState(0);
  // Captured in a ref, not the effect's dep array — the caller (Settings)
  // passes a fresh `{ ensurePersonalFolder: true }` object every render, and
  // that identity must never retrigger the load effect below.
  const ensureRef = useRef(opts?.ensurePersonalFolder);
  ensureRef.current = opts?.ensurePersonalFolder;
  useEffect(() => {
    let subs = rosterSubs.get(key);
    if (!subs) { subs = new Set(); rosterSubs.set(key, subs); }
    const cb = () => force(n => n + 1);
    subs.add(cb);
    // Fix (Task 10 review, fix pass 2): a cache-miss-only guard let an EARLIER
    // caller's non-ensuring load (a hire card, or a non-hire card sharing the
    // empty-cwd '' key) permanently poison this cwd's cache for Settings —
    // once 'ready', Settings would never re-ensure again for the life of the
    // renderer, even on a fresh mount (the dialog unmounts/remounts on every
    // open). Same failure if the user deletes the personal folder and reopens
    // Settings: the stale 'ready' entry never re-checks. A caller that asked
    // for ensuring now forces its own refresh on every mount; every other
    // caller keeps the original cache-absence-only behavior. Still exactly
    // one load call per mount (this effect, this branch) — the duplicate
    // concurrent-read race the previous fix removed does not come back.
    if (ensureRef.current || !rosterCache.has(key)) void refreshSpecialistRoster(cwd, { ensurePersonalFolder: ensureRef.current });
    return () => { subs!.delete(cb); };
  }, [key, cwd]);
  return rosterCache.get(key) ?? { status: 'loading' };
}

// One refetch per (cwd, agentId) — a genuinely unknown id costs exactly one
// extra list call, never a loop. Module-level so a memoized card that never
// unmounts (ToolCard is React.memo'd and lives for the whole session) still
// only retries once, not once per render.
const definitionMissRetried = new Set<string>();

/** One hire's definition, resolved against the given cwd's roster. WHY the
 *  refetch-on-miss: the backend re-reads the three definition folders at
 *  every turn start, but the card has no push telling it that happened — a
 *  hire of a helper the card has never seen (a brand-new file, or one added
 *  mid-turn) is the signal to re-read, not a reason to give up. */
export function useSpecialistDefinition(cwd: string | undefined, agentId: string | undefined): SpecialistDefinitionView | undefined {
  const roster = useSpecialistRoster(cwd);
  const key = cwdKey(cwd);
  useEffect(() => {
    if (!agentId) return;
    if (roster.status !== 'ready') return;
    if (roster.result.definitions.some(d => d.id === agentId)) return;
    const missKey = `${key}::${agentId}`;
    if (definitionMissRetried.has(missKey)) return;
    definitionMissRetried.add(missKey);
    void refreshSpecialistRoster(cwd);
  }, [roster, key, agentId, cwd]);
  if (!agentId) return undefined;
  if (roster.status !== 'ready') return undefined;
  return roster.result.definitions.find(d => d.id === agentId);
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** One-line "where did this come from" — the Settings row's subtitle, and a
 *  line under the name in the consent envelope. `folders` (from the SAME
 *  list result the definition came from) is what tells a project's own
 *  .claude/agents apart from the user's ~/.claude/agents: the catalog tags
 *  both 'claude-code' and only `path` differs. */
/** The FULL answer to "where did this helper come from", for a surface that
 *  gives no other context — the hire consent card in chat, above all, where the
 *  whole point of the line is telling a repo's own helper apart from your own
 *  before you approve it. Settings uses `provenanceWithinGroup` instead. */
export function definedBy(view: SpecialistDefinitionView, folders?: SpecialistsListResult['folders']): string {
  if (view.source === 'builtin') return 'Built in';
  const path = view.path ?? '';
  if (view.source === 'personal') return `Your specialists folder · ${basename(path)}`;
  const isProject = !!folders?.project && path.startsWith(folders.project);
  return isProject
    ? `This project's .claude/agents/${basename(path)}`
    : `Your ~/.claude/agents/${basename(path)}`;
}

/** Destin (workbench pass): the same answer, minus whatever the group heading
 *  above the row already said. In Settings a helper sits under "Built in" /
 *  "Your specialists" / "Claude Code agents", so repeating that on every row is
 *  noise — "Built in" under a "Built in" heading says nothing, and returning ''
 *  lets the row drop the line entirely. The Claude Code case keeps its full
 *  prefix on purpose: that ONE heading covers two different folders (a
 *  project's own vs. your account-wide one), so which folder is the whole
 *  question there. Only Settings may use this — a surface with no heading needs
 *  `definedBy`. */
export function provenanceWithinGroup(view: SpecialistDefinitionView, folders?: SpecialistsListResult['folders']): string {
  if (view.source === 'builtin') return '';
  if (view.source === 'personal') return basename(view.path ?? '');
  return definedBy(view, folders);
}

export function useDelegatedModels(): [DelegatedModelsView | null, (next: DelegatedModelsView) => void] {
  const [tiers, setTiers] = useState<DelegatedModelsView | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const t = await window.claude.specialists.getDelegatedModels();
        // Fix: the not-implemented-on-mobile shape (`{ok:false,error}`) is
        // also a truthy object — without the `'budget' in t` check it passed
        // this guard and got cast to DelegatedModelsView, so remote/Android
        // rendered "budget: undefined" as if a tier had silently been unset
        // rather than the truth (this host cannot answer the question yet).
        if (live && t && typeof t === 'object' && 'budget' in t) setTiers(t as DelegatedModelsView);
      } catch { /* leave null — the UI says "not set" */ }
    })();
    return () => { live = false; };
  }, []);
  return [tiers, setTiers];
}
