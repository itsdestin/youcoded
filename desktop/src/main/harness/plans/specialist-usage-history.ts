// SpecialistUsageHistory — the estimate's raw material (specialists plans,
// spending rework T5; backend design §4). A small, capped, incrementally
// updated index of what past specialist runs actually cost, read from the
// same ~/.youcoded/sessions/*/*.jsonl transcripts
// docs/active/investigations/2026-09-19-specialist-usage.py reads, kept as a
// tiny on-disk cache (~/.youcoded/specialist-usage.json) so the app never
// re-walks the whole sessions folder on every launch.
//
// WHY this lives apart from plan-estimate.ts: this file is the only thing
// that touches disk. estimatePlan() (plan-estimate.ts) takes a plain
// SpecialistUsageSnapshot and does no I/O at all — the split keeps the
// pricing MATH testable with no filesystem, and keeps the SCAN testable with
// no pricing knowledge.
//
// WHY fs.promises.writeFile here, NOT NativeHome.mutateJson (design §4
// Revision 1 D7, reconciling native-runtime.md's general "~/.youcoded/
// writes ride NativeHome.mutateJson" rule): every other ~/.youcoded/ JSON
// file is a durable record — a damaged plans.json can lose an approved
// budget, a damaged providers.json can lose a saved key — so mutateJson's
// cross-process file lock exists to protect against a torn write costing
// real data. This file is a pure PERFORMANCE CACHE with a known-good
// rebuild path: the background scan below can always regenerate every entry
// it holds from the real transcripts on disk, and a stale/missing/corrupt
// cache costs nothing worse than a slightly-off estimate until the next
// scan reaches it. Taking the lock for that would be all cost, no benefit —
// D7's own reasoning ("never blocks the host") is the same tradeoff.
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { log } from '../../logger';
import type { NativeHome, SessionFileInfo } from '../../native-home';

/** ~/.youcoded/specialist-usage.json. */
const CACHE_FILE = 'specialist-usage.json';
/** Design §4 Revision 1 D7: "capped at the most recent 1,000 runs (≈150 KB)". */
const MAX_ENTRIES = 1_000;
/** Design §4: "the first line" — a session header is a single small JSON
 *  object; 4 KB comfortably covers every real one with room to spare. */
const HEAD_READ_BYTES = 4_096;
/** Design §4: "deferred with setTimeout... until the first window is up" —
 *  matches the existing precedent for a startup background poke
 *  (ipc-handlers.ts's `refreshOpenRouter`, also 5 s + `.unref()`). */
const DEFAULT_SCAN_DELAY_MS = 5_000;
/** The write is debounced (design §4 Revision 1 D7), not per-record — a plan
 *  with several steps finishing close together, or the background scan
 *  crossing MAX_ENTRIES repeatedly, writes once instead of once per entry. */
const DEFAULT_WRITE_DEBOUNCE_MS = 2_000;

/** The transcript event types that carry a turn's billed usage, read off
 *  disk by the background SCAN. WHY no `'session-error'` (T5 review H3):
 *  design §4's own wording lists it alongside these three, matching
 *  `2026-09-19-specialist-usage.py`'s read — but `session-error` is
 *  display-only and never persisted to a session's `.jsonl` file
 *  (`session-store.ts`'s `append()`, module comment + its own `if
 *  (event.type === 'session-error')` short-circuit), so this SCAN can never
 *  actually observe that branch. The LIVE `record()` calls
 *  (`reportSpecialistSpend`, `runPlanChild`'s `finally`) are unaffected —
 *  they sum the harness's own in-memory usage totals, not a transcript
 *  re-parse, so an error-terminated run is still captured correctly the
 *  first time; only a scan-recovered rebuild (e.g. after a restart before
 *  `record()` ran) would ever miss that reply's usage, and only very
 *  slightly. Listing a type here that the scan can never see would just be
 *  dead code with a misleading comment. */
const USAGE_EVENT_TYPES = new Set(['turn-complete', 'user-interrupt', 'compact-summary']);

/** One past specialist run, netted into the same four buckets `costForUsage`
 *  bills separately (pricing.ts) — never the raw `inputTokens` total, which
 *  double-counts a prompt's cached portion against its own read/write rate. */
export interface SpecialistUsageEntry {
  childId: string;
  /** The specialist's own id (`SpecialistDefinition.id`) — 'worker',
   *  'reviewer', a custom roster id, etc. Session headers already call this
   *  `agentType` (session-store.ts); kept the same name here so the two never
   *  need translating. */
  agentType: string;
  providerId: string;
  modelId: string;
  usage: { uncached: number; cacheRead: number; cacheWrite: number; output: number };
  /** The source session file's size/mtime AT SCAN TIME — the incremental
   *  scan's skip key: unchanged since last time → summing again would only
   *  reread a file that cannot have changed (a specialist session is
   *  single-writer and torn down at run end, native-runtime.md). A
   *  `record()`-pushed entry (below) has no file to compare yet, so it
   *  carries `size: 0` — always a mismatch, so the scan re-derives it (with
   *  real numbers) the first time it reaches that file, and every later
   *  entry is 100% the scan's own numbers. */
  size: number;
  mtimeMs: number;
}

export interface SpecialistUsageSnapshot {
  entries: readonly SpecialistUsageEntry[];
}

function isValidEntry(e: unknown): e is SpecialistUsageEntry {
  if (!e || typeof e !== 'object') return false;
  const v = e as Record<string, unknown>;
  const u = v.usage as Record<string, unknown> | undefined;
  return typeof v.childId === 'string' && typeof v.agentType === 'string'
    && typeof v.providerId === 'string' && typeof v.modelId === 'string'
    && typeof v.size === 'number' && typeof v.mtimeMs === 'number'
    && !!u && typeof u === 'object'
    && typeof u.uncached === 'number' && typeof u.cacheRead === 'number'
    && typeof u.cacheWrite === 'number' && typeof u.output === 'number';
}

/** Netting shared with `2026-09-19-specialist-usage.py`'s own
 *  `crc = min(cr, inp); cwc = min(cw, inp - crc); unc = inp - crc - cwc` —
 *  clamped so a malformed report of more cache than input tokens can never
 *  drive the uncached count negative (the same clamp `costForUsage`'s own
 *  cache split uses, pricing.ts). */
function netUsage(inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheCreationTokens: number): SpecialistUsageEntry['usage'] {
  const cacheRead = Math.min(cacheReadTokens, inputTokens);
  const cacheWrite = Math.min(cacheCreationTokens, Math.max(0, inputTokens - cacheRead));
  const uncached = Math.max(0, inputTokens - cacheRead - cacheWrite);
  return { uncached, cacheRead, cacheWrite, output: outputTokens };
}

/** The same netting, from a `PricedUsage` — exported for the two `record()`
 *  call sites (native-session-host.ts: `reportSpecialistSpend`,
 *  `runPlanChild`'s `finally`), which already hold a run's usage in that
 *  shape (the SDK/harness's own), so the clamp logic lives in exactly one
 *  place for both the live-recorded and the scan-recovered path. */
export function toHistoryUsage(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): SpecialistUsageEntry['usage'] {
  return netUsage(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens);
}

/** Streams one session file's turn-usage events and sums them, never holding
 *  the whole transcript in memory — design §4: "stream with readline over
 *  createReadStream". A worker's transcript can run tens of megabytes; the
 *  whole-file `NativeHome.readSessionLinesAsync` reader exists for pages the
 *  UI needs in full and is deliberately NOT reused here. */
async function sumUsage(filePath: string): Promise<SpecialistUsageEntry['usage']> {
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let d: unknown;
    try { d = JSON.parse(line); } catch { continue; } // a torn tail line — see native-home.ts's own tolerance
    const type = (d as { type?: unknown } | null)?.type;
    if (typeof type !== 'string' || !USAGE_EVENT_TYPES.has(type)) continue; // also skips the header line (no `type`)
    const u = (d as { data?: { usage?: unknown } }).data?.usage as
      { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheCreationTokens?: unknown } | undefined;
    if (!u || typeof u.inputTokens !== 'number') continue;
    inputTokens += u.inputTokens;
    outputTokens += typeof u.outputTokens === 'number' ? u.outputTokens : 0;
    cacheReadTokens += typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0;
    cacheCreationTokens += typeof u.cacheCreationTokens === 'number' ? u.cacheCreationTokens : 0;
  }
  return netUsage(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);
}

export class SpecialistUsageHistory {
  private entries = new Map<string, SpecialistUsageEntry>();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private scanning = false;
  // WHY a monotonic clock rather than a bare `Date.now()` per record() call
  // (found writing this file's own tests): several runs can finish within
  // the same millisecond, and `Date.now()` ties would make the cap's
  // stable sort keep whichever was inserted FIRST — the opposite of "most
  // recent" (capEntries's own WHY). Always at least 1ms after the previous
  // record()'s stamp, so two same-millisecond runs still order correctly
  // relative to each other without needing a separate sequence field.
  private lastRecordMs = 0;

  constructor(
    private readonly home: NativeHome,
    private readonly opts: { scanDelayMs?: number; writeDebounceMs?: number } = {},
  ) {
    // Design §4: "Loaded async at host start." Fire-and-forget: an estimate
    // computed before this resolves just reads an empty snapshot (§12 risk
    // 4, "early estimates may use defaults") — never blocks construction.
    void this.loadCache();
    // Design §4: "Background scan deferred with setTimeout until the first
    // window is up." `.unref()` (ipc-handlers.ts's refreshOpenRouter is the
    // same precedent) so a pending scan can never keep the process alive.
    const t = setTimeout(() => { void this.scan(); }, this.opts.scanDelayMs ?? DEFAULT_SCAN_DELAY_MS);
    t.unref?.();
  }

  /** Design §4: "synchronous over memory only — an estimate never waits on
   *  the scan." The array is a snapshot copy; callers never see a later
   *  record()/scan() mutate what they already read. */
  snapshot(): SpecialistUsageSnapshot {
    return { entries: [...this.entries.values()] };
  }

  /** T5 point 1: called when a run ends — `NativeSessionHost.
   *  reportSpecialistSpend` (ordinary Task-tool specialists) and
   *  `runPlanChild`'s `finally` (plan specialists) — so a plan proposed
   *  moments after a specialist run reflects it immediately, well before the
   *  background scan would ever reach that session's file. */
  record(childId: string, agentType: string, providerId: string, modelId: string, usage: SpecialistUsageEntry['usage']): void {
    // size: 0 — "no file compared yet" (see the field's own doc); the scan
    // overwrites this with the real stat pair once it reaches this file.
    this.lastRecordMs = Math.max(Date.now(), this.lastRecordMs + 1);
    this.entries.set(childId, { childId, agentType, providerId, modelId, usage, size: 0, mtimeMs: this.lastRecordMs });
    this.capEntries();
    this.scheduleWrite();
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = await this.home.readRawBytesAsync(CACHE_FILE);
      if (!raw) return; // no cache yet — the scan will build one
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (!Array.isArray(parsed)) return;
      for (const e of parsed) if (isValidEntry(e)) this.entries.set(e.childId, e);
    } catch (e) {
      // Corrupt or unreadable cache reads as "nothing here yet" (the same
      // tolerance NativeHome.readJson gives every other ~/.youcoded/ cache) —
      // the background scan below rebuilds it from the real transcripts.
      log('ERROR', 'SpecialistUsageHistory', 'could not read the cached specialist usage history — starting empty; the background scan will rebuild it', { error: String(e) });
    }
  }

  /** The background scan (design §4). Public so tests can run it
   *  deterministically instead of waiting on the constructor's timer. */
  async scan(): Promise<void> {
    if (this.scanning) return; // one scan at a time — a resumed/late scan never overlaps another
    this.scanning = true;
    try {
      let files: SessionFileInfo[];
      try {
        files = await this.home.listSessionFilesAsync();
      } catch (e) {
        log('ERROR', 'SpecialistUsageHistory', 'could not list ~/.youcoded/sessions for the usage history scan', { error: String(e) });
        return;
      }
      for (const f of files) {
        const existing = this.entries.get(f.sessionId);
        if (!existing || existing.size !== f.sizeBytes || existing.mtimeMs !== f.mtimeMs) {
          try {
            await this.scanOne(f);
          } catch (e) {
            log('ERROR', 'SpecialistUsageHistory', 'failed to scan one specialist session for usage history — skipping it', { file: f.path, error: String(e) });
          }
        }
        // Design §4: "one file at a time with setImmediate between" — never
        // starves the event loop with a long walk over a big sessions folder.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.scanning = false;
    }
  }

  private async scanOne(f: SessionFileInfo): Promise<void> {
    const head = await this.home.readSessionHeadAsync(f.slug, f.sessionId, HEAD_READ_BYTES);
    const header = head[0] as { sessionKind?: unknown; agentType?: unknown; binding?: { providerId?: unknown; modelId?: unknown } } | undefined;
    if (!header || header.sessionKind !== 'specialist' || typeof header.agentType !== 'string') return; // not a specialist file — never gets an entry
    const binding = header.binding ?? {};
    const usage = await sumUsage(f.path);
    this.entries.set(f.sessionId, {
      childId: f.sessionId,
      agentType: header.agentType,
      providerId: typeof binding.providerId === 'string' ? binding.providerId : '',
      modelId: typeof binding.modelId === 'string' ? binding.modelId : '',
      usage,
      size: f.sizeBytes,
      mtimeMs: f.mtimeMs,
    });
    this.capEntries();
    this.scheduleWrite();
  }

  /** Design §4 Revision 1 D7: capped at the 1,000 MOST RECENT runs — kept
   *  most-recent-first by `mtimeMs` (a `record()` entry's `mtimeMs` is the
   *  moment the run ended, so a run that just finished is never evicted in
   *  favor of an old scanned one). Only runs once the map is already over
   *  the cap, so this is O(1,000 log 1,000) at worst per call — cheap at
   *  this size (see the cap's own WHY above). */
  private capEntries(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    const kept = [...this.entries.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_ENTRIES);
    this.entries = new Map(kept.map((e) => [e.childId, e]));
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return; // a flush is already pending — it will pick up everything queued since
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, this.opts.writeDebounceMs ?? DEFAULT_WRITE_DEBOUNCE_MS);
    this.writeTimer.unref?.();
  }

  private async flush(): Promise<void> {
    try {
      await fs.promises.mkdir(this.home.root, { recursive: true });
      await fs.promises.writeFile(path.join(this.home.root, CACHE_FILE), JSON.stringify([...this.entries.values()]), 'utf8');
    } catch (e) {
      // Log-only (see this file's own D7 WHY): losing this write costs a
      // slightly stale cache until the next scan, never data the app needs.
      log('ERROR', 'SpecialistUsageHistory', 'could not write the cached specialist usage history to disk — kept in memory only', { error: String(e) });
    }
  }
}
