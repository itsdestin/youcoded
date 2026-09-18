import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WHY these mocks and not fs: the drainer's contract is "apply through the real
// store functions and broadcast" — we assert on the calls, and use real files
// in a tmp home for the mailbox itself (same rule as chatsearch-index-reschedule).
const flagCalls: any[] = []; const noteCalls: any[] = []; const broadcasts: any[] = [];
// Finding 5: captures the 4th (isNative) arg noteFlagChanged actually receives,
// kept SEPARATE from flagCalls (a 3-tuple) so existing flagCalls assertions
// throughout this file don't have to change shape.
const flagNativeArgs: boolean[] = [];
let metaChanged = 0; let storeAvailable = true; let tagsChanged = 0;
const records = new Map<string, { note: string; flags: Record<string, { value: boolean }> }>();
vi.mock('../src/main/conversations/service', () => ({
  getConversationStore: () => storeAvailable ? {
    root: () => '/store/A',
    get: async (_p: string, id: string) => records.get(id) ?? null,
  } : null,
  noteFlagChanged: async (id: string, flag: string, value: boolean, isNative?: boolean) => {
    flagCalls.push([id, flag, value]); flagNativeArgs.push(!!isNative); return { ok: true };
  },
  noteSessionNote: async (id: string, note: string) => { noteCalls.push([id, note]); return { ok: true }; },
  emitConversationMetaChanged: () => { metaChanged++; },
}));
const tags = [{ id: 'tag_1', label: 'sync', color: 'tag-blue', archived: false, createdAt: '' }];
const created: any[] = [];
vi.mock('../src/main/conversations/tag-registry-service', () => ({
  getTagRegistry: () => ({
    list: async () => tags,
    create: async (label: string, color: string) => { const t = { id: `tag_${label}`, label, color, archived: false, createdAt: '' }; tags.push(t); created.push(t); return t; },
  }),
}));
// Finding 3: extend the mock to also capture broadcastTagsChanged() calls.
vi.mock('../src/main/ipc-handlers', () => ({
  broadcastSessionMeta: (id: string, p: any) => { broadcasts.push([id, p]); },
  broadcastTagsChanged: () => { tagsChanged++; },
}));
// Finding 4: capture log() calls so a test can assert the foreign-store
// message is logged once per file, not once per poll pass.
const logCalls: any[] = [];
vi.mock('../src/main/logger', () => ({ log: (...args: any[]) => { logCalls.push(args); } }));

import { parseOutboxRequest, appendNoteText, hasDatedLine } from '../src/main/chatsearch-index/outbox-format';
import {
  applyOutboxRequest, drainOutboxOnce, outboxDir, liveOpts, drainSerialized, sweepOutbox, startOutboxDrain, stopOutboxDrain,
} from '../src/main/chatsearch-index/outbox-drain';

let home: string;
const req = (ops: any[], extra: Partial<any> = {}) => ({
  v: 1, id: '11111111-2222-3333-4444-555555555555', createdAt: '2026-08-27T00:00:00.000Z', storeRoot: '/store/A', ops, ...extra,
});
const T = [{ provider: 'claude', id: 'c1' }];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-outbox-'));
  flagCalls.length = 0; noteCalls.length = 0; broadcasts.length = 0; created.length = 0;
  flagNativeArgs.length = 0; logCalls.length = 0; metaChanged = 0; storeAvailable = true; tagsChanged = 0;
  records.clear();
  records.set('c1', { note: '', flags: {} });
  records.set('c2', { note: 'old', flags: { complete: { value: true } } });
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('parseOutboxRequest', () => {
  it('rejects non-JSON with the parser message', () => {
    const r = parseOutboxRequest('{nope');
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toMatch(/not valid JSON/);
  });
  it('rejects a wrong version', () => {
    const r = parseOutboxRequest(JSON.stringify(req([{ op: 'flag', targets: T, flag: 'complete', value: true }], { v: 2 })));
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toMatch(/version 2/);
  });
  it('accepts a well-formed request', () => {
    const r = parseOutboxRequest(JSON.stringify(req([{ op: 'tag', targets: T, add: ['sync'] }])));
    expect(r.ok).toBe(true);
  });
});

describe('appendNoteText', () => {
  it('no leading newlines on an empty note', () => { expect(appendNoteText('', '2026-08-27', 'x')).toBe('2026-08-27: x'); });
  it('two newlines after an existing note', () => { expect(appendNoteText('old', '2026-08-27', 'x')).toBe('old\n\n2026-08-27: x'); });
  // Also-fix (minor): trailing whitespace on the existing note must not
  // accumulate extra newlines on every append.
  it('does not accumulate newlines when the existing note already ends in blank lines', () => {
    expect(appendNoteText('old\n\n', '2026-08-27', 'x')).toBe('old\n\n2026-08-27: x');
  });
});

describe('hasDatedLine', () => {
  it('matches on the text, whatever the date', () => {
    expect(hasDatedLine('old\n\n2026-08-26: superseded', 'superseded')).toBe(true);
    expect(hasDatedLine('old\n\n2026-08-26: superseded by X', 'superseded')).toBe(false);
    expect(hasDatedLine('superseded', 'superseded')).toBe(false); // undated body text is not a dated line
  });
  // Finding 1: `text` itself may contain a newline (an ordinary multi-line
  // close note) — appendNoteText writes it as ONE block, so the previous
  // per-line comparison could never match it and every retry re-appended.
  it('matches a multi-line block, not just a single line', () => {
    const block = '2026-08-26: first line\nsecond line';
    expect(hasDatedLine(`old\n\n${block}`, 'first line\nsecond line')).toBe(true);
    expect(hasDatedLine(`old\n\n${block} extra`, 'first line\nsecond line')).toBe(false);
  });
});

describe('applyOutboxRequest', () => {
  const deps = { appVersion: '9.9.9', today: () => '2026-08-27' };
  it('flag applies through noteFlagChanged and broadcasts', async () => {
    const rc = await applyOutboxRequest(req([{ op: 'flag', targets: T, flag: 'complete', value: true }]) as any, deps);
    expect(rc.results).toEqual([{ provider: 'claude', id: 'c1', op: 'flag', status: 'applied' }]);
    expect(flagCalls).toEqual([['c1', 'complete', true]]);
    expect(broadcasts).toEqual([['c1', { flag: 'complete', value: true }]]);
    expect(metaChanged).toBe(1);
  });
  it('flag reports already when unchanged, and does not write', async () => {
    const rc = await applyOutboxRequest(req([{ op: 'flag', targets: [{ provider: 'claude', id: 'c2' }], flag: 'complete', value: true }]) as any, deps);
    expect(rc.results[0].status).toBe('already'); expect(flagCalls).toEqual([]);
  });
  it('unknown id is not-found and the batch continues', async () => {
    const rc = await applyOutboxRequest(req([{ op: 'flag', targets: [{ provider: 'claude', id: 'zz' }, ...T], flag: 'priority', value: true }]) as any, deps);
    expect(rc.results.map((r) => r.status)).toEqual(['not-found', 'applied']);
  });
  // Finding 5: pins the actual argument passed to noteFlagChanged — a target
  // naming the 'native' provider must pass isNative=true. (The code was
  // already correct; only a stale comment described it wrong. This test just
  // makes sure it stays correct.)
  it('passes isNative=true to noteFlagChanged for a native-provider target', async () => {
    records.set('n1', { note: '', flags: {} });
    const rc = await applyOutboxRequest(req([{ op: 'flag', targets: [{ provider: 'native', id: 'n1' }], flag: 'complete', value: true }]) as any, deps);
    expect(rc.results[0].status).toBe('applied');
    expect(flagNativeArgs).toEqual([true]);
  });
  it('note set replaces; append adds a dated line', async () => {
    await applyOutboxRequest(req([{ op: 'note', targets: T, mode: 'set', text: 'hello' }]) as any, deps);
    await applyOutboxRequest(req([{ op: 'note', targets: [{ provider: 'claude', id: 'c2' }], mode: 'append', text: 'superseded' }]) as any, deps);
    expect(noteCalls).toEqual([['c1', 'hello'], ['c2', 'old\n\n2026-08-27: superseded']]);
    expect(broadcasts[1]).toEqual(['c2', { note: 'old\n\n2026-08-27: superseded' }]);
  });
  it('append past 8000 chars is refused, not truncated', async () => {
    records.set('c1', { note: 'x'.repeat(7990), flags: {} });
    const rc = await applyOutboxRequest(req([{ op: 'note', targets: T, mode: 'append', text: 'y'.repeat(20) }]) as any, deps);
    expect(rc.results[0].status).toBe('refused'); expect(rc.results[0].error).toMatch(/8000/); expect(noteCalls).toEqual([]);
  });
  it('append is idempotent — a line already in the note reports already and writes nothing', async () => {
    records.set('c1', { note: 'old\n\n2026-08-26: superseded', flags: {} });
    const rc = await applyOutboxRequest(req([{ op: 'note', targets: T, mode: 'append', text: 'superseded' }]) as any, deps);
    expect(rc.results[0].status).toBe('already'); expect(noteCalls).toEqual([]);
  });
  // Finding 1: the same regression, but for a multi-line close note — the bug
  // this finding describes as "the common case" (a two-sentence note with a
  // line break). Simulates persistence between the two applies (the mock
  // store doesn't write back on its own) the same way a real retried `close`
  // would see its own prior write on the second attempt.
  it('append is idempotent for multi-line text — applied then already, and writes only once', async () => {
    const text = 'first line\nsecond line';
    const rc1 = await applyOutboxRequest(req([{ op: 'note', targets: T, mode: 'append', text }]) as any, deps);
    expect(rc1.results[0].status).toBe('applied');
    expect(noteCalls).toHaveLength(1);
    records.set('c1', { note: noteCalls[0][1], flags: {} }); // simulate the write landing
    const rc2 = await applyOutboxRequest(req([{ op: 'note', targets: T, mode: 'append', text }]) as any, deps);
    expect(rc2.results[0].status).toBe('already');
    expect(noteCalls).toHaveLength(1); // still just the one write from rc1
  });
  it('no store → every target is an error, never not-found', async () => {
    storeAvailable = false;
    const rc = await applyOutboxRequest(req([{ op: 'flag', targets: T, flag: 'complete', value: true }]) as any, deps);
    expect(rc.results[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/storage is not available/) });
    expect(flagCalls).toEqual([]);
  });
  it('unknown tag is refused with the existing labels; create:true creates once', async () => {
    const r1 = await applyOutboxRequest(req([{ op: 'tag', targets: T, add: ['perms'], remove: [] }]) as any, deps);
    expect(r1.results[0].status).toBe('refused'); expect(r1.results[0].error).toMatch(/unknown tag "perms" — existing tags: sync/);
    expect(tagsChanged).toBe(0); // refused: nothing created, nothing to broadcast
    const r2 = await applyOutboxRequest(req([{ op: 'tag', targets: [{ provider: 'claude', id: 'c1' }, { provider: 'claude', id: 'c2' }], add: ['perms'], remove: [], create: true }]) as any, deps);
    expect(created).toHaveLength(1); expect(r2.createdTags).toEqual([{ id: 'tag_perms', label: 'perms' }]);
    expect(flagCalls).toEqual([['c1', 'tag:tag_perms', true], ['c2', 'tag:tag_perms', true]]);
  });
  // Finding 3: reg.create() bypasses the TAGS_CREATE IPC handler entirely, so
  // the drainer must fire the same tags-changed broadcast itself, and exactly
  // once per REQUEST (two targets tagged here, one tag created).
  it('create:true fires the tags-changed broadcast exactly once per request', async () => {
    const rc = await applyOutboxRequest(req([{ op: 'tag', targets: [{ provider: 'claude', id: 'c1' }, { provider: 'claude', id: 'c2' }], add: ['brandnew'], remove: [], create: true }]) as any, deps);
    expect(rc.createdTags).toEqual([{ id: 'tag_brandnew', label: 'brandnew' }]);
    expect(tagsChanged).toBe(1);
  });
  it('add without create never broadcasts tags-changed', async () => {
    records.set('c1', { note: '', flags: { 'tag:tag_1': { value: false } } });
    const rc = await applyOutboxRequest(req([{ op: 'tag', targets: T, add: ['sync'], remove: [] }]) as any, deps);
    expect(rc.results[0].status).toBe('applied');
    expect(tagsChanged).toBe(0); // existing tag applied, nothing new created
  });
  it('tag matches labels case-insensitively and removes via value:false', async () => {
    records.set('c1', { note: '', flags: { 'tag:tag_1': { value: true } } });
    const rc = await applyOutboxRequest(req([{ op: 'tag', targets: T, add: [], remove: ['SYNC'] }]) as any, deps);
    expect(rc.results[0].status).toBe('applied'); expect(flagCalls).toEqual([['c1', 'tag:tag_1', false]]);
  });
});

describe('drainOutboxOnce', () => {
  const write = (name: string, body: unknown) => {
    const dir = outboxDir(home); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  };
  const opts = () => ({ homeRoot: home, storeRoot: '/store/A', isDevInstance: false, appVersion: '9.9.9', today: () => '2026-08-27' });
  it('applies a request and writes a receipt; processing is emptied', async () => {
    write('11111111-2222-3333-4444-555555555555.json', req([{ op: 'flag', targets: T, flag: 'complete', value: true }]));
    expect(await drainOutboxOnce(opts())).toBe(1);
    const ack = JSON.parse(fs.readFileSync(path.join(outboxDir(home), 'done', '11111111-2222-3333-4444-555555555555.ack.json'), 'utf8'));
    expect(ack.results[0].status).toBe('applied');
    expect(fs.readdirSync(path.join(outboxDir(home), 'processing'))).toEqual([]);
  });
  it('malformed file gets an error receipt', async () => {
    write('22222222-2222-3333-4444-555555555555.json', '{nope');
    await drainOutboxOnce(opts());
    const ack = JSON.parse(fs.readFileSync(path.join(outboxDir(home), 'done', '22222222-2222-3333-4444-555555555555.ack.json'), 'utf8'));
    expect(ack.error).toMatch(/not valid JSON/); expect(ack.results).toEqual([]);
  });
  it('a request for another store is left in outbox untouched', async () => {
    write('33333333-2222-3333-4444-555555555555.json', req([{ op: 'flag', targets: T, flag: 'complete', value: true }], { storeRoot: '/store/B' }));
    expect(await drainOutboxOnce(opts())).toBe(0);
    expect(fs.existsSync(path.join(outboxDir(home), '33333333-2222-3333-4444-555555555555.json'))).toBe(true);
    expect(flagCalls).toEqual([]);
  });
  // Finding 4: the foreign-store message must log once per FILE, not once per
  // poll pass — two passes over the same untouched orphan must produce one log
  // line, or a single stuck orphan floods the trimmed 500-line log within
  // minutes at the 5s poll interval.
  it('a request for another store logs once, not once per pass', async () => {
    write('99999999-2222-3333-4444-555555555555.json', req([{ op: 'flag', targets: T, flag: 'complete', value: true }], { storeRoot: '/store/B' }));
    await drainOutboxOnce(opts());
    await drainOutboxOnce(opts());
    const foreignLogs = logCalls.filter((c) => c[2] === 'request for another store left in place');
    expect(foreignLogs).toHaveLength(1);
  });
  it('a dev instance never drains unless overridden', async () => {
    write('44444444-2222-3333-4444-555555555555.json', req([{ op: 'flag', targets: T, flag: 'complete', value: true }]));
    expect(await drainOutboxOnce({ ...opts(), isDevInstance: true })).toBe(0);
    expect(await drainOutboxOnce({ ...opts(), isDevInstance: true, devOverride: true })).toBe(1);
  });
  it('stale processing entries are recovered', async () => {
    const proc = path.join(outboxDir(home), 'processing'); fs.mkdirSync(proc, { recursive: true });
    const p = path.join(proc, '55555555-2222-3333-4444-555555555555.json');
    fs.writeFileSync(p, JSON.stringify(req([{ op: 'flag', targets: T, flag: 'complete', value: true }])));
    const old = new Date(Date.now() - 11 * 60_000); fs.utimesSync(p, old, old);
    sweepOutbox(home); // the hourly housekeeping pass (audit W9), not the drain itself
    expect(await drainOutboxOnce(opts())).toBe(1);
  });
  // Finding 2: rename() preserves mtime, so a request the CLI wrote 20 minutes
  // ago (queued while the app was closed — a supported case) must NOT read as
  // "claimed 20 minutes ago" the instant it's claimed. Proven by racing two
  // overlapping drainOutboxOnce calls: the first claims the file synchronously
  // (rename happens before any await) then suspends mid-apply; the second
  // starts while the first is still in flight and runs recoverStaleProcessing
  // over the now-claimed file. Before the fix, the claimed file still carries
  // the CLI's old write-time mtime, so the second call's recoverStaleProcessing
  // treats it as abandoned, renames it back to the outbox root, and re-claims
  // + re-applies it — a double apply. After the fix, the claim re-stamps the
  // mtime to "now", so the second call sees a fresh file and leaves it alone.
  it('a request claimed while old (queued while the app was closed) is not re-claimed by an overlapping pass', async () => {
    write('77777777-2222-3333-4444-555555555555.json', req([{ op: 'flag', targets: T, flag: 'complete', value: true }]));
    const src = path.join(outboxDir(home), '77777777-2222-3333-4444-555555555555.json');
    const old = new Date(Date.now() - 20 * 60_000); fs.utimesSync(src, old, old); // CLI wrote it 20 min ago
    const p1 = drainOutboxOnce(opts()); // claims synchronously, then suspends inside applyOutboxRequest
    sweepOutbox(home);                   // a housekeeping pass lands mid-apply — must see the fresh claim stamp
    const p2 = drainOutboxOnce(opts());
    const [h1, h2] = await Promise.all([p1, p2]);
    expect(h1 + h2).toBe(1); // applied exactly once, not twice
    expect(flagCalls).toEqual([['c1', 'complete', true]]);
  });
  it('receipts older than 24h are swept', async () => {
    const done = path.join(outboxDir(home), 'done'); fs.mkdirSync(done, { recursive: true });
    const p = path.join(done, 'old.ack.json'); fs.writeFileSync(p, '{}');
    const old = new Date(Date.now() - 25 * 3600_000); fs.utimesSync(p, old, old);
    sweepOutbox(home);
    expect(fs.existsSync(p)).toBe(false);
  });
  // F1: a request for another store is left alone while it's still plausibly
  // going to be claimed by the instance it belongs to (existing behaviour,
  // covered above) — but must expire if it never will be. Recent mtime case:
  // still just sits there, unchanged from before this fix.
  it('a foreign-store request with a recent mtime is still left alone, no receipt', async () => {
    write('88888888-2222-3333-4444-555555555555.json', req([{ op: 'flag', targets: T, flag: 'complete', value: true }], { storeRoot: '/store/B' }));
    expect(await drainOutboxOnce(opts())).toBe(0);
    expect(fs.existsSync(path.join(outboxDir(home), '88888888-2222-3333-4444-555555555555.json'))).toBe(true);
    expect(fs.existsSync(path.join(outboxDir(home), 'done', '88888888-2222-3333-4444-555555555555.ack.json'))).toBe(false);
  });
  // F1: a foreign-store request older than FOREIGN_STORE_TTL_MS (3 days) can
  // never be claimed by any instance — the CLI already told the user it was
  // "Queued," so it must get an error receipt naming the store it was
  // addressed to (not a guessed cause), and must be removed from the outbox
  // so it doesn't sit there forever.
  it('a foreign-store request past the expiry threshold gets an error receipt naming the foreign root, and is removed', async () => {
    write('aa111111-2222-3333-4444-555555555555.json', req([{ op: 'flag', targets: T, flag: 'complete', value: true }], { storeRoot: '/store/B' }));
    const src = path.join(outboxDir(home), 'aa111111-2222-3333-4444-555555555555.json');
    const old = new Date(Date.now() - 4 * 24 * 3600_000); fs.utimesSync(src, old, old); // 4 days old
    expect(await drainOutboxOnce(opts())).toBe(0); // never applied to THIS store — nothing "handled"
    expect(fs.existsSync(src)).toBe(false); // removed from the outbox
    const ack = JSON.parse(fs.readFileSync(path.join(outboxDir(home), 'done', 'aa111111-2222-3333-4444-555555555555.ack.json'), 'utf8'));
    expect(ack.error).toMatch(/\/store\/B/);
    expect(ack.error).toMatch(/different conversation store/);
    expect(ack.results).toEqual([]);
    expect(flagCalls).toEqual([]); // never applied
  });
  // F6: the CLI's own crash-recovery litter (a tmp file left behind by a kill
  // between writeFile and rename) must eventually be swept too, on the same
  // age rule, with no receipt — there's no request to answer.
  it('a stale CLI tmp file in the outbox root is removed, with no receipt', async () => {
    const dir = outboxDir(home); fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'bb222222-2222-3333-4444-555555555555.json.tmp-12345');
    fs.writeFileSync(tmp, '{"v":1');
    const old = new Date(Date.now() - 4 * 24 * 3600_000); fs.utimesSync(tmp, old, old);
    sweepOutbox(home);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'done', 'bb222222-2222-3333-4444-555555555555.ack.json'))).toBe(false);
  });
  it('a recent CLI tmp file in the outbox root is left alone', async () => {
    const dir = outboxDir(home); fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'cc333333-2222-3333-4444-555555555555.json.tmp-12345');
    fs.writeFileSync(tmp, '{"v":1');
    sweepOutbox(home);
    await drainOutboxOnce(opts());
    expect(fs.existsSync(tmp)).toBe(true);
  });
  it('a file another instance already claimed is skipped, not applied twice', async () => {
    // WHY not two drainers in Promise.all: everything up to the rename claim is
    // synchronous, so the second call would always see an empty folder and the
    // test would pass without exercising the race. Simulate the loser instead.
    write('66666666-2222-3333-4444-555555555555.json', req([{ op: 'flag', targets: T, flag: 'complete', value: true }]));
    const proc = path.join(outboxDir(home), 'processing'); fs.mkdirSync(proc, { recursive: true });
    fs.renameSync(path.join(outboxDir(home), '66666666-2222-3333-4444-555555555555.json'), path.join(proc, '66666666-2222-3333-4444-555555555555.json'));
    expect(await drainOutboxOnce(opts())).toBe(0);
    expect(flagCalls).toEqual([]);
  });
});

// Finding 6: startOutboxDrain/liveOpts/drainSerialized were entirely
// unexercised — nothing proved YOUCODED_PROFILE / YOUCODED_CHATSEARCH_OUTBOX
// are read correctly, and a dev instance wrongly draining the user's REAL
// conversation metadata is the exact failure the gate exists to prevent.
//
// liveOpts()/drainSerialized() resolve homeRoot from os.homedir(), which
// vitest.config.ts redirects for the whole suite to a throwaway sandbox (see
// tests/home-isolation.test.ts) — never the developer's real home — so it's
// safe to let these calls touch the real filesystem here. No other test
// touches <sandbox>/.youcoded/chatsearch/outbox, so there's nothing to
// collide with; cleaned up below regardless.
describe('liveOpts / drainSerialized (dev-instance gate, as actually wired)', () => {
  const origProfile = process.env.YOUCODED_PROFILE;
  const origOverride = process.env.YOUCODED_CHATSEARCH_OUTBOX;
  const sandboxOutbox = outboxDir(os.homedir());

  const restoreEnv = () => {
    if (origProfile === undefined) delete process.env.YOUCODED_PROFILE; else process.env.YOUCODED_PROFILE = origProfile;
    if (origOverride === undefined) delete process.env.YOUCODED_CHATSEARCH_OUTBOX; else process.env.YOUCODED_CHATSEARCH_OUTBOX = origOverride;
  };
  beforeEach(() => { restoreEnv(); fs.rmSync(sandboxOutbox, { recursive: true, force: true }); });
  afterEach(() => { restoreEnv(); fs.rmSync(sandboxOutbox, { recursive: true, force: true }); });

  it('YOUCODED_PROFILE set, override unset -> isDevInstance true, devOverride false', () => {
    process.env.YOUCODED_PROFILE = 'dev-worktree';
    delete process.env.YOUCODED_CHATSEARCH_OUTBOX;
    const o = liveOpts();
    expect(o?.isDevInstance).toBe(true);
    expect(o?.devOverride).toBe(false);
  });

  it('YOUCODED_PROFILE set + YOUCODED_CHATSEARCH_OUTBOX=1 -> devOverride true', () => {
    process.env.YOUCODED_PROFILE = 'dev-worktree';
    process.env.YOUCODED_CHATSEARCH_OUTBOX = '1';
    const o = liveOpts();
    expect(o?.isDevInstance).toBe(true);
    expect(o?.devOverride).toBe(true);
  });

  it('neither set -> isDevInstance false', () => {
    delete process.env.YOUCODED_PROFILE;
    delete process.env.YOUCODED_CHATSEARCH_OUTBOX;
    const o = liveOpts();
    expect(o?.isDevInstance).toBe(false);
  });

  it('drainSerialized re-entrancy: an overlapping call causes exactly one extra pass — no dropped event, no unbounded loop', async () => {
    delete process.env.YOUCODED_PROFILE; // not a dev instance — the request must actually drain
    delete process.env.YOUCODED_CHATSEARCH_OUTBOX;
    fs.mkdirSync(sandboxOutbox, { recursive: true });
    const writeReq = (name: string, id: string, flag: string) => fs.writeFileSync(
      path.join(sandboxOutbox, name),
      JSON.stringify(req([{ op: 'flag', targets: [{ provider: 'claude', id }], flag, value: true }])),
    );
    // c1: 'complete' unset -> will apply. c2: 'complete' already true (outer
    // beforeEach default), so use 'priority' (unset) for it to also apply —
    // otherwise it would report 'already' and never call noteFlagChanged,
    // masking whether the rerun pass ran at all.
    writeReq('aaaaaaaa-2222-3333-4444-555555555555.json', 'c1', 'complete');
    const p1 = drainSerialized(); // claims + starts applying 'aaaaaaaa' synchronously, then suspends
    // Written DURING p1's in-flight pass — only the rerun pass triggered by p2
    // can find this, since p1 already read the (then-empty-of-this-file) dir.
    writeReq('bbbbbbbb-2222-3333-4444-555555555555.json', 'c2', 'priority');
    const p2 = drainSerialized(); // sees a drain already running -> requests one more pass, returns immediately
    await Promise.all([p1, p2]);
    // Both requests applied — 'bbbbbbbb' proves the rerun pass actually ran
    // (it didn't exist yet when p1's pass started); 'aaaaaaaa' isn't
    // re-applied a second time, proving the loop isn't unbounded.
    expect(flagCalls).toEqual([['c1', 'complete', true], ['c2', 'priority', true]]);
    expect(fs.existsSync(path.join(sandboxOutbox, 'done', 'aaaaaaaa-2222-3333-4444-555555555555.ack.json'))).toBe(true);
    expect(fs.existsSync(path.join(sandboxOutbox, 'done', 'bbbbbbbb-2222-3333-4444-555555555555.ack.json'))).toBe(true);
  });
});

// Simplification audit W9: the outbox used to do four directory listings every
// 5 s beside a watcher on the same directory, three of them housekeeping. The
// sweeps now run once at start and hourly; the 5 s poll exists only where the
// watch cannot be trusted (Windows) or could not be attached.
describe('startOutboxDrain timers', () => {
  const sandboxOutbox = outboxDir(os.homedir());
  const realPlatform = process.platform;
  const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
  const origProfile = process.env.YOUCODED_PROFILE;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    delete process.env.YOUCODED_PROFILE; // not a dev instance — requests must actually drain
    fs.rmSync(sandboxOutbox, { recursive: true, force: true });
  });
  afterEach(() => {
    stopOutboxDrain();
    setPlatform(realPlatform);
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (origProfile === undefined) delete process.env.YOUCODED_PROFILE; else process.env.YOUCODED_PROFILE = origProfile;
    fs.rmSync(sandboxOutbox, { recursive: true, force: true });
  });

  const intervals = () => vi.getTimerCount();

  it('off Windows a healthy watch means no 5 s poll: the only interval is the hourly sweep', () => {
    setPlatform('linux');
    startOutboxDrain();
    // fake setTimeout too, so the count is exact: 1 hourly sweep interval, and no
    // store-wait timer because the (mocked) store is already up.
    expect(intervals()).toBe(1);
    stopOutboxDrain();
    expect(intervals()).toBe(0);
  });

  it('on Windows the 5 s poll runs beside the watch', () => {
    setPlatform('win32');
    startOutboxDrain();
    expect(intervals()).toBe(2);
  });

  it('a watch that cannot be attached falls back to the 5 s poll everywhere', () => {
    setPlatform('linux');
    vi.spyOn(fs, 'watch').mockImplementation(() => { throw new Error('EMFILE'); });
    startOutboxDrain();
    expect(intervals()).toBe(2);
  });

  it('sweeps at start and hourly, never on an ordinary drain', async () => {
    setPlatform('linux');
    const done = path.join(sandboxOutbox, 'done'); fs.mkdirSync(done, { recursive: true });
    const stale = (name: string) => {
      const p = path.join(done, name); fs.writeFileSync(p, '{}');
      const old = new Date(Date.now() - 25 * 3600_000); fs.utimesSync(p, old, old);
      return p;
    };
    const first = stale('first.ack.json');
    startOutboxDrain();
    expect(fs.existsSync(first)).toBe(false); // swept at start
    const second = stale('second.ack.json');
    await drainSerialized();
    expect(fs.existsSync(second)).toBe(true);  // a drain no longer sweeps
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fs.existsSync(second)).toBe(false); // the hourly pass did
  });

  it('the hourly tick also drains, so a store that came up after the start-up wait still applies queued requests', async () => {
    setPlatform('linux');
    // A watch that never fires: off Windows nothing else drains, so only the
    // hourly tick can apply what was queued.
    vi.spyOn(fs, 'watch').mockImplementation((() => ({ on() { /* inert */ }, close() { /* inert */ } })) as any);
    fs.mkdirSync(sandboxOutbox, { recursive: true });
    storeAvailable = false;
    startOutboxDrain();
    await vi.advanceTimersByTimeAsync(130_000); // the start-up wait (120 tries) has given up
    storeAvailable = true;
    fs.writeFileSync(
      path.join(sandboxOutbox, 'eeeeeeee-2222-3333-4444-555555555555.json'),
      JSON.stringify(req([{ op: 'flag', targets: T, flag: 'complete', value: true }])),
    );
    // Written while nothing was listening for it: fs.watch may fire, but the
    // hourly tick must apply it even if it did not.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await vi.waitFor(() => expect(flagCalls).toEqual([['c1', 'complete', true]]));
  });

  it('a request queued while the app was closed is applied once the store comes up, without a poll', async () => {
    setPlatform('linux');
    fs.mkdirSync(sandboxOutbox, { recursive: true });
    fs.writeFileSync(
      path.join(sandboxOutbox, 'dddddddd-2222-3333-4444-555555555555.json'),
      JSON.stringify(req([{ op: 'flag', targets: T, flag: 'complete', value: true }])),
    );
    storeAvailable = false; // main.ts starts the drain before the store has finished starting
    startOutboxDrain();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(flagCalls).toEqual([]);
    storeAvailable = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(flagCalls).toEqual([['c1', 'complete', true]]));
  });
});
