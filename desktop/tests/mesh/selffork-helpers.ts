// Shared by the self-fork tests and the crash sweep (a test file must not be imported by another, it would run twice).
import * as nodePath from 'node:path';
import { lineSet, CHAT, type World } from './replicator-world';
import { signWith } from '../../src/main/mesh/crypto/identity';

/** B (stopped) is given five lines "yy" with a signed point of A's; then A, cut off from B, signs five other lines "xx" for the same positions; then B starts and they meet. */
export async function splitHistories(world: World, V: Buffer, onSaved?: (v2: Buffer) => void, tokenOf?: (writer: Buffer, chat: string, tail?: string) => string): Promise<void> {
  const { headMessage } = await import('../../src/main/mesh/replicator/wire');
  const { chainStep, defaultChainSeeds } = await import('../../src/main/mesh/store');
  const { SignedHeads } = await import('../../src/main/mesh/replicator/signed-heads');
  const { realFs } = await import('../../src/main/mesh/store/fsio');
  await world.devs.B.rep.idle(); world.devs.B.rep.stop(); world.devs.B.link.stop(); await world.devs.B.store.close(); const dev = await world.restart('B', { graceful: false, start: false });
  const y = lineSet(5, 'yy'); const ch = y.reduce((h, l) => chainStep(h, l), defaultChainSeeds({ chatId: CHAT, version: new Uint8Array(), segment: 0 }).raw);
  await dev.store.append((await world.localOf('B', V)) as Buffer, 0, 0, y);
  await new SignedHeads(realFs, nodePath.join(world.dirs.B, 'replicator')).add(V, { lines: 5, hash: ch, sig: signWith(world.ids.A, headMessage(V, 5, ch)), spanBytes: 100 });
  world.devs.B.carrier.setOnline(false);
  await dev.rep.start(); // B runs, but cannot be heard (so that a kill of A during the next steps still leaves B running, as in life)
  await world.elapse(8_000, 1_000, true);
  await world.append('A', V, lineSet(5, 'xx'));
  if (onSaved && tokenOf) { const { deriveForkId } = await import('../../src/main/mesh/store'); const local = await world.local('A', V); const h0 = (await world.devs.A.store.hashAt(local, 0, 0)) as string; const hd = await world.devs.A.store.head(local); onSaved(deriveForkId(V, 0, h0, tokenOf(world.ids.A.deviceId, CHAT, hd.hash.slice(0, 8)))); } // only once the lines were told "saved"; the id carries the head the writer had (review 4, F1)
  world.devs.B.carrier.setOnline(true);
  await world.elapse(120_000, 10_000, true);
}
