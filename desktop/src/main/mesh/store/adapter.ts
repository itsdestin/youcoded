// Seam S1: runtime chat file -> store (source adapter). Ported from the Phase 0 prototype
// (docs/active/prototypes/2026-11-14-mesh-phase0/T2/adapter.mjs, 11 passing tests) and extended with
// batching, mtime, the conversation chain and classification counts. Nothing here is weakened.
//
// WHY this shape: the mesh must NEVER silently absorb a file that stopped being append-only. Every way
// a file can stop being a pure extension of what was already ingested comes back as `rewritten` (the
// caller then records a diagnostic and starts a NEW VERSION; no segments, segments-decision). A torn
// final line (a writer mid-append) is never ingested; it waits for its newline.
//
// The cheap check is one fstat plus two small reads (first 4 KiB, last 64 KiB before the offset), so it
// does not grow with file size (0.17 ms median at 311 MB in the prototype). A full re-hash of the
// prefix happens only when the cheap check fails, or when the caller asks for `scrub()`. The one blind
// spot is a same-size edit in the middle of a big file: only `scrub()` sees it.
//
// This module only ever opens runtime files for reading. It never writes, renames or deletes them
// (design 5.3: the mesh never touches a file a runtime has open).
import * as fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chainStep, hex, unhex, type ChainSeeds, type RuntimeKind } from './chain';
import { analyseLine, initialReplyState, replyEndStep, type LineKind, type ReplyEndOptions, type ReplyState } from './classify';

export const TAIL_BYTES = 64 * 1024;
const HEAD_BYTES = 4 * 1024;
const READ_CHUNK = 4 * 1024 * 1024;
/** One poll hands back about this much (whole lines). First ingest of a 300 MB chat is many batches. */
const DEFAULT_BATCH_BYTES = 8 * 1024 * 1024;

/** JSON-safe; the caller may persist it between runs. */
export interface AdapterState {
  offset: number;        // bytes ingested; always just after a newline
  lines: number;         // lines ingested = absolute number of the next line
  chain: string;         // raw chain value after `lines` lines (hex)
  conv: string;          // conversation chain value (hex)
  convLines: number;
  dev: string | null;    // file identity (UNVERIFIED on some Windows file systems)
  ino: string | null;
  mtimeMs: number | null;
  tailHash: string | null; // SHA-256 of the last <=64 KiB before offset
  headHash: string | null; // SHA-256 of the first <=4 KiB of the file
  rs: ReplyState;
}

export interface AdapterOptions {
  runtime: RuntimeKind;
  seeds: ChainSeeds;
  /** On a changed file identity, re-hash the prefix and continue if it is intact (S1: "replaced may first..."). Default: report `replaced`. */
  verifyReplaced?: boolean;
  maxBatchBytes?: number;
  replyEnd?: ReplyEndOptions;
}

export type RewriteReason = 'missing' | 'replaced' | 'shrunk' | 'rewritten' | `unreadable:${string}`;

interface LineCounts { user: number; assistant: number; bookkeeping: number; invalid: number; oversize: number }

export interface PollBatch {
  lines: Buffer[];
  /** Line numbers confirmed as reply ends by this batch (may name lines from earlier batches). */
  replyEnds: number[];
  counts: LineCounts;
  state: AdapterState;
  /** More whole lines are waiting: call poll again with the returned state. */
  more: boolean;
  /** Bytes of an unterminated final line seen at the end of the file (0 when none). */
  tornBytes: number;
}
export type PollResult = PollBatch | { rewritten: RewriteReason; state: AdapterState };
export const isRewritten = (r: PollResult): r is { rewritten: RewriteReason; state: AdapterState } => 'rewritten' in r;

export function initAdapterState(seeds: ChainSeeds): AdapterState {
  return {
    offset: 0, lines: 0, chain: hex(seeds.raw), conv: hex(seeds.conversation), convLines: 0,
    dev: null, ino: null, mtimeMs: null, tailHash: null, headHash: null, rs: initialReplyState(),
  };
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function pread(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const b = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(b, got, len - got, pos + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got === len ? b : b.subarray(0, got);
}

/** Re-hash bytes 0..offset line by line; null when the prefix is not whole lines or the file is shorter. */
async function rehash(fh: FileHandle, seed: Buffer, offset: number): Promise<{ chain: string; lines: number } | null> {
  let chain: Buffer = seed;
  let pos = 0; let carry: Buffer = Buffer.alloc(0); let lines = 0;
  while (pos < offset) {
    const buf = await pread(fh, pos, Math.min(READ_CHUNK, offset - pos));
    if (buf.length === 0) return null;
    pos += buf.length;
    const data = carry.length ? Buffer.concat([carry, buf]) : buf;
    let start = 0; let nl: number;
    while ((nl = data.indexOf(0x0a, start)) !== -1) { chain = chainStep(chain, data.subarray(start, nl + 1)); lines++; start = nl + 1; }
    carry = data.subarray(start);
  }
  return carry.length ? null : { chain: hex(chain), lines };
}

export type CheapResult =
  | { kind: 'unchanged'; touched: boolean }       // touched: mtime moved but size and hashes did not (a scrub is advisable)
  | { kind: 'grew'; size: number }
  | { kind: 'suspect' }                            // identity/size fine but head or tail hash differs: needs the full re-hash
  | { kind: 'replaced' | 'shrunk' }
  | { kind: 'missing' | 'unreadable'; code?: string };

/**
 * The cheap "unchanged?" poll: identity, size, mtime, first-4-KiB hash and a tail check. Reads at most
 * 68 KiB regardless of file size. Does not ingest anything.
 */
export async function cheapCheck(path: string, state: AdapterState): Promise<CheapResult> {
  let fh: FileHandle;
  try { fh = await fsp.open(path, 'r'); }
  catch (e: any) { return e.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', code: e.code }; }
  try { return (await cheapOn(fh, state)).result; } finally { await fh.close(); }
}

async function cheapOn(fh: FileHandle, state: AdapterState): Promise<{ result: CheapResult; size: number; dev: string; ino: string; mtimeMs: number; prevTail: Buffer }> {
  const st = await fh.stat({ bigint: true });
  const size = Number(st.size); const dev = String(st.dev); const ino = String(st.ino); const mtimeMs = Number(st.mtimeMs);
  const base = { size, dev, ino, mtimeMs, prevTail: Buffer.alloc(0) };
  if (state.offset === 0) return { ...base, result: size > 0 ? { kind: 'grew', size } : { kind: 'unchanged', touched: false } };
  if (state.ino !== null && (state.ino !== ino || state.dev !== dev)) return { ...base, result: { kind: 'replaced' } };
  if (size < state.offset) return { ...base, result: { kind: 'shrunk' } };
  const tl = Math.min(TAIL_BYTES, state.offset);
  const prevTail = await pread(fh, state.offset - tl, tl);
  const head = await pread(fh, 0, Math.min(HEAD_BYTES, state.offset));
  const ok = prevTail.length === tl && head.length === Math.min(HEAD_BYTES, state.offset)
    && sha(prevTail) === state.tailHash && sha(head) === state.headHash;
  if (!ok) return { ...base, prevTail, result: { kind: 'suspect' } };
  if (size > state.offset) return { ...base, prevTail, result: { kind: 'grew', size } };
  return { ...base, prevTail, result: { kind: 'unchanged', touched: state.mtimeMs !== null && state.mtimeMs !== mtimeMs } };
}

/**
 * Read the next batch of whole lines. Returns `rewritten` for ANY non-append event instead of guessing.
 * Call repeatedly while `more` is true to stream a large file; each returned state is a valid resume point.
 */
export async function poll(path: string, state: AdapterState, opts: AdapterOptions): Promise<PollResult> {
  let fh: FileHandle;
  try { fh = await fsp.open(path, 'r'); }
  catch (e: any) { return { rewritten: e.code === 'ENOENT' ? 'missing' : `unreadable:${e.code}`, state }; }
  try {
    const cheap = await cheapOn(fh, state);
    const r = cheap.result;
    if (r.kind === 'replaced') {
      if (!opts.verifyReplaced || cheap.size < state.offset) return { rewritten: 'replaced', state };
      const rh = await rehash(fh, opts.seeds.raw, state.offset);
      if (!rh || rh.chain !== state.chain || rh.lines !== state.lines) return { rewritten: 'replaced', state };
      // identity is new but the bytes are the same: carry on against the new file (the tail window below needs its bytes)
      const tl = Math.min(TAIL_BYTES, state.offset);
      cheap.prevTail = await pread(fh, state.offset - tl, tl);
    } else if (r.kind === 'shrunk') return { rewritten: 'shrunk', state };
    else if (r.kind === 'missing' || r.kind === 'unreadable') return { rewritten: 'missing', state };
    else if (r.kind === 'suspect') {
      // Cheap check failed: the full re-hash is the only place we read the whole prefix. If the chain still
      // matches, the stored cheap hashes were merely stale and are refreshed below.
      const rh = await rehash(fh, opts.seeds.raw, state.offset);
      if (!rh || rh.chain !== state.chain || rh.lines !== state.lines) return { rewritten: 'rewritten', state };
    }

    const maxBatch = opts.maxBatchBytes ?? DEFAULT_BATCH_BYTES;
    const lines: Buffer[] = []; const replyEnds: number[] = [];
    const counts: LineCounts = { user: 0, assistant: 0, bookkeeping: 0, invalid: 0, oversize: 0 };
    let raw: Buffer = unhex(state.chain); let conv: Buffer = unhex(state.conv);
    let offset = state.offset; let lineNo = state.lines; let convLines = state.convLines;
    let rs: ReplyState = state.rs ?? initialReplyState();
    let carry: Buffer = Buffer.alloc(0);
    let pos = state.offset; let batchBytes = 0; let more = false;
    const size = cheap.size;
    outer: while (pos < size) {
      const buf = await pread(fh, pos, Math.min(READ_CHUNK, size - pos));
      if (buf.length === 0) break;
      pos += buf.length;
      const data = carry.length ? Buffer.concat([carry, buf]) : buf;
      let start = 0; let nl: number;
      while ((nl = data.indexOf(0x0a, start)) !== -1) {
        // copy: a returned line must not alias the read buffer
        const line = Buffer.from(data.subarray(start, nl + 1));
        raw = chainStep(raw, line);
        const info = analyseLine(opts.runtime, line);
        if (info.conversation) { conv = chainStep(conv, line); convLines++; }
        counts[info.kind as LineKind]++;
        const step = replyEndStep(opts.runtime, rs, info, lineNo, opts.replyEnd);
        rs = step.rs; for (const c of step.confirmed) replyEnds.push(c);
        lines.push(line); lineNo++; offset += line.length; batchBytes += line.length; start = nl + 1;
        if (batchBytes >= maxBatch) {
          // stop at a line boundary; the next poll re-reads the remainder from `offset`
          carry = Buffer.alloc(0);
          more = true;
          break outer;
        }
      }
      carry = Buffer.from(data.subarray(start));
    }
    // The tail window is built from the bytes we READ (previous tail + the lines just returned), so the
    // stored tail hash describes exactly the bytes the chain covers: no read-after-write race with a live writer.
    const tailParts: Buffer[] = []; let tn = 0;
    for (let i = lines.length - 1; i >= 0 && tn < TAIL_BYTES; i--) { tailParts.unshift(lines[i]); tn += lines[i].length; }
    let window: Buffer = Buffer.concat([cheap.prevTail, ...tailParts]);
    if (window.length > TAIL_BYTES) window = window.subarray(window.length - TAIL_BYTES);
    // `carry` (an unterminated final line) is deliberately NOT ingested.
    const tornBytes = more ? 0 : carry.length;

    let headHash = state.headHash;
    if (offset > 0 && (headHash === null || state.offset < HEAD_BYTES)) headHash = sha(await pread(fh, 0, Math.min(HEAD_BYTES, offset)));
    const next: AdapterState = {
      offset, lines: lineNo, chain: hex(raw), conv: hex(conv), convLines,
      dev: cheap.dev, ino: cheap.ino, mtimeMs: cheap.mtimeMs,
      tailHash: offset > 0 ? sha(window) : null, headHash, rs,
    };
    return { lines, replyEnds, counts, state: next, more, tornBytes };
  } finally { await fh.close(); }
}

/** Stream a whole file (or the rest of it) in batches; stops and returns `rewritten` when one is found. */
export async function* ingest(path: string, state: AdapterState, opts: AdapterOptions): AsyncGenerator<PollBatch, { rewritten: RewriteReason; state: AdapterState } | null> {
  let s = state;
  for (;;) {
    const r = await poll(path, s, opts);
    if (isRewritten(r)) return r;
    if (r.lines.length) yield r;
    s = r.state;
    if (!r.more) return null;
  }
}

/** Full re-hash regardless of the cheap check: the only thing that catches a same-size mid-file edit. */
export async function scrub(path: string, state: AdapterState, opts: Pick<AdapterOptions, 'seeds'>): Promise<boolean> {
  const fh = await fsp.open(path, 'r');
  try {
    const r = await rehash(fh, opts.seeds.raw, state.offset);
    return !!r && r.chain === state.chain && r.lines === state.lines;
  } finally { await fh.close(); }
}
