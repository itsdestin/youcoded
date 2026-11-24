// Guards for the class fix: the store may only write files that inventory.ts describes, and every call that can destroy
// bytes (unlink, truncate, rename, an atomic overwrite) must say WHY it is safe, in a comment the reader can check.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ChatStore } from './store';
import { cc } from './fixtures';
import { CHAT, V, openWith, tmpRoot } from './testkit';
import { inventoryRow, ROOT_ROWS, VERSION_ROWS } from './inventory';
import { recPos } from './records';

const walk = (d: string, out: string[] = []): string[] => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('every file the store writes is in the inventory', () => {
  it('a folder that has seen every operation (park, set aside, evict, restore, heal, rebuild, quarantine, control, extras) holds only inventoried names', async () => {
    const t = await tmpRoot('inventory-');
    try {
      const vhex = V(1).toString('hex');
      const rows = (n: number, tag: string) => Array.from({ length: n }, (_, i) => cc.user(`${tag} ${i} ${'z'.repeat(30)}`));
      const L = rows(60, 'a');
      const s = await openWith(t.dir, V(1), { chunkBytes: 900, proofVerifier: () => true });
      await s.registerVersion(V(2), { chatId: CHAT, runtime: 'native', parent: V(1) });
      for (let i = 0; i < 40; i += 8) await s.append(V(1), 0, i, L.slice(i, i + 8));
      await s.append(V(1), 0, 50, L.slice(50, 53));                                   // parked
      const h = (await s.hashAt(V(1), 0, 10))!;
      await s.evictBody(V(1), { kind: 'holders-confirmed', version: vhex, through: 10, hash: h, acks: [{ holder: 'p', version: vhex, lines: 10, hash: h, signature: 's' }] });
      await s.restoreBody(V(1), L.slice(0, 10));
      await s.setAsideTail('abcdef012345', V(1), 35);
      await s.append(V(1), 0, 35, L.slice(35, 40));
      await s.append(V(1), 0, 52, L.slice(52, 55));                                   // parked again, in the NEW history (the first park was moved to rejected/ by the takeover, review 6)
      await s.scrubStep(V(1));
      const e1 = Buffer.from('e1'); const e2 = Buffer.from('e2');
      await s.appendControl({ id: sha(e2), chat: CHAT, seen: [sha(e1)], body: e2 });  // parked control entry
      await s.appendControl({ id: sha(e1), chat: CHAT, seen: [], body: e1 });
      await s.putExtra(sha(Buffer.from('x')), Buffer.from('x'));
      // heal a rotted body line from a resend
      const body0 = path.join(t.dir, 'versions', vhex, 'body-0000000000000000.bin');
      const b = fs.readFileSync(body0); b[20] ^= 0x40; fs.writeFileSync(body0, b);
      await s.append(V(1), 0, 0, L.slice(0, 3));
      await s.close();
      // a rebuild keeps the old index under replaced-index/
      const ix = path.join(t.dir, 'versions', vhex, 'index.bin'); const ib = fs.readFileSync(ix); ib[recPos(4) + 3] ^= 1; fs.writeFileSync(ix, ib);
      const s2 = await ChatStore.open(t.dir, { proofVerifier: () => true });
      await s2.head(V(1));
      // quarantine and an explicit set-aside
      await s2.setAsideDamaged(V(1));
      await s2.append(V(1), 0, 0, L.slice(0, 5));
      const v3 = V(3); await s2.registerVersion(v3, { chatId: CHAT, runtime: 'claude-code' }); await s2.append(v3, 0, 0, L.slice(0, 5));
      await s2.close();
      fs.truncateSync(path.join(t.dir, 'versions', v3.toString('hex'), 'index.bin'), 5);
      fs.unlinkSync(path.join(t.dir, 'versions', v3.toString('hex'), 'checkpoint.bin'));
      const s3 = await ChatStore.open(t.dir);
      await s3.head(v3).catch(() => undefined);
      await s3.close();
      const names = walk(t.dir).map((p) => path.relative(t.dir, p));
      expect(names.filter((n) => !inventoryRow(n))).toEqual([]);
      expect(names.some((n) => n.startsWith('aside/'))).toBe(true);
      expect(names.some((n) => n.includes('replaced-index/'))).toBe(true);
      expect(names.some((n) => n.includes('healed/'))).toBe(true);
      expect(names.some((n) => n.includes('tails/'))).toBe(true);
      expect(names.some((n) => n.includes('parked/'))).toBe(true);
      expect(names.some((n) => n.includes('rejected/'))).toBe(true);
    } finally { await t.cleanup(); }
  });
});

describe('every inventory row answers the five questions of the class (review 4)', () => {
  it('rotted, older copy, foreign copy, missing and cleanly truncated each have a stated, non-destructive answer', () => {
    for (const row of [...ROOT_ROWS, ...VERSION_ROWS]) {
      for (const k of ['rotted', 'older', 'foreign', 'missing', 'truncated'] as const) {
        const a = row.answers[k];
        expect(a.length, `${row.id}.${k}`).toBeGreaterThan(2);
        // the answer may never be "delete or cut something else" or "silently fewer"
        expect(/\bdelete[sd]? (the|a|an) (body|chunk|line|chat|version)|silently (fewer|dropped|lost)/i.test(a), `${row.id}.${k}: ${a}`).toBe(false);
      }
    }
  });
});

describe('every call that can destroy bytes says why it is safe', () => {
  const dir = path.dirname(fileURLToPath(new URL(import.meta.url)));
  const files = ['store.ts', 'recovery.ts', 'control.ts', 'extras.ts', 'checkpoint.ts', 'lock.ts', 'sidefile.ts', 'fsio.ts', 'versionfiles.ts'];
  // unlink, truncate, rename, rm, an atomic overwrite, a hard link, or a write that lands inside existing bytes
  const DESTRUCTIVE = /\.unlink\(|\.truncate\(|\.rename\(|\brm\(|\brmSync\(|\bwriteFileAtomic\(|fsp\.link\(|\bwriteSide\(|\bwriteSideFor\(|\bwriteCheckpoint\(|\bf\.write\(slotBytes|\bcf\.write\(want|\bcf\.write\(data/;
  const TAG = /DESTRUCTIVE-OK\((hint|scratch|kept-copy-first|verified-record|rollback-own-bytes|explicit-request|lock|door)\)/;
  it('each unlink, truncate, rename, atomic overwrite or in-place overwrite carries a DESTRUCTIVE-OK(<category>) reason on its line or the lines just above', () => {
    const missing: string[] = [];
    let total = 0;
    for (const f of files) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
      lines.forEach((ln, i) => {
        const code = ln.replace(/\/\/.*$/, '');
        if (!DESTRUCTIVE.test(code)) return;
        if (/^\s*(export\s+)?(async\s+)?function\s|^\s*(\/\/|\*)/.test(ln)) return;
        total++;
        const near = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        if (!TAG.test(near)) missing.push(`${f}:${i + 1}: ${ln.trim().slice(0, 100)}`);
      });
    }
    expect(missing).toEqual([]);
    expect(total).toBeGreaterThan(20);
  });
});
