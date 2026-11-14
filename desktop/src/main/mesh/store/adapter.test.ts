// S1 tests. The first eleven are the Phase 0 prototype's tests (T2/adapter.test.mjs) ported unchanged in
// intent; the rest cover batching, torn tails, the conversation chain, awkward lines and the reply-end fixtures.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { defaultChainSeeds, hex } from './chain';
import { initAdapterState, poll, scrub, cheapCheck, ingest, isRewritten, TAIL_BYTES, type AdapterOptions, type PollBatch, type AdapterState } from './adapter';
import { ccConversation, nativeConversation, cc, native, awkward, nl } from './fixtures';
import { analyseLine, replyEndStep, settleReplyEnd, initialReplyState } from './classify';

const seeds = defaultChainSeeds({ chatId: 'test-chat', version: new Uint8Array(), segment: 0 });
const opts: AdapterOptions = { runtime: 'native', seeds };
let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-adapter-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const line = (i: number, end = false) => Buffer.from(JSON.stringify({ i, pad: 'x'.repeat(200), end }) + '\n');
let n = 0;
const fresh = () => path.join(dir, `f${n++}.jsonl`);
const ok = (r: Awaited<ReturnType<typeof poll>>): PollBatch => { if (isRewritten(r)) throw new Error('rewritten: ' + r.rewritten); return r; };
/** Independent chain implementation (does not use chain.ts) so a bug there cannot hide itself. */
function chainOf(lines: Buffer[]): string {
  let h = Buffer.from(seeds.raw);
  for (const l of lines) h = createHash('sha256').update(h).update(l).digest();
  return h.toString('hex');
}
const splitLines = (b: Buffer): Buffer[] => { const out: Buffer[] = []; let s = 0; let i; while ((i = b.indexOf(0x0a, s)) !== -1) { out.push(b.subarray(s, i + 1)); s = i + 1; } return out; };

describe('S1 adapter (ported prototype tests)', () => {
  it('append: only new lines come back, chain advances, unchanged poll is empty', async () => {
    const f = fresh();
    fs.writeFileSync(f, Buffer.concat([line(0), line(1)]));
    let r = ok(await poll(f, initAdapterState(seeds), opts));
    expect(r.lines.length).toBe(2);
    fs.appendFileSync(f, Buffer.concat([line(2), line(3)]));
    r = ok(await poll(f, r.state, opts));
    expect(r.lines.map(String)).toEqual([line(2), line(3)].map(String));
    expect(r.state.lines).toBe(4);
    r = ok(await poll(f, r.state, opts));
    expect(r.lines.length).toBe(0);
    expect(r.state.chain).toBe(chainOf([line(0), line(1), line(2), line(3)]));
    expect(await scrub(f, r.state, opts)).toBe(true);
  });

  it('partial trailing line is not ingested until its newline arrives', async () => {
    const f = fresh();
    fs.writeFileSync(f, Buffer.concat([line(0), line(1).subarray(0, 50)]));
    let r = ok(await poll(f, initAdapterState(seeds), opts));
    expect(r.lines.length).toBe(1);
    expect(r.state.offset).toBe(line(0).length);
    expect(r.tornBytes).toBe(50);
    r = ok(await poll(f, r.state, opts));
    expect(r.lines.length).toBe(0);
    expect(r.tornBytes).toBe(50);
    fs.appendFileSync(f, line(1).subarray(50));
    r = ok(await poll(f, r.state, opts));
    expect(r.lines.map(String)).toEqual([String(line(1))]);
    expect(r.tornBytes).toBe(0);
  });

  it('truncate (shrink) -> rewritten', async () => {
    const f = fresh();
    fs.writeFileSync(f, Buffer.concat([line(0), line(1), line(2)]));
    const r = ok(await poll(f, initAdapterState(seeds), opts));
    fs.truncateSync(f, line(0).length);
    const r2 = await poll(f, r.state, opts);
    expect(isRewritten(r2) && r2.rewritten).toBe('shrunk');
  });

  it('truncate then regrow PAST the old size -> rewritten (a size check alone misses it)', async () => {
    const f = fresh();
    fs.writeFileSync(f, Buffer.concat([line(0), line(1)]));
    const r = ok(await poll(f, initAdapterState(seeds), opts));
    fs.writeFileSync(f, Buffer.concat([line(10), line(11), line(12), line(13)]));
    const r2 = await poll(f, r.state, opts);
    expect(isRewritten(r2) && r2.rewritten).toBe('rewritten');
  });

  it('in-place rewrite of earlier bytes, same size, inside the last 64 KiB -> rewritten', async () => {
    const f = fresh();
    fs.writeFileSync(f, Buffer.concat([line(0), line(1), line(2)]));
    const r = ok(await poll(f, initAdapterState(seeds), opts));
    const fd = fs.openSync(f, 'r+'); fs.writeSync(fd, 'Z', 100); fs.closeSync(fd);
    const r2 = await poll(f, r.state, opts);
    expect(isRewritten(r2) && r2.rewritten).toBe('rewritten');
  });

  it('in-place rewrite in the first 4 KiB of a big file -> rewritten (head check)', async () => {
    const f = fresh();
    const all = Buffer.concat(Array.from({ length: 2000 }, (_, i) => line(i)));
    fs.writeFileSync(f, all);
    const r = ok(await poll(f, initAdapterState(seeds), opts));
    expect(all.length).toBeGreaterThan(4 * TAIL_BYTES);
    const fd = fs.openSync(f, 'r+'); fs.writeSync(fd, 'Z', 50); fs.closeSync(fd);
    const r2 = await poll(f, r.state, opts);
    expect(isRewritten(r2) && r2.rewritten).toBe('rewritten');
  });

  it('KNOWN BLIND SPOT: a same-size mid-file edit passes the cheap check; scrub catches it', async () => {
    const f = fresh();
    const all = Buffer.concat(Array.from({ length: 2000 }, (_, i) => line(i)));
    fs.writeFileSync(f, all);
    const r = ok(await poll(f, initAdapterState(seeds), opts));
    const fd = fs.openSync(f, 'r+'); fs.writeSync(fd, 'Z', Math.floor(all.length / 2)); fs.closeSync(fd);
    const r2 = await poll(f, r.state, opts);
    expect(isRewritten(r2)).toBe(false); // documented: the cheap check cannot see this
    expect(await scrub(f, r.state, opts)).toBe(false);
  });

  it('file replaced by rename -> replaced (identity changed), even if the bytes are a clean extension', async () => {
    const f = fresh();
    const body = Buffer.concat([line(0), line(1)]);
    fs.writeFileSync(f, body);
    const r = ok(await poll(f, initAdapterState(seeds), opts));
    const tmp = f + '.new'; fs.writeFileSync(tmp, Buffer.concat([body, line(2)])); fs.renameSync(tmp, f);
    const r2 = await poll(f, r.state, opts);
    expect(isRewritten(r2) && r2.rewritten).toBe('replaced');
  });

  it('file deleted -> missing', async () => {
    const f = fresh();
    fs.writeFileSync(f, line(0));
    const r = ok(await poll(f, initAdapterState(seeds), opts));
    fs.unlinkSync(f);
    const r2 = await poll(f, r.state, opts);
    expect(isRewritten(r2) && r2.rewritten).toBe('missing');
  });

  it('a 13 MB append across the read chunk equals the from-scratch chain', async () => {
    const f = fresh();
    fs.writeFileSync(f, line(0));
    let r = ok(await poll(f, initAdapterState(seeds), opts));
    const more = Buffer.concat(Array.from({ length: 60000 }, (_, i) => line(i + 1)));
    fs.appendFileSync(f, more);
    r = ok(await poll(f, r.state, { ...opts, maxBatchBytes: 1 << 30 }));
    const scratch = ok(await poll(f, initAdapterState(seeds), { ...opts, maxBatchBytes: 1 << 30 }));
    expect(r.state.chain).toBe(scratch.state.chain);
    expect(r.state.lines).toBe(60001);
  });

  it('reply-end tracker: a 2-block final message ends once, at its LAST block line', () => {
    const seq = [cc.user(), cc.block('m1', 'tool_use', 'tool_use'), cc.toolResult(), cc.block('m2', 'end_turn', 'thinking'), cc.block('m2', 'end_turn', 'text'), cc.turnDuration(), cc.user(), cc.block('m3', 'end_turn', 'text')];
    let rs = initialReplyState(); const got: number[] = [];
    seq.forEach((b, i) => { const o = replyEndStep('claude-code', rs, analyseLine('claude-code', b), i); rs = o.rs; got.push(...o.confirmed); });
    expect(got).toEqual([4]);
    expect(rs.cand?.n).toBe(7);
  });
});

describe('S1 adapter (new behaviour)', () => {
  it('streams a file in batches and every batch boundary lands on a line boundary', async () => {
    const f = fresh();
    const all = Buffer.concat(Array.from({ length: 3000 }, (_, i) => line(i)));
    fs.writeFileSync(f, all);
    let got = 0; let batches = 0; let last: AdapterState = initAdapterState(seeds);
    const g = ingest(f, last, { ...opts, maxBatchBytes: 50_000 });
    for (;;) { const x = await g.next(); if (x.done) { expect(x.value).toBeNull(); break; } batches++; got += x.value.lines.length; last = x.value.state; expect(x.value.state.offset % 1).toBe(0); }
    expect(batches).toBeGreaterThan(5);
    expect(got).toBe(3000);
    expect(last.chain).toBe(chainOf(splitLines(all)));
    expect(last.offset).toBe(all.length);
  });

  it('a state saved after a batch resumes without re-reading or losing lines (cheap check still passes)', async () => {
    const f = fresh();
    const all = Buffer.concat(Array.from({ length: 1000 }, (_, i) => line(i)));
    fs.writeFileSync(f, all);
    const a = ok(await poll(f, initAdapterState(seeds), { ...opts, maxBatchBytes: 100_000 }));
    expect(a.more).toBe(true);
    const saved = JSON.parse(JSON.stringify(a.state)) as AdapterState; // a restart in between
    expect((await cheapCheck(f, saved)).kind).toBe('grew');
    const b = ok(await poll(f, saved, { ...opts, maxBatchBytes: 1 << 30 }));
    expect(a.lines.length + b.lines.length).toBe(1000);
    expect(b.state.chain).toBe(chainOf(splitLines(all)));
  });

  it('cheapCheck: unchanged, grew, touched-only (same bytes, newer mtime), and never reads the whole file', async () => {
    const f = fresh();
    fs.writeFileSync(f, Buffer.concat([line(0), line(1)]));
    const r = ok(await poll(f, initAdapterState(seeds), opts));
    expect(await cheapCheck(f, r.state)).toEqual({ kind: 'unchanged', touched: false });
    const future = new Date(Date.now() + 5000); fs.utimesSync(f, future, future);
    expect(await cheapCheck(f, r.state)).toEqual({ kind: 'unchanged', touched: true });
    fs.appendFileSync(f, line(2));
    expect((await cheapCheck(f, r.state)).kind).toBe('grew');
  });

  it('replaced file whose prefix is intact continues when verifyReplaced is set', async () => {
    const f = fresh();
    const body = Buffer.concat([line(0), line(1)]);
    fs.writeFileSync(f, body);
    const r = ok(await poll(f, initAdapterState(seeds), { ...opts, verifyReplaced: true }));
    const tmp = f + '.new'; fs.writeFileSync(tmp, Buffer.concat([body, line(2)])); fs.renameSync(tmp, f);
    const r2 = ok(await poll(f, r.state, { ...opts, verifyReplaced: true }));
    expect(r2.lines.length).toBe(1);
    expect(r2.state.chain).toBe(chainOf([line(0), line(1), line(2)]));
    // different bytes under a new identity are still reported
    fs.writeFileSync(tmp, Buffer.concat([line(9), line(8), line(7)])); fs.renameSync(tmp, f);
    const r3 = await poll(f, r2.state, { ...opts, verifyReplaced: true });
    expect(isRewritten(r3) && r3.rewritten).toBe('replaced');
  });

  it('splits on 0x0a only: raw U+2028/U+2029, invalid JSON and blank lines are ordinary lines, bytes intact', async () => {
    const f = fresh();
    const lines = [awkward.lineSeparators(), awkward.invalidJson().subarray(0, awkward.invalidJson().length), awkward.garbage(), awkward.spaced(), awkward.empty(), cc.user('ok')];
    // invalidJson() already ends with a newline inside what looks like a string; it is one line by the byte rule
    fs.writeFileSync(f, Buffer.concat(lines));
    const r = ok(await poll(f, initAdapterState(seeds), { ...opts, runtime: 'claude-code' }));
    expect(r.lines.map((b) => b.toString('hex'))).toEqual(lines.map((b) => b.toString('hex')));
    expect(r.counts.invalid).toBe(3); // invalidJson, garbage, empty line
    expect(r.state.lines).toBe(6);
  });

  it('conversation chain covers user/assistant lines only; bookkeeping never changes it', async () => {
    const conv = [cc.user('a'), cc.block('m1', 'end_turn', 'text'), cc.user('b')];
    const withBook = [conv[0], cc.bookkeeping('last-prompt'), conv[1], cc.title(), cc.bookkeeping('cost-state'), conv[2]];
    const fa = fresh(); const fb = fresh();
    fs.writeFileSync(fa, Buffer.concat(conv)); fs.writeFileSync(fb, Buffer.concat(withBook));
    const o = { ...opts, runtime: 'claude-code' as const };
    const a = ok(await poll(fa, initAdapterState(seeds), o)); const b = ok(await poll(fb, initAdapterState(seeds), o));
    expect(a.state.conv).toBe(b.state.conv);
    expect(a.state.chain).not.toBe(b.state.chain);
    expect(b.state.convLines).toBe(3);
    // and a different conversation line DOES change it
    fs.writeFileSync(fa, Buffer.concat([conv[0], conv[1], cc.user('c')]));
    expect(ok(await poll(fa, initAdapterState(seeds), o)).state.conv).not.toBe(a.state.conv);
  });

  it('Claude Code fixture conversation: confirmed ends match, one pending, across split polls too', async () => {
    const { lines, confirmed, pending } = ccConversation();
    const f = fresh();
    fs.writeFileSync(f, Buffer.concat(lines));
    const o = { ...opts, runtime: 'claude-code' as const };
    const whole = ok(await poll(f, initAdapterState(seeds), o));
    expect(whole.replyEnds).toEqual(confirmed);
    expect(whole.state.rs.cand?.n).toBe(pending);
    // the same file appended one line at a time, polling after each, finds the same ends (state survives restarts)
    const g = fresh();
    let st = initAdapterState(seeds); const ends: number[] = [];
    for (const l of lines) { fs.appendFileSync(g, l); const r = ok(await poll(g, JSON.parse(JSON.stringify(st)), o)); st = r.state; ends.push(...r.replyEnds); }
    expect(ends).toEqual(confirmed);
    expect(st.chain).toBe(whole.state.chain);
    // the host's idle signal settles the pending candidate
    expect(settleReplyEnd(st.rs).confirmed).toEqual([pending]);
  });

  it('streaming multi-block reply: no end until the message is complete; cut after block one would be wrong', () => {
    const seq = [cc.user(), cc.block('m1', 'end_turn', 'thinking'), cc.block('m1', 'end_turn', 'text'), cc.block('m1', 'end_turn', 'text')];
    let rs = initialReplyState(); const ends: number[][] = [];
    seq.forEach((b, i) => { const o = replyEndStep('claude-code', rs, analyseLine('claude-code', b), i); rs = o.rs; ends.push(o.confirmed); });
    expect(ends).toEqual([[], [], [], []]);
    expect(rs.cand?.n).toBe(3); // the LAST block line, not the first
  });

  it('interrupted reply and tool-use turns: interrupts end replies; tool_use never does', () => {
    const seq = [cc.user(), cc.block('m1', 'tool_use', 'tool_use'), cc.interrupt(), cc.user('again')];
    let rs = initialReplyState(); const got: number[] = [];
    seq.forEach((b, i) => { const o = replyEndStep('claude-code', rs, analyseLine('claude-code', b), i); rs = o.rs; got.push(...o.confirmed); });
    expect(got).toEqual([2]);
  });

  it('API-error lines end a reply by default (prototype behaviour) and can be switched off', () => {
    const seq = [cc.user(), cc.apiError('e1'), cc.user('retry')];
    const run = (apiErrorsEndReplies: boolean) => {
      let rs = initialReplyState(); const got: number[] = [];
      seq.forEach((b, i) => { const o = replyEndStep('claude-code', rs, analyseLine('claude-code', b), i, { apiErrorsEndReplies }); rs = o.rs; got.push(...o.confirmed); });
      return got;
    };
    expect(run(true)).toEqual([1]);
    expect(run(false)).toEqual([]);
  });

  it('native fixture: turn-complete and user-interrupt end immediately; bookkeeping types are not conversation', async () => {
    const { lines, confirmed } = nativeConversation();
    const f = fresh(); fs.writeFileSync(f, Buffer.concat(lines));
    const r = ok(await poll(f, initAdapterState(seeds), opts));
    expect(r.replyEnds).toEqual(confirmed);
    expect(r.state.convLines).toBe(lines.length - 2); // header and model-switch are bookkeeping
  });

  it('classification of every line kind', () => {
    const k = (b: Buffer) => analyseLine('claude-code', b);
    expect(k(cc.user()).kind).toBe('user');
    expect(k(cc.block('m', 'end_turn')).kind).toBe('assistant');
    for (const t of ['last-prompt', 'cost-state', 'ai-title', 'permission-mode', 'mode', 'session-owner', 'atis-latch', 'tools-used', 'file-history-snapshot', 'queue-operation', 'api-request', 'pr-link', 'bridge-session', 'attachment', 'system']) {
      expect(k(cc.bookkeeping(t))).toMatchObject({ kind: 'bookkeeping', conversation: false });
    }
    expect(k(awkward.garbage()).kind).toBe('invalid');
    expect(k(nl([1, 2])).kind).toBe('bookkeeping');
    expect(k(cc.title('T')).title).toBe('T');
  });

  it('never writes to the runtime file: mtime and bytes are unchanged after polling', async () => {
    const f = fresh();
    fs.writeFileSync(f, Buffer.concat([line(0), line(1)]));
    const before = fs.statSync(f); const bytes = fs.readFileSync(f);
    ok(await poll(f, initAdapterState(seeds), opts));
    const after = fs.statSync(f);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(fs.readFileSync(f).equals(bytes)).toBe(true);
  });
});
