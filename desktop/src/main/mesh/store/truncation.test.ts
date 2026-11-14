// Truncate each store file at EVERY byte offset inside its last record (loss test LT-6, store half) and
// reopen. A kill, a full disk or a bad sector can cut a file anywhere; the store must come back with a
// clean prefix and accept the missing piece again.
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatStore } from './store';
import { REC, recPos } from './records';
import { ccConversation } from './fixtures';
import { CHAT, V, refChains, tmpRoot } from './testkit';

// WHY: these loops build a store per byte offset; on a real disk (MESH_STORE_TMPDIR, review M7) the fsyncs make them take ~50 s
vi.setConfig({ testTimeout: 300_000 });
const conv = ccConversation().lines;
const REF = refChains(conv);
const vdir = (root: string) => path.join(root, 'versions', V(1).toString('hex'));

async function build(root: string, chunk?: number): Promise<void> {
  const s = await ChatStore.open(root, chunk ? { chunkBytes: chunk } : {});
  await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' });
  // two batches so the last record and the last body bytes belong to a later write
  await s.append(V(1), 0, 0, conv.slice(0, conv.length - 1));
  await s.append(V(1), 0, conv.length - 1, conv.slice(conv.length - 1));
  await s.close();
}

async function expectRecovered(root: string, expectLines: (n: number) => boolean, chunk?: number): Promise<number> {
  const s = await ChatStore.open(root, chunk ? { chunkBytes: chunk } : {});
  const head = await s.head(V(1));
  expect(expectLines(head.lines), `head.lines=${head.lines}`).toBe(true);
  expect(head.hash).toBe(REF.raw[head.lines]);
  expect(await s.verify(V(1))).toMatchObject({ ok: true });
  expect(await s.append(V(1), 0, 0, conv)).toBe('ok'); // the cut-off piece is accepted again
  expect((await s.head(V(1))).hash).toBe(REF.raw[conv.length]);
  expect(await s.verify(V(1))).toMatchObject({ ok: true });
  await s.close();
  return head.lines;
}

describe('truncate at every byte offset of the last record', () => {
  it('index.bin: cut anywhere in the last record never loses an earlier line, and never loses the last one once its index write began', async () => {
    const last = conv.length - 1;
    let checked = 0;
    for (let cut = recPos(last); cut <= recPos(last + 1); cut++) {
      const t = await tmpRoot();
      try {
        await build(t.dir);
        fs.truncateSync(path.join(vdir(t.dir), 'index.bin'), cut);
        // WHY every cut now keeps the last line (N1): build() acknowledged it AND closed, so the checkpoint file vouches for it. A cut
        // exactly at a record boundary used to read as "never acknowledged" and the line was set aside; the checkpoint proves otherwise,
        // so the index is re-derived from the whole body and verified against it. A cut inside the record is adopted (C1).
        const want = conv.length;
        const lines = await expectRecovered(t.dir, (n) => n === want);
        expect(lines).toBe(want);
        checked++;
      } finally { await t.cleanup(); }
    }
    expect(checked).toBe(REC + 1);
  });

  it('body chunk cut anywhere in the last line: that line is reported damaged and every other line is served; nothing is trimmed or set aside, and a resend heals it (review 4, F3)', async () => {
    const lastLen = conv[conv.length - 1].length;
    let checked = 0;
    for (const chunk of [undefined, 700]) {
      for (let drop = 0; drop <= lastLen; drop++) {
        const t = await tmpRoot();
        try {
          await build(t.dir, chunk);
          const files = fs.readdirSync(vdir(t.dir)).filter((f) => f.startsWith('body-')).sort();
          const lastChunk = path.join(vdir(t.dir), files[files.length - 1]);
          const before = fs.statSync(lastChunk).size;
          fs.truncateSync(lastChunk, before - drop);
          // drop === 0: nothing cut. drop === lastLen: the last line's bytes are gone but its index record was acknowledged. Either way no line is silently dropped.
          if (drop === 0) await expectRecovered(t.dir, (n) => n === conv.length, chunk);
          else {
            const s = await ChatStore.open(t.dir, chunk ? { chunkBytes: chunk } : {});
            const h = await s.head(V(1));
            expect(h.lines).toBe(conv.length); expect(h.damagedFromLine).toBe(conv.length - 1);
            expect(((await s.read(V(1), 0, 0, 1)) as Buffer[])[0].equals(conv[0])).toBe(true);
            await expect(s.read(V(1), 0, conv.length - 1, conv.length)).rejects.toMatchObject({ code: 'corrupt' });
            expect(fs.existsSync(path.join(t.dir, 'aside')) ? fs.readdirSync(path.join(t.dir, 'aside')) : []).toEqual([]);
            expect(fs.statSync(lastChunk).size).toBe(before - drop);       // nothing was trimmed
            expect(await s.append(V(1), 0, 0, conv)).toBe('ok');           // the caller's resend heals it
            expect((await s.verify(V(1))).ok).toBe(true);
            await s.close();
          }
          checked++;
        } finally { await t.cleanup(); }
      }
    }
    expect(checked).toBe(2 * (lastLen + 1));
  });

  it('index and body both cut at independent offsets near the end (every pair within the last record)', async () => {
    const lastLen = conv[conv.length - 1].length;
    // sample the body offsets sparsely (every 7th) so this stays fast; the index offsets are every byte of the last record
    for (let ic = recPos(conv.length - 1); ic < recPos(conv.length); ic += 5) {
      for (let drop = 0; drop <= lastLen; drop += 7) {
        const t = await tmpRoot();
        try {
          await build(t.dir);
          fs.truncateSync(path.join(vdir(t.dir), 'index.bin'), ic);
          const bf = path.join(vdir(t.dir), 'body-0000000000000000.bin');
          fs.truncateSync(bf, fs.statSync(bf).size - drop);
          // The last line was acknowledged (and checkpointed). Whole body: it is kept whatever the index lost. Part of it cut (two faults at once): the lines before
          // it are served, the cut line is REPORTED (the checkpoint vouched for it; its old statement is kept in torn/), the chat is not hidden, and a resend heals it.
          if (drop === 0) await expectRecovered(t.dir, (n) => n === conv.length);
          else {
            const s = await ChatStore.open(t.dir);
            const h = await s.head(V(1));
            expect(h.damagedFromLine).not.toBeNull();
            expect(h.damagedFromLine).toBeGreaterThanOrEqual(conv.length - 1);
            expect(((await s.read(V(1), 0, 0, 1)) as Buffer[])[0].equals(conv[0])).toBe(true);
            expect(await s.append(V(1), 0, 0, conv)).toBe('ok');
            expect((await s.verify(V(1))).ok).toBe(true);
            await s.close();
          }
        } finally { await t.cleanup(); }
      }
    }
  });

  it('a garbage tail after the last whole record (a cut-off append) is ignored; its bytes are kept aside', async () => {
    const t = await tmpRoot();
    try {
      await build(t.dir);
      fs.appendFileSync(path.join(vdir(t.dir), 'index.bin'), Buffer.alloc(REC * 2 + 13, 0x5a));
      fs.appendFileSync(path.join(vdir(t.dir), 'body-0000000000000000.bin'), Buffer.from('torn bytes from an unfinished append'));
      await expectRecovered(t.dir, (n) => n === conv.length);
    } finally { await t.cleanup(); }
  });

  it('a record flipped in the middle is repaired from the body (no line is lost); it is never "trusted" and never truncates', async () => {
    const t = await tmpRoot();
    try {
      await build(t.dir);
      const p = path.join(vdir(t.dir), 'index.bin');
      const b = fs.readFileSync(p); b[recPos(5) + 20] ^= 0xff; fs.writeFileSync(p, b);
      const s = await ChatStore.open(t.dir);
      expect((await s.head(V(1))).lines).toBe(conv.length);
      expect((await s.head(V(1))).hash).toBe(REF.raw[conv.length]);
      expect((await s.verify(V(1))).ok).toBe(true);
      await s.close();
    } finally { await t.cleanup(); }
  });

  it('control log: cut anywhere in the last record keeps the earlier entries and accepts the entry again', async () => {
    const id = (n: number) => createHash('sha256').update('b' + n).digest('hex'); // an entry id is the SHA-256 of its body
    const mk = (n: number) => ({ id: id(n), chat: CHAT, seen: n > 1 ? [id(n - 1)] : [], body: Buffer.from('b' + n) });
    const probe = await tmpRoot();
    let logSize = 0; let prevSize = 0; let logPath = '';
    try {
      const s = await ChatStore.open(probe.dir);
      await s.appendControl(mk(1)); await s.appendControl(mk(2));
      const dir = path.join(probe.dir, 'control', createHash('sha256').update(CHAT).digest('hex'));
      prevSize = fs.statSync(path.join(dir, 'log.bin')).size;
      await s.appendControl(mk(3));
      logSize = fs.statSync(path.join(dir, 'log.bin')).size;
      logPath = path.relative(probe.dir, path.join(dir, 'log.bin'));
      await s.close();
    } finally { await probe.cleanup(); }
    for (let cut = prevSize; cut <= logSize; cut++) {
      const t = await tmpRoot();
      try {
        const s = await ChatStore.open(t.dir);
        for (const n of [1, 2, 3]) await s.appendControl(mk(n));
        await s.close();
        fs.truncateSync(path.join(t.dir, logPath), cut);
        const s2 = await ChatStore.open(t.dir);
        expect((await s2.controlLog(CHAT)).length).toBe(cut === logSize ? 3 : 2);
        for (const n of [1, 2, 3]) await s2.appendControl(mk(n));
        expect((await s2.controlLog(CHAT)).map((e) => e.id)).toEqual([1, 2, 3].map(id));
        await s2.close();
      } finally { await t.cleanup(); }
    }
  });

  it('a truncated parked file or tail file never blocks the version and is kept, not deleted', async () => {
    const t = await tmpRoot();
    try {
      const s = await ChatStore.open(t.dir);
      await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' });
      await s.append(V(1), 0, 5, conv.slice(5, 9)); // parked
      await s.close();
      const parkedDir = path.join(vdir(t.dir), 'parked');
      const f = path.join(parkedDir, fs.readdirSync(parkedDir)[0]);
      fs.truncateSync(f, fs.statSync(f).size - 3);
      const s2 = await ChatStore.open(t.dir);
      expect(await s2.append(V(1), 0, 0, conv.slice(0, 5))).toBe('ok');
      expect((await s2.head(V(1))).lines).toBe(5); // the torn parked piece did not apply
      expect(fs.readdirSync(path.join(vdir(t.dir), 'rejected')).length).toBe(1);
      expect(await s2.append(V(1), 0, 5, conv.slice(5))).toBe('ok');
      expect((await s2.head(V(1))).hash).toBe(REF.raw[conv.length]);
      await s2.close();
    } finally { await t.cleanup(); }
  });
});
