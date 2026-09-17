import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { chatsearchDir } from './index-store';
import {
  NOTE_MAX_CHARS, OUTBOX_FORMAT_VERSION, parseOutboxRequest, appendNoteText, hasDatedLine,
  type OutboxRequest, type OutboxReceipt, type ReceiptResult, type OutboxTarget,
} from './outbox-format';
import { getConversationStore, noteFlagChanged, noteSessionNote, emitConversationMetaChanged } from '../conversations/service';
import { getTagRegistry } from '../conversations/tag-registry-service';
import { broadcastSessionMeta, broadcastTagsChanged } from '../ipc-handlers';
import { tagFlagKey, DEFAULT_TAG_COLOR } from '../../shared/tags';
import { log } from '../logger';

const POLL_MS = 5_000;
const RECEIPT_TTL_MS = 24 * 3600_000;
const PROCESSING_STALE_MS = 10 * 60_000;
// WHY 3 days: a request addressed to a store this instance doesn't own is left
// in place for whichever instance DOES own it (see the storeRoot check below) —
// but if that root has permanently diverged (a moved home directory, or the
// index's empty-rebuild guard pinning a stale claude-meta.json root — see
// finding F1), no instance will EVER claim it, and the CLI already told the
// user "Queued — applies next time it opens," which becomes permanently false.
// 3 days is comfortably longer than an ordinary weekend with the laptop off
// (so it never fires on a request that's still going to be claimed), short
// enough that a truly orphaned request doesn't sit for weeks. It outlives the
// 24h receipt TTL by design: the error receipt this produces is swept 24h
// after IT is written (same as any other receipt), so a CLI `receipt` call
// made soon after expiry still sees it, and one made later falls back to the
// existing "not applied yet, or cleaned up a day ago" message — which, for
// this case, is now moot because the request is gone either way.
const FOREIGN_STORE_TTL_DAYS = 3;
const FOREIGN_STORE_TTL_MS = FOREIGN_STORE_TTL_DAYS * 24 * 3600_000;
type Store = NonNullable<ReturnType<typeof getConversationStore>>;
const STORE_DOWN = 'conversation storage is not available right now — retry with YouCoded open';

export function outboxDir(homeRoot: string): string { return path.join(chatsearchDir(homeRoot), 'outbox'); }

export interface ApplyDeps { appVersion: string; today: () => string }
export interface DrainOpts extends ApplyDeps {
  homeRoot: string; storeRoot: string; isDevInstance: boolean; devOverride?: boolean;
}

function writeJsonAtomic(target: string, value: unknown): void {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

async function applyFlag(store: Store, t: OutboxTarget, flagKey: string, value: boolean): Promise<ReceiptResult> {
  const rec = await store.get(t.provider, t.id);
  if (!rec) return { ...t, op: 'flag', status: 'not-found' };
  const current = rec.flags?.[flagKey]?.value === true;
  if (current === value) return { ...t, op: 'flag', status: 'already' };
  // Fix (comment only — the argument itself was already correct): this passes
  // whether the OUTBOX REQUEST'S target names the 'native' provider (the CLI
  // read it from a native-runtime session), not whether the drainer can see a
  // live desktop id. noteFlagChanged uses it to pick which on-disk store to
  // write the flag into.
  const res = await noteFlagChanged(t.id, flagKey, value, t.provider === 'native');
  if (!res.ok) return { ...t, op: 'flag', status: 'error', error: 'Could not save — conversation storage is not available on this device.' };
  broadcastSessionMeta(t.id, { flag: flagKey, value });
  return { ...t, op: 'flag', status: 'applied' };
}

export async function applyOutboxRequest(req: OutboxRequest, deps: ApplyDeps): Promise<OutboxReceipt> {
  const results: ReceiptResult[] = [];
  const createdTags: Array<{ id: string; label: string }> = [];
  const receipt = (): OutboxReceipt => ({ v: OUTBOX_FORMAT_VERSION, id: req.id, appliedAt: new Date().toISOString(), appVersion: deps.appVersion, results, createdTags });
  const store = getConversationStore();
  // WHY error and not not-found: the store is null only while starting or after
  // quit began. "Not found" would be a wrong, permanent answer for a real conversation.
  if (!store) {
    for (const op of req.ops) for (const t of op.targets) results.push({ ...t, op: op.op, status: 'error', error: STORE_DOWN });
    return receipt();
  }

  for (const op of req.ops) {
    if (op.op === 'flag') {
      for (const t of op.targets) results.push(await applyFlag(store, t, op.flag, op.value));
    } else if (op.op === 'note') {
      for (const t of op.targets) {
        const rec = await store.get(t.provider, t.id);
        if (!rec) { results.push({ ...t, op: 'note', status: 'not-found' }); continue; }
        if (op.mode === 'append' && hasDatedLine(rec.note ?? '', op.text)) { results.push({ ...t, op: 'note', status: 'already' }); continue; }
        const next = op.mode === 'set' ? op.text : appendNoteText(rec.note ?? '', deps.today(), op.text);
        if (next.length > NOTE_MAX_CHARS) { results.push({ ...t, op: 'note', status: 'refused', error: `note would exceed ${NOTE_MAX_CHARS} characters (${next.length})` }); continue; }
        if (next === (rec.note ?? '')) { results.push({ ...t, op: 'note', status: 'already' }); continue; }
        const res = await noteSessionNote(t.id, next, t.provider === 'native');
        if (!res.ok) { results.push({ ...t, op: 'note', status: 'error', error: 'Could not save — conversation storage is not available on this device.' }); continue; }
        broadcastSessionMeta(t.id, { note: next });
        results.push({ ...t, op: 'note', status: 'applied' });
      }
    } else if (op.op === 'tag') {
      const reg = getTagRegistry();
      if (!reg) { for (const t of op.targets) results.push({ ...t, op: 'tag', status: 'error', error: 'tag registry unavailable' }); continue; }
      const all = (await reg.list()).filter((x) => !x.archived);
      const byLabel = new Map(all.map((x) => [x.label.toLowerCase(), x]));
      const resolve = async (label: string, allowCreate: boolean) => {
        const hit = byLabel.get(label.toLowerCase());
        if (hit) return hit;
        if (!allowCreate) return null;
        const made = await reg.create(label, DEFAULT_TAG_COLOR);
        byLabel.set(label.toLowerCase(), made); createdTags.push({ id: made.id, label: made.label });
        return made;
      };
      // WHY resolve before touching any target: an unknown label refuses the
      // whole op — partial application across 22 conversations is worse than none.
      const adds = []; const removes = []; let refused: string | null = null;
      for (const l of op.add) { const r = await resolve(l, op.create); if (!r) { refused = l; break; } adds.push(r); }
      if (!refused) for (const l of op.remove) { const r = await resolve(l, false); if (!r) { refused = l; break; } removes.push(r); }
      if (refused) {
        const existing = all.map((x) => x.label).sort().join(', ') || '(none)';
        for (const t of op.targets) results.push({ ...t, op: 'tag', status: 'refused', error: `unknown tag "${refused}" — existing tags: ${existing}` });
        continue;
      }
      for (const t of op.targets) {
        let worst: ReceiptResult | null = null; let applied = false;
        for (const [tag, value] of [...adds.map((a) => [a, true] as const), ...removes.map((r) => [r, false] as const)]) {
          const r = await applyFlag(store, t, tagFlagKey(tag.id), value);
          if (r.status === 'applied') applied = true;
          if (r.status === 'not-found' || r.status === 'error') { worst = { ...r, op: 'tag' }; break; }
        }
        results.push(worst ?? { ...t, op: 'tag', status: applied ? 'applied' : 'already' });
      }
    }
  }
  if (results.some((r) => r.status === 'applied')) emitConversationMetaChanged();
  // WHY: reg.create() above bypasses the TAGS_CREATE IPC handler — the only
  // other place a new tag reaches a renderer/remote broadcast — so without
  // this a tag the drainer creates is invisible to the open window's tag
  // registry and filter list until a restart, even though the conversation
  // already shows the tag flag. Fired once per REQUEST (not per op, not per
  // tag), matching emitConversationMetaChanged's discipline above.
  if (createdTags.length > 0) broadcastTagsChanged();
  return receipt();
}

// WHY a Set + log-once-per-file: a request stuck for another store never
// clears (see the storeRoot check below), and the poll runs every 5s — without
// this, one orphaned request logs at INFO forever, and since logger.ts trims
// to the last 500 lines, that single orphan evicts every other log line within
// minutes. Cleared in stopOutboxDrain so a fresh drain cycle (new store root,
// e.g. switching profiles) logs the mismatch again instead of staying silent.
const foreignStoreLogged = new Set<string>();

function recoverStaleProcessing(dir: string): void {
  const proc = path.join(dir, 'processing');
  let names: string[] = [];
  try { names = fs.readdirSync(proc); } catch { return; }
  for (const n of names) {
    const p = path.join(proc, n);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > PROCESSING_STALE_MS) fs.renameSync(p, path.join(dir, n));
    } catch { /* another instance got there first */ }
  }
}

function sweepReceipts(dir: string): void {
  const done = path.join(dir, 'done');
  let names: string[] = [];
  try { names = fs.readdirSync(done); } catch { return; }
  for (const n of names) {
    const p = path.join(done, n);
    try { if (Date.now() - fs.statSync(p).mtimeMs > RECEIPT_TTL_MS) fs.unlinkSync(p); } catch { /* best effort */ }
  }
}

// Finding F6: the CLI writes '<uuid>.json.tmp-<pid>' then renames it into
// place (see submitRequest in the CLI's chatsearch.js). A CLI killed between
// those two calls leaves the tmp file behind in the outbox root forever — the
// '.json' filter in drainOutboxOnce's main loop correctly never claims it (it
// isn't a valid request name), but nothing else ever removed it either. Same
// age rule as the foreign-store expiry above, and no receipt: there is no
// request here to answer — the CLI already gave up on this particular write.
function sweepStaleTmpFiles(dir: string): void {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.includes('.tmp-')) continue; // 'processing'/'done' subdirs and real requests never match
    const p = path.join(dir, n);
    try { if (Date.now() - fs.statSync(p).mtimeMs > FOREIGN_STORE_TTL_MS) fs.unlinkSync(p); } catch { /* best effort */ }
  }
}

/** The three housekeeping passes — abandoned claims, old receipts, the CLI's
 *  crash litter. WHY separate from the drain (2026-09-16 audit W9): they ran
 *  on every pass, and the pass ran every 5 s, so an empty queue cost four
 *  directory listings every 5 s (~69k a day). None of them is time-critical;
 *  they run once at start and then hourly (startOutboxDrain). */
export function sweepOutbox(homeRoot: string): void {
  const dir = outboxDir(homeRoot);
  if (!fs.existsSync(dir)) return;
  recoverStaleProcessing(dir);
  sweepReceipts(dir);
  sweepStaleTmpFiles(dir);
}

/** One pass over the outbox. Returns how many requests this instance handled. */
export async function drainOutboxOnce(opts: DrainOpts): Promise<number> {
  if (opts.isDevInstance && !opts.devOverride) return 0;
  const dir = outboxDir(opts.homeRoot);
  if (!fs.existsSync(dir)) return 0;
  let handled = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue; // the CLI's temp files end in .tmp-<pid>, so they never match
    const src = path.join(dir, name);
    let raw: string;
    try { raw = fs.readFileSync(src, 'utf8'); } catch { continue; }
    const parsed = parseOutboxRequest(raw);
    // WHY check storeRoot BEFORE claiming: a request for another store must stay
    // visible to the instance it belongs to — unless it's aged past
    // FOREIGN_STORE_TTL_MS, at which point "the instance it belongs to" is
    // never coming (see the constant's WHY above; finding F1).
    if (parsed.ok && parsed.req.storeRoot !== opts.storeRoot) {
      let mtimeMs = Date.now();
      try { mtimeMs = fs.statSync(src).mtimeMs; } catch { /* vanished between readdir and stat; treat as fresh */ }
      if (Date.now() - mtimeMs > FOREIGN_STORE_TTL_MS) {
        // WHY an error receipt naming the root we measured, not a guess at why
        // it differs: the CLI's earlier "Queued" message told the user this
        // was pending. It is now permanently dead, and the user needs the real
        // fact (which store it was addressed to vs. this one) to investigate,
        // not a hardcoded guess at the cause.
        const id = name.replace(/\.json$/, '');
        const receipt: OutboxReceipt = {
          v: OUTBOX_FORMAT_VERSION, id, appliedAt: new Date().toISOString(), appVersion: opts.appVersion, results: [], createdTags: [],
          error: `request was addressed to a different conversation store (${parsed.req.storeRoot}) than this device's current store, and sat unclaimed for over ${FOREIGN_STORE_TTL_DAYS} days — it will not be applied`,
        };
        try { writeJsonAtomic(path.join(dir, 'done', `${id}.ack.json`), receipt); } catch { /* best effort */ }
        try { fs.unlinkSync(src); } catch { /* already gone */ }
        foreignStoreLogged.delete(name);
        continue;
      }
      if (!foreignStoreLogged.has(name)) {
        foreignStoreLogged.add(name);
        log('INFO', 'chatsearch-outbox', 'request for another store left in place', { id: parsed.req.id, storeRoot: parsed.req.storeRoot });
      }
      continue;
    }
    const claimed = path.join(dir, 'processing', name);
    fs.mkdirSync(path.dirname(claimed), { recursive: true });
    try { fs.renameSync(src, claimed); } catch { continue; } // lost the race
    // WHY re-stamp mtime right after the claim: rename() PRESERVES the source
    // file's mtime (verified empirically), so without this the 10-minute
    // stale-processing window measures time since the CLI WROTE the request,
    // not time since THIS instance claimed it. A request queued while the app
    // was closed — an explicitly supported case — could sit for well over 10
    // minutes before being claimed, making it stale-eligible the instant it's
    // claimed: a second instance's recoverStaleProcessing would rename it
    // straight back out and apply it again while this instance is mid-apply.
    try { const now = new Date(); fs.utimesSync(claimed, now, now); } catch { /* best effort */ }
    const id = name.replace(/\.json$/, '');
    let receipt: OutboxReceipt;
    if (!parsed.ok) {
      receipt = { v: OUTBOX_FORMAT_VERSION, id, appliedAt: new Date().toISOString(), appVersion: opts.appVersion, results: [], createdTags: [], error: parsed.error };
    } else {
      try { receipt = await applyOutboxRequest(parsed.req, opts); }
      catch (e: any) {
        receipt = { v: OUTBOX_FORMAT_VERSION, id, appliedAt: new Date().toISOString(), appVersion: opts.appVersion, results: [], createdTags: [], error: `apply failed — ${e?.message ?? String(e)}` };
      }
    }
    writeJsonAtomic(path.join(dir, 'done', `${id}.ack.json`), receipt);
    try { fs.unlinkSync(claimed); } catch { /* already gone */ }
    handled++;
  }
  return handled;
}

// ---- lifecycle -------------------------------------------------------------
let watcher: fs.FSWatcher | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let storeWaitTimer: NodeJS.Timeout | null = null;
let running = false;
let rerun = false;
const SWEEP_MS = 60 * 60_000;
// How long the start-up drain keeps waiting for the conversation store to come
// up, in 1 s tries. It used to lean on the 5 s poll for this (see startOutboxDrain).
const STORE_WAIT_TRIES = 120;

// WHY exported: startOutboxDrain/liveOpts/drainSerialized were entirely
// unexercised by tests — nothing proved YOUCODED_PROFILE and
// YOUCODED_CHATSEARCH_OUTBOX are actually read correctly, and a dev instance
// wrongly draining (and rewriting) the user's REAL conversation metadata is
// the exact failure the dev-instance gate exists to prevent. Exporting this
// seam lets tests call it directly instead of only through drainOutboxOnce's
// hand-built opts.
export function liveOpts(): DrainOpts | null {
  const store = getConversationStore();
  if (!store) return null;
  return {
    homeRoot: os.homedir(), storeRoot: store.root(),
    isDevInstance: !!process.env.YOUCODED_PROFILE, devOverride: process.env.YOUCODED_CHATSEARCH_OUTBOX === '1',
    appVersion: app?.getVersion?.() ?? 'dev', today: () => new Date().toISOString().slice(0, 10),
  };
}

export async function drainSerialized(): Promise<void> {
  if (running) { rerun = true; return; }
  running = true;
  try {
    do { rerun = false; const o = liveOpts(); if (o) await drainOutboxOnce(o); } while (rerun);
  } catch (e: any) {
    log('WARN', 'chatsearch-outbox', 'drain failed', { error: e?.message ?? String(e) });
  } finally { running = false; }
}

function startPoll(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => { void drainSerialized(); }, POLL_MS); pollTimer.unref?.();
}

/** startOutboxDrain() runs from main.ts before startConversationStore()'s
 *  promise resolves (fired-and-forgotten, not awaited), so liveOpts() sees no
 *  store yet and a drain now would be a no-op. Requests queued while the app
 *  was closed used to be applied by the first 5 s poll instead; with that poll
 *  gone off Windows, this waits for the store and drains once it is up. */
function drainWhenStoreReady(triesLeft: number): void {
  storeWaitTimer = null;
  if (liveOpts()) { void drainSerialized(); return; }
  if (triesLeft <= 0) return; // the store never came up; the watch still drains new requests
  storeWaitTimer = setTimeout(() => drainWhenStoreReady(triesLeft - 1), 1000);
  storeWaitTimer.unref?.();
}

export function startOutboxDrain(): void {
  stopOutboxDrain();
  const home = os.homedir();
  const dir = outboxDir(home);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* drain will no-op */ }
  let watching = false;
  try {
    watcher = fs.watch(dir, () => { void drainSerialized(); });
    watcher.on('error', () => { watcher?.close(); watcher = null; startPoll(); });
    watching = true;
  } catch { watcher = null; }
  // WHY the poll is Windows-only beside a healthy watch (2026-09-16 audit W9):
  // Windows drops directory notifications, the other platforms do not, and this
  // queue is empty almost always — the poll was ~17k listings a day for nothing.
  // A watch that could not attach, or that errors later, gets the poll instead.
  if (!watching || process.platform === 'win32') startPoll();
  // Housekeeping: once now, then hourly — see sweepOutbox. The hourly tick also
  // drains: if the store took longer than the start-up wait below, requests
  // queued while the app was closed would otherwise sit until the next write.
  sweepOutbox(home);
  sweepTimer = setInterval(() => { sweepOutbox(home); void drainSerialized(); }, SWEEP_MS); sweepTimer.unref?.();
  drainWhenStoreReady(STORE_WAIT_TRIES);
}

export function stopOutboxDrain(): void {
  watcher?.close(); watcher = null;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  if (storeWaitTimer) { clearTimeout(storeWaitTimer); storeWaitTimer = null; }
  foreignStoreLogged.clear();
}
