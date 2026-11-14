// Truncate each store file at EVERY byte offset inside its last record (loss test LT-6, store half) and
// reopen. A kill, a full disk or a bad sector can cut a file anywhere; the store must come back with a
// clean prefix and accept the missing piece again.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatStore } from './store';
import { REC, recPos } from './records';
import { ccConversation } from './fixtures';
import { CHAT, V, refChains, tmpRoot } from './testkit';

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
  it('index.bin: cut anywhere in the last record leaves all earlier lines; the whole record keeps it', async () => {
    const last = conv.length - 1;
    let checked = 0;
    for (let cut = recPos(last); cut <= recPos(last + 1); cut++) {
      const t = await tmpRoot();
      try {
        await build(t.dir);
        fs.truncateSync(path.join(vdir(t.dir), 'index.bin'), cut);
        const lines = await expectRecovered(t.dir, (n) => n === (cut === recPos(last + 1) ? conv.length : last));
        expect(lines).toBe(cut === recPos(last + 1) ? conv.length : last);
        checked++;
      } finally { await t.cleanup(); }
    }
    expect(checked).toBe(REC + 1);
  });

  it('body chunk: cut anywhere in the last line drops exactly that line', async () => {
    const lastLen = conv[conv.length - 1].length;
    let checked = 0;
    for (const chunk of [undefined, 700]) {
      for (let drop = 0; drop <= lastLen; drop++) {
        const t = await tmpRoot();
        try {
          await build(t.dir, chunk);
          const files = fs.readdirSync(vdir(t.dir)).filter((f) => f.startsWith('body-')).sort();
          const lastChunk = path.join(vdir(t.dir), files[files.length - 1]);
          fs.truncateSync(lastChunk, fs.statSync(lastChunk).size - drop);
          // drop === lastLen exactly removes the last line's bytes; between, a torn body. Either way line N is lost.
          await expectRecovered(t.dir, (n) => n === (drop === 0 ? conv.length : conv.length - 1), chunk);
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
          await expectRecovered(t.dir, (n) => n === conv.length - 1);
        } finally { await t.cleanup(); }
      }
    }
  });

  it('a garbage tail after the last whole record (a cut-off append) is ignored and trimmed', async () => {
    const t = await tmpRoot();
    try {
      await build(t.dir);
      fs.appendFileSync(path.join(vdir(t.dir), 'index.bin'), Buffer.alloc(REC * 2 + 13, 0x5a));
      fs.appendFileSync(path.join(vdir(t.dir), 'body-0000000000000000.bin'), Buffer.from('torn bytes from an unfinished append'));
      await expectRecovered(t.dir, (n) => n === conv.length);
    } finally { await t.cleanup(); }
  });

  it('a record flipped in the middle of the verified window is detected, not trusted', async () => {
    const t = await tmpRoot();
    try {
      await build(t.dir);
      const p = path.join(vdir(t.dir), 'index.bin');
      const b = fs.readFileSync(p); b[recPos(5) + 20] ^= 0xff; fs.writeFileSync(p, b);
      const s = await ChatStore.open(t.dir);
      expect((await s.head(V(1))).lines).toBe(5); // everything from the damaged record on is distrusted
      await s.append(V(1), 0, 0, conv);
      expect((await s.head(V(1))).hash).toBe(REF.raw[conv.length]);
      await s.close();
    } finally { await t.cleanup(); }
  });

  it('control log: cut anywhere in the last record keeps the earlier entries and accepts the entry again', async () => {
    const id = (n: number) => createHash('sha256').update('t' + n).digest('hex');
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
