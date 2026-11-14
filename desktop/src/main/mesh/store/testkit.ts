// Shared helpers for the store tests. Synthetic data only.
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { defaultChainSeeds, type ChainSeeds, type RuntimeKind } from './chain';
import { analyseLine } from './classify';
import { ChatStore, type StoreOptions } from './store';

export const V = (n: number): Buffer => Buffer.from([0xaa, n & 0xff, (n >> 8) & 0xff, 0x01]);
export const CHAT = 'synthetic:chat-1';

// WHY async: this file lives under src/main, where the repo bans blocking fs calls outside tests.
export async function tmpRoot(prefix = 'mesh-store-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

export async function openWith(root: string, version = V(1), o: StoreOptions = {}, runtime: RuntimeKind = 'claude-code', chatId = CHAT): Promise<ChatStore> {
  const s = await ChatStore.open(root, o);
  await s.registerVersion(version, { chatId, runtime });
  return s;
}

export function seedsFor(chatId = CHAT): ChainSeeds { return defaultChainSeeds({ chatId, version: new Uint8Array(), segment: 0 }); }

/** Independent reference chains (do not use chain.ts steps, so a shared bug cannot cancel out). */
export function refChains(lines: Buffer[], runtime: RuntimeKind = 'claude-code', chatId = CHAT): { raw: string[]; conv: string; convLines: number } {
  const seeds = seedsFor(chatId);
  let h = Buffer.from(seeds.raw); let c = Buffer.from(seeds.conversation); let convLines = 0;
  const raw = [h.toString('hex')];
  for (const l of lines) {
    h = createHash('sha256').update(h).update(l).digest();
    if (analyseLine(runtime, l).conversation) { c = createHash('sha256').update(c).update(l).digest(); convLines++; }
    raw.push(h.toString('hex'));
  }
  return { raw, conv: c.toString('hex'), convLines };
}

/** Small deterministic PRNG (mulberry32) so property tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const listFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => { for (const e of await fsp.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out.push(p); } };
  await walk(dir);
  return out.sort();
};
