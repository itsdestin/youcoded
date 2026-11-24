// Pins the public surface of the mesh chat store and adapters: what later parts (replicator, host
// control, session router, read-side readers) may import from './index'. Removing or renaming an export
// breaks this test on purpose. It also makes the barrel reachable for the dead-code check while
// nothing in the app imports it yet (the feature ships switched OFF).
import { describe, expect, it } from 'vitest';
import * as store from './index';

describe('mesh store public surface', () => {
  it('exports the documented API', () => {
    const must = [
      // S1
      'initAdapterState', 'poll', 'ingest', 'cheapCheck', 'scrub', 'isRewritten', 'TAIL_BYTES',
      'analyseLine', 'replyEndStep', 'settleReplyEnd', 'initialReplyState',
      // chains and the replaceable seed rule
      'defaultChainSeeds', 'chainStep', 'hex', 'unhex', 'isHash64', 'crc32',
      // S2
      'ChatStore', 'StoreError', 'ControlStore',
      // disk door
      'realFs', 'writeFileAtomic', 'sweepTemps',
    ];
    for (const name of must) expect(store, name).toHaveProperty(name);
  });
  it('S2 methods named by the design exist on the store', () => {
    const methods = ['head', 'hashAt', 'read', 'append', 'forkVersion', 'setAsideDamaged', 'replyEnds', 'controlLog', 'appendControl', 'summary', 'listVersions', 'hasExtra', 'readExtra', 'putExtra', 'evictBody', 'restoreBody', 'registerVersion', 'conversationLines', 'verify'];
    for (const m of methods) expect(typeof (store.ChatStore.prototype as unknown as Record<string, unknown>)[m], m).toBe('function');
  });
});
