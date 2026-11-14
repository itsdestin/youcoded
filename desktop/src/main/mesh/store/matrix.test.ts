// The class check, deterministic: EVERY file the store wrote into a rich folder, hit with EACH of the five wrong-file faults of inventory.ts
// (rotted, an older copy of itself, a foreign copy from another chat, missing, cut at a clean boundary), one fault at a time, on a copy of the folder.
// For each (file, fault) the store is reopened and the same promises are checked: no untyped error; no wrong byte ever served; every line whose bytes
// are still on disk is served; every line that is not served is REPORTED (head.damagedFromLine / a typed read error), never silently fewer; a lost
// control entry, extra or set-aside tail is reported; the other chat is untouched. The only allowed losses are the documented limits (inventory.ts).
// Synthetic data, temp folders only. This is what `fuzz.test.ts` samples at random; here nothing is left to chance.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatStore } from './store';
import { V, tmpRoot } from './testkit';
import { nl } from './fixtures';
import { inventoryRow } from './inventory';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const CHAT_A = 'matrix:chat-a'; const CHAT_B = 'matrix:chat-b';
const mk = (tag: string, n: number): Buffer[] => Array.from({ length: n }, (_, i) => nl({ type: i % 2 ? 'assistant' : 'user', uuid: `${tag}-${i}`, message: { role: i % 2 ? 'assistant' : 'user', id: `${tag}m${i >> 1}`, stop_reason: i % 2 ? 'end_turn' : null, content: `${tag} ${i} ${'y'.repeat(60 + (i % 7) * 9)}` } }));
const A = mk('a', 48); const B = mk('b', 14);
const vkey = (n: number) => V(n).toString('hex');
const opts = { chunkBytes: 1000, proofVerifier: () => true };
const ctl = (chat: string, i: number) => { const body = Buffer.from(`ctl-${chat}-${i}-${'c'.repeat(24)}`); return { id: sha(body), chat, seen: [] as string[], body }; };
const extraBytes = [Buffer.from('extra-one-' + 'e'.repeat(50)), Buffer.from('extra-two-' + 'f'.repeat(50))];

function walk(d: string, out: string[] = []): string[] { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; }
const snap = (root: string): Map<string, Buffer> => { const m = new Map<string, Buffer>(); for (const p of walk(root)) { const rel = path.relative(root, p); if (!/^LOCK/.test(rel)) m.set(rel, fs.readFileSync(p)); } return m; };

/** Builds a folder that has seen most operations; returns the folder, a snapshot taken half way (the source of "older" copies) and what to expect. */
async function build(root: string, evict: boolean): Promise<{ older: Map<string, Buffer> }> {
  const s = await ChatStore.open(root, opts);
  await s.registerVersion(V(1), { chatId: CHAT_A, runtime: 'claude-code' });
  await s.registerVersion(V(2), { chatId: CHAT_B, runtime: 'claude-code' });
  for (let i = 0; i < 24; i += 8) await s.append(V(1), 0, i, A.slice(i, i + 8));
  await s.append(V(2), 0, 0, B.slice(0, 6));
  await s.appendControl(ctl(CHAT_A, 0)); await s.appendControl(ctl(CHAT_B, 0)); await s.putExtra(sha(extraBytes[0]), extraBytes[0]);
  await s.close();
  const older = snap(root);                                       // the half-way state
  const s2 = await ChatStore.open(root, opts);
  await s2.registerVersion(V(1), { chatId: CHAT_A, runtime: 'claude-code' }); await s2.registerVersion(V(2), { chatId: CHAT_B, runtime: 'claude-code' });
  for (let i = 24; i < 48; i += 8) await s2.append(V(1), 0, i, A.slice(i, i + 8));
  await s2.append(V(1), 0, 52, A.slice(40, 44)).catch(() => undefined);           // a park (gap)
  await s2.append(V(2), 0, 6, B.slice(6, 14));
  await s2.appendControl(ctl(CHAT_A, 1)); await s2.appendControl(ctl(CHAT_A, 2)); await s2.appendControl(ctl(CHAT_B, 1)); await s2.putExtra(sha(extraBytes[1]), extraBytes[1]);
  await s2.setAsideTail('abcdef012345', V(2), 12); await s2.append(V(2), 0, 12, B.slice(12, 14));   // a tail, then the lines re-appended
  // a healed line: rot one body byte, resend
  const body0 = path.join(root, 'versions', vkey(1), 'body-0000000000000000.bin'); const b = fs.readFileSync(body0); b[30] ^= 0x40; fs.writeFileSync(body0, b);
  await s2.append(V(1), 0, 0, A.slice(0, 3));
  if (evict) { const h = (await s2.hashAt(V(1), 0, 12))!; await s2.evictBody(V(1), { kind: 'holders-confirmed', version: vkey(1), through: 12, hash: h, acks: [{ holder: 'p', version: vkey(1), lines: 12, hash: h, signature: 's' }] } as any); }
  await s2.close();
  // a rebuild (replaced-index/), and a third version set aside (aside/ with COMPLETE)
  const ix = path.join(root, 'versions', vkey(2), 'index.bin'); const ib = fs.readFileSync(ix); ib[36 + 116 * 3 + 5] ^= 1; fs.writeFileSync(ix, ib);
  const s3 = await ChatStore.open(root, opts);
  await s3.registerVersion(V(3), { chatId: 'matrix:chat-c', runtime: 'claude-code' }); await s3.append(V(3), 0, 0, mk('c', 4)); await s3.setAsideDamaged(V(3)); await s3.append(V(3), 0, 0, mk('c', 4));
  await s3.registerVersion(V(1), { chatId: CHAT_A, runtime: 'claude-code' }); await s3.registerVersion(V(2), { chatId: CHAT_B, runtime: 'claude-code' });
  await s3.head(V(2));
  await s3.close();
  return { older };
}

type Fault = 'rotted' | 'older' | 'foreign' | 'missing' | 'truncated';
const FAULTS: Fault[] = ['rotted', 'older', 'foreign', 'missing', 'truncated'];

function boundaries(rel: string, b: Buffer): number[] {
  const out: number[] = [];
  if (/index\.bin$|replaced-index\//.test(rel)) { for (let o = 36; o < b.length; o += 116) out.push(o); }
  else if (/checkpoint\.bin$/.test(rel)) { for (let o = 128; o < b.length; o += 128) out.push(o); }
  else if (/log\.bin$/.test(rel)) { let o = 0; while (o + 16 <= b.length) { out.push(o); o += 16 + b.readUInt32BE(o + 4); } }
  else if (/manifest\.bin$/.test(rel)) { for (let o = 37; o < b.length; o += 37) out.push(o); }
  else { for (let i = b.indexOf(0x0a); i !== -1; i = b.indexOf(0x0a, i + 1)) out.push(i + 1); out.push(Math.floor(b.length / 2)); }
  return out.filter((o) => o < b.length);
}

/** The same file of another chat, or null. */
function donor(root: string, rel: string): string | null {
  const swap = (a: string, b: string): string | null => (rel.includes(a) && fs.existsSync(path.join(root, rel.replace(a, b))) ? path.join(root, rel.replace(a, b)) : null);
  const v = swap(`versions/${vkey(1)}/`, `versions/${vkey(2)}/`) ?? swap(`versions/${vkey(2)}/`, `versions/${vkey(1)}/`);
  if (v) return v;
  const c = /^control\/([0-9a-f]{64})\//.exec(rel);
  if (c) { for (const o of fs.readdirSync(path.join(root, 'control'))) if (o !== c[1] && fs.existsSync(path.join(root, rel.replace(c[1], o)))) return path.join(root, rel.replace(c[1], o)); return null; }
  if (/^extras\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(rel)) { for (const p of walk(path.join(root, 'extras'))) { const r = path.relative(root, p); if (r !== rel && /^extras\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(r)) return p; } }
  return null;
}

async function applyFault(root: string, rel: string, kind: Fault, older: Map<string, Buffer>): Promise<boolean> {
  const f = path.join(root, rel); const b = fs.readFileSync(f);
  if (kind === 'rotted') { if (!b.length) return false; b[Math.floor(b.length / 2)] ^= 0x10; fs.writeFileSync(f, b); return true; }
  if (kind === 'missing') { fs.unlinkSync(f); return true; }
  if (kind === 'truncated') { const bs = boundaries(rel, b); if (!bs.length) return false; fs.truncateSync(f, bs[Math.floor(bs.length / 2)]); return true; }
  if (kind === 'older') { const o = older.get(rel); if (o === undefined || o.equals(b)) return false; fs.writeFileSync(f, o); return true; }
  const d = donor(root, rel); if (!d || fs.readFileSync(d).equals(b)) return false; fs.copyFileSync(d, f); return true;
}

/** One char per line of A: '.' served identical, 'E' evicted, '!' typed corrupt, 'X' WRONG BYTES, '?' untyped error. */
async function readAll(s: ChatStore, lines: Buffer[], v: Buffer): Promise<string> {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) { try { const r = await s.read(v, 0, i, i + 1); out.push(r === 'evicted' ? 'E' : r[0].equals(lines[i]) ? '.' : 'X'); } catch (e: any) { out.push(e?.code === 'corrupt' ? '!' : '?'); } }
  return out.join('');
}

/** Files whose loss destroys the only copy of some bytes (inventory.ts limit 1): lines in them may be reported damaged. */
const ONLY_COPY = /(^|\/)(body-[0-9a-f]{16}\.bin|tails\/|parked\/|rejected\/|extras-bad\/|healed\/|torn\/)/;

describe.each([['without eviction', false], ['after an eviction', true]] as const)('every file x every wrong-file fault (%s)', (_name, evict) => {
  it('is served or reported, never silently fewer, never wrong', async () => {
    const t = await tmpRoot('matrix-'); const golden = path.join(t.dir, 'golden');
    fs.mkdirSync(golden);
    const { older } = await build(golden, evict);
    const files = walk(golden).map((p) => path.relative(golden, p)).filter((r) => !/^LOCK/.test(r));
    // every file the scenario wrote is in the inventory (and the scenario reached the interesting ones)
    for (const f of files) expect(inventoryRow(f), f).not.toBeNull();
    for (const must of ['checkpoint.bin', 'index.bin', 'meta.json', 'meta.copy', 'summary.json', 'control/', 'anchor.json', 'anchor.copy', 'extras/manifest.bin', 'tails/', 'healed/', 'replaced-index/', 'aside/', 'COMPLETE', 'parked/']) expect(files.some((f) => f.includes(must)), `scenario lacks ${must}`).toBe(true);
    let runs = 0; const problems: string[] = [];
    let n = 0;
    for (const rel of files) {
      for (const kind of FAULTS) {
        const work = path.join(t.dir, `w${n++}`);
        fs.cpSync(golden, work, { recursive: true });
        if (!(await applyFault(work, rel, kind, older))) { fs.rmSync(work, { recursive: true, force: true }); continue; }
        runs++;
        const where = `${kind} ${rel}`;
        const onlyCopy = ONLY_COPY.test(rel) && kind !== 'older' ? true : ONLY_COPY.test(rel);
        const inA = rel.includes(`versions/${vkey(1)}/`); const inB = rel.includes(`versions/${vkey(2)}/`);
        const indexAfterEviction = evict && /index\.bin$|replaced-index\//.test(rel) && inA;   // inventory.ts limit 2
        let s: ChatStore | null = null;
        try {
          s = await ChatStore.open(work, opts);
          await s.registerVersion(V(1), { chatId: CHAT_A, runtime: 'claude-code' }).catch(() => undefined);
          await s.registerVersion(V(2), { chatId: CHAT_B, runtime: 'claude-code' }).catch(() => undefined);
          // ---- chat A
          let h: any = null; try { h = await s.head(V(1)); } catch (e: any) { if (!inA && !/^(aside|control|extras)/.test(rel)) problems.push(`${where}: head(A) threw ${e?.code}`); else if (!['damaged', 'corrupt'].includes(e?.code)) problems.push(`${where}: head(A) threw untyped ${e?.code}`); else if (inA && !indexAfterEviction && !(evict && /meta\./.test(rel))) problems.push(`${where}: ONE file made chat A unreadable (${e?.code})`); }
          if (h) {
            const all = await readAll(s, A.slice(0, h.lines), V(1));
            if (/[X?]/.test(all)) problems.push(`${where}: wrong bytes or untyped read error in A: ${all}`);
            if (h.lines < 40 - (evict ? 0 : 0) && !onlyCopy) problems.push(`${where}: A shrank to ${h.lines} lines`);
            if (h.evictedLines > (evict ? 12 : 0)) problems.push(`${where}: lines called evicted that no eviction covered (${h.evictedLines})`);
            // every line that is not served is reported
            if (all.includes('!') && h.damagedFromLine === null) problems.push(`${where}: a line fails to read but damagedFromLine is null`);
            const firstBad = all.indexOf('!'); if (firstBad >= 0 && h.damagedFromLine !== null && h.damagedFromLine > firstBad) problems.push(`${where}: damagedFromLine ${h.damagedFromLine} is after the first failing line ${firstBad}`);
            // a file that is NOT the only copy of anything never costs a single line
            if (!onlyCopy && !indexAfterEviction && !/aside\/|control\/|extras|versions\/[0-9a-f]+\/(torn|healed|replaced)/.test(rel) && (inA || !inB)) {
              // (inventory.ts, checkpoint row: when the checkpoint is lost or older after an eviction, the evicted prefix is not known to be on purpose, so it is REPORTED damaged; a resend heals it)
              const evictionForgotten = evict && /checkpoint\.bin$/.test(rel);
              const bad = all.split('').filter((c, i) => (c === '!' && !(evictionForgotten && i < 12)) || (c === 'E' && i >= (evict ? 12 : 0))).length;
              if (bad > 0 && !(kind === 'rotted' && /index\.bin/.test(rel))) problems.push(`${where}: ${bad} line(s) of A lost although the file is not the only copy of anything: ${all}`);
            }
            // other lines of A stay served when only one body chunk is hit
            if (/body-/.test(rel) && inA) { const ok = all.split('').filter((c) => c === '.' || c === 'E').length; if (ok < all.length * 0.5) problems.push(`${where}: a single body chunk took more than half of chat A with it: ${all}`); }
          }
          // ---- chat B is unaffected by a fault in A's files (and the control/extras/aside rows)
          if (!inB && !/torn|replaced/.test(rel)) { try { const hb = await s.head(V(2)); const allB = await readAll(s, B.slice(0, hb.lines), V(2)); if (hb.lines !== 14 || /[X?!]/.test(allB) || hb.damagedFromLine !== null) problems.push(`${where}: chat B changed (${hb.lines} lines, ${allB})`); } catch (e: any) { problems.push(`${where}: chat B head threw ${e?.code}`); } }
          if (inB) { try { const hb = await s.head(V(2)); const allB = await readAll(s, B.slice(0, hb.lines), V(2)); if (/[X?]/.test(allB)) problems.push(`${where}: chat B wrong bytes ${allB}`); } catch (e: any) { if (!['damaged', 'corrupt'].includes(e?.code)) problems.push(`${where}: chat B untyped ${e?.code}`); } }
          // ---- control log: every entry served, or the loss reported
          for (const chat of [CHAT_A, CHAT_B]) {
            const want = chat === CHAT_A ? [ctl(chat, 0), ctl(chat, 1), ctl(chat, 2)] : [ctl(chat, 0), ctl(chat, 1)];
            const got = await s.controlLog(chat); const dmg = await s.controlDamage(chat); const have = new Set(got.map((e) => e.id));
            const lost = want.filter((e) => !have.has(e.id));
            if (lost.length && dmg.length === 0) problems.push(`${where}: ${lost.length} acknowledged control entr${lost.length === 1 ? 'y' : 'ies'} of ${chat} lost with NO controlDamage`);
            for (const e of got) if (!want.some((w) => w.id === e.id)) problems.push(`${where}: a control entry that was never written to ${chat} is served`);
          }
          // ---- extras: bytes, or a typed corrupt (reported)
          for (const b of extraBytes) { try { const g = await s.readExtra(sha(b)); if (g === null) { if (!/extras\//.test(rel) || kind === 'rotted') { if (!(kind === 'rotted' && /extras\//.test(rel))) problems.push(`${where}: extra silently absent`); } } else if (!g.equals(b)) problems.push(`${where}: wrong extra bytes`); } catch (e: any) { if (e?.code !== 'corrupt') problems.push(`${where}: extra read threw ${e?.code}`); } }
          // ---- the set-aside tail of chat B
          try { const tl = await s.tail('abcdef012345'); if (tl === null) problems.push(`${where}: the set-aside tail vanished silently`); else for (let i = 0; i < tl.lines.length; i++) if (!tl.lines[i].equals(B[tl.fromLine + i])) problems.push(`${where}: wrong tail bytes`); } catch (e: any) { if (e?.code !== 'corrupt' && e?.code !== 'bad-argument') problems.push(`${where}: tail threw ${e?.code}`); }
        } catch (e: any) { problems.push(`${where}: open/register threw ${e?.code ?? e?.message}`); }
        finally { await s?.close().catch(() => undefined); fs.rmSync(work, { recursive: true, force: true }); }
      }
    }
    expect(runs).toBeGreaterThan(files.length * 2);          // most (file, fault) pairs apply
    expect(problems).toEqual([]);
    await t.cleanup();
  }, 600_000);
});
