// Property tests with a seeded generator (reproducible: a failure names its seed).
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatStore } from './store';
import { initAdapterState, ingest, isRewritten, poll } from './adapter';
import { ccConversation, nativeConversation, cc, native, awkward } from './fixtures';
import { CHAT, V, openWith, refChains, rng, seedsFor, tmpRoot } from './testkit';
import type { RuntimeKind } from './chain';

/** A random but valid sequence of raw lines: every line ends in exactly one 0x0a, content is arbitrary bytes or JSON-ish. */
function randomLines(rand: () => number, n: number, runtime: RuntimeKind = 'claude-code'): Buffer[] {
  const out: Buffer[] = [];
  let msg = 0;
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (runtime === 'native') {
      out.push(r < 0.3 ? native.user('t' + i) : r < 0.5 ? native.text('r' + i) : r < 0.6 ? native.complete() : r < 0.7 ? native.interrupt() : r < 0.8 ? native.toolUse() : r < 0.9 ? native.modelSwitch() : awkward.garbage());
    } else if (r < 0.2) out.push(cc.user('u' + i + ' ' + Math.floor(rand() * 1e9).toString(36)));
    else if (r < 0.35) out.push(cc.block('m' + (msg++), 'end_turn', 'text'));
    else if (r < 0.42) { const id = 'm' + msg++; out.push(cc.block(id, 'end_turn', 'thinking'), cc.block(id, 'end_turn', 'text')); }
    else if (r < 0.5) out.push(cc.block('m' + (msg++), 'tool_use', 'tool_use'), cc.toolResult());
    else if (r < 0.58) out.push(cc.interrupt(rand() < 0.5));
    else if (r < 0.64) out.push(cc.turnDuration());
    else if (r < 0.78) out.push(cc.bookkeeping(['last-prompt', 'cost-state', 'ai-title', 'mode', 'bridge-session'][Math.floor(rand() * 5)]));
    else if (r < 0.84) out.push(awkward.lineSeparators());
    else if (r < 0.9) out.push(awkward.invalidJson());
    else if (r < 0.95) out.push(awkward.empty());
    else { // random bytes with no 0x0a in them
      const len = 1 + Math.floor(rand() * 200); const b = Buffer.alloc(len + 1);
      for (let k = 0; k < len; k++) { let x = Math.floor(rand() * 256); if (x === 0x0a) x = 0x0b; b[k] = x; }
      b[len] = 0x0a; out.push(b);
    }
  }
  return out;
}

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

describe('convergence', () => {
  it('any interleaving, duplication and reordering of appends of the same content reaches the same head and chain', async () => {
    for (const seed of SEEDS) {
      const rand = rng(seed);
      const lines = randomLines(rand, 30 + Math.floor(rand() * 60));
      const ref = refChains(lines);
      // cut the source into random, overlapping pieces that cover it, duplicate some, shuffle everything
      const pieces: { from: number; lines: Buffer[] }[] = [];
      for (let at = 0; at < lines.length;) {
        const len = 1 + Math.floor(rand() * 12);
        const back = at > 0 && rand() < 0.4 ? Math.floor(rand() * Math.min(at, 5)) : 0; // overlap with earlier lines
        pieces.push({ from: at - back, lines: lines.slice(at - back, at + len) });
        at += len;
      }
      const all = [...pieces, ...pieces.filter(() => rand() < 0.5)];
      for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
      const t = await tmpRoot();
      try {
        const s = await openWith(t.dir, V(1), { chunkBytes: 400 + Math.floor(rand() * 4000) });
        // some calls are issued concurrently: the store must serialise them
        for (let i = 0; i < all.length;) {
          const burst = rand() < 0.3 ? 1 + Math.floor(rand() * 4) : 1;
          const results = await Promise.all(all.slice(i, i + burst).map((p) => s.append(V(1), 0, p.from, p.lines)));
          for (const r of results) expect(['ok', 'parked'], `seed ${seed}`).toContain(r);
          i += burst;
        }
        const head = await s.head(V(1));
        expect(head.lines, `seed ${seed}`).toBe(lines.length);
        expect(head.hash, `seed ${seed}`).toBe(ref.raw[lines.length]);
        expect(head.conversationHash, `seed ${seed}`).toBe(ref.conv);
        expect(head.conversationLines).toBe(ref.convLines);
        expect(Buffer.concat(await s.read(V(1), 0, 0, lines.length) as Buffer[]).equals(Buffer.concat(lines))).toBe(true);
        expect((await s.verify(V(1))).ok).toBe(true);
        expect(fs.existsSync(path.join(t.dir, 'versions', V(1).toString('hex'), 'rejected'))).toBe(false);
        // two independent stores fed the same lines in different shapes have identical chains and reply-end indexes
        const t2 = await tmpRoot();
        try {
          const s2 = await openWith(t2.dir, V(2));
          await s2.append(V(2), 0, 0, lines);
          const h2 = await s2.head(V(2));
          expect(h2).toEqual(head);
          expect(await s2.replyEnds(V(2))).toEqual(await s.replyEnds(V(1)));
        } finally { await t2.cleanup(); }
        await s.close();
      } finally { await t.cleanup(); }
    }
  }, 120_000);

  it('native chats converge the same way', async () => {
    for (const seed of [101, 102, 103]) {
      const rand = rng(seed);
      const lines = randomLines(rand, 50, 'native');
      const t = await tmpRoot();
      try {
        const s = await openWith(t.dir, V(5), { chunkBytes: 500 }, 'native', CHAT);
        const idx = lines.map((_, i) => i).sort(() => rand() - 0.5);
        for (const i of idx) await s.append(V(5), 0, i, [lines[i]]); // every line alone, in random order
        const ref = refChains(lines, 'native');
        const head = await s.head(V(5));
        expect(head.hash).toBe(ref.raw[lines.length]); expect(head.conversationHash).toBe(ref.conv);
        await s.close();
      } finally { await t.cleanup(); }
    }
  });
});

describe('not-a-prefix exactly when bytes differ', () => {
  it('random overlapping appends: equal bytes -> ok, any differing overlapped byte -> not-a-prefix and nothing changes', async () => {
    let differ = 0; let same = 0;
    for (const seed of SEEDS) {
      const rand = rng(1000 + seed);
      const lines = randomLines(rand, 40);
      const t = await tmpRoot();
      try {
        const s = await openWith(t.dir);
        const stored = 20 + Math.floor(rand() * 15);
        await s.append(V(1), 0, 0, lines.slice(0, stored));
        const before = await s.head(V(1));
        for (let trial = 0; trial < 25; trial++) {
          const from = Math.floor(rand() * (before.lines + 1));
          const len = 1 + Math.floor(rand() * 10);
          const piece = lines.slice(from, from + len).map((b) => Buffer.from(b));
          if (piece.length === 0) continue;
          let mutatedInOverlap = false;
          if (rand() < 0.5) {
            const k = Math.floor(rand() * piece.length);
            const pos = Math.floor(rand() * (piece[k].length - 1)); // never the final newline
            if (piece[k].length > 1) piece[k][pos] = (piece[k][pos] ^ (1 + Math.floor(rand() * 255))) & 0xff;
            if (piece[k][pos] === 0x0a || piece[k].length === 1) { piece[k] = Buffer.from(lines[from + k]); } // keep it a valid single line or revert
            else mutatedInOverlap = !piece[k].equals(lines[from + k]) && from + k < before.lines; // a mutated line past the head just extends the chain
          }
          const exact = piece.every((b, i) => b.equals(lines[from + i]));
          const res = await s.append(V(1), 0, from, piece);
          if (exact) { expect(res, `seed ${seed}`).toBe('ok'); same++; }
          else if (mutatedInOverlap) { expect(res, `seed ${seed}`).toBe('not-a-prefix'); differ++; expect(await s.head(V(1))).toEqual(before); }
          // a mutated line beyond the head with all earlier lines equal extends the store (a new, different continuation): not asserted here
          if (res === 'ok') { // restore the reference state for the next trial
            const h = await s.head(V(1));
            if (h.lines !== before.lines) { await s.setAsideTail('ee'.repeat(8) + trial.toString(16).padStart(8, '0') + seed.toString(16).padStart(4, '0'), V(1), before.lines); }
            expect((await s.head(V(1))).hash).toBe(before.hash);
          }
        }
        await s.close();
      } finally { await t.cleanup(); }
    }
    expect(differ).toBeGreaterThan(50); expect(same).toBeGreaterThan(50);
  }, 120_000);
});

describe('adapter + store round trip is byte for byte', () => {
  const awkwardSet = (): Buffer[] => [awkward.lineSeparators(), awkward.invalidJson(), awkward.garbage(), awkward.spaced(), awkward.empty(), cc.user('after the malformed ones')];
  const fixtures: { name: string; runtime: RuntimeKind; lines: Buffer[]; torn?: Buffer }[] = [
    { name: 'claude-code conversation', runtime: 'claude-code', lines: ccConversation().lines },
    { name: 'claude-code malformed lines', runtime: 'claude-code', lines: awkwardSet() },
    { name: 'claude-code with a torn last line', runtime: 'claude-code', lines: ccConversation().lines, torn: Buffer.from('{"type":"user","message":{"content":"half a li') },
    { name: 'native conversation', runtime: 'native', lines: nativeConversation().lines },
    { name: 'native malformed', runtime: 'native', lines: [native.header(), awkward.garbage(), native.user(), awkward.lineSeparators(), native.complete()] },
    { name: 'a 5 MB line among small ones', runtime: 'claude-code', lines: [cc.user('a'), Buffer.from(JSON.stringify({ type: 'user', message: { content: 'q'.repeat(5_000_000) } }) + '\n'), cc.user('b')] },
    ...SEEDS.slice(0, 15).map((seed) => ({ name: `random seed ${seed}`, runtime: 'claude-code' as RuntimeKind, lines: randomLines(rng(500 + seed), 80) })),
  ];
  for (const f of fixtures) {
    it(f.name, async () => {
      const t = await tmpRoot();
      try {
        const file = path.join(t.dir, 'source.jsonl');
        const source = Buffer.concat([...f.lines, ...(f.torn ? [f.torn] : [])]);
        fs.writeFileSync(file, source);
        const seeds = seedsFor();
        const s = await openWith(path.join(t.dir, 'store'), V(1), { chunkBytes: 1 << 20 }, f.runtime);
        let state = initAdapterState(seeds); let n = 0; let ends: number[] = []; let torn = 0;
        const g = ingest(file, state, { runtime: f.runtime, seeds, maxBatchBytes: 64 * 1024 });
        for (;;) {
          const x = await g.next();
          if (x.done) { expect(x.value).toBeNull(); break; }
          expect(await s.append(V(1), 0, n, x.value.lines)).toBe('ok');
          n += x.value.lines.length; state = x.value.state; ends = ends.concat(x.value.replyEnds);
        }
        const last = await poll(file, state, { runtime: f.runtime, seeds });
        if (isRewritten(last)) throw new Error('unexpected rewrite');
        torn = last.tornBytes;
        expect(torn).toBe(f.torn ? f.torn.length : 0);
        expect(n).toBe(f.lines.length);
        // the store reproduces the file's whole lines byte for byte (the torn tail is not a line yet)
        const back = Buffer.concat(await s.read(V(1), 0, 0, n) as Buffer[]);
        expect(createHash('sha256').update(back).digest('hex')).toBe(createHash('sha256').update(Buffer.concat(f.lines)).digest('hex'));
        // and the adapter's chains, reply ends and the store's agree
        const head = await s.head(V(1));
        expect(head.hash).toBe(state.chain); expect(head.conversationHash).toBe(state.conv); expect(head.conversationLines).toBe(state.convLines);
        expect((await s.replyEnds(V(1))).confirmed).toEqual(ends);
        expect((await s.replyEnds(V(1))).pending).toBe(state.rs.cand ? state.rs.cand.n : null);
        // when the torn line's newline arrives it becomes line n and the chain continues
        if (f.torn) {
          fs.appendFileSync(file, Buffer.from('f"}}\n'));
          const more = await poll(file, state, { runtime: f.runtime, seeds });
          if (isRewritten(more)) throw new Error('unexpected rewrite');
          expect(more.lines.length).toBe(1);
          expect(await s.append(V(1), 0, n, more.lines)).toBe('ok');
          expect((await s.head(V(1))).hash).toBe(more.state.chain);
        }
        expect((await s.verify(V(1))).ok).toBe(true);
        await s.close();
      } finally { await t.cleanup(); }
    });
  }
});
