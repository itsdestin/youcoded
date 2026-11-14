// The relay as a link Carrier: adapts RelayClient (shared/mesh-protocol.ts wire) to the Carrier interface in link.ts.
// No logic of its own beyond translation: the relay's `stored` / `duplicate` become 'stored' / 'duplicate', anything
// else (over-limit, refused, offline) throws so the link keeps the frame and retries.
import type { Carrier } from './link';
import type { RelayClient } from './relay-client';

export function relayCarrier(client: RelayClient): Carrier {
  const ringCbs: Array<(g: string) => void> = [];
  const connCbs: Array<() => void> = [];
  // WHY the doorbell, not `pass`: the relay itself rings every other connected member when it STORES a frame (numbered, no body),
  // which replaced the one-byte `pass` this carrier used to send after each hold.
  client.on('doorbell', (m: { group: string }) => ringCbs.forEach((cb) => cb(m.group)));
  client.on('ready', () => connCbs.forEach((cb) => cb()));
  return {
    get connected() { return client.state === 'ready'; },
    async hold(group, session, n, frame) {
      const r = await client.hold({ group, session, n, frame });
      if (r.op === 'stored') return 'stored';
      if (r.op === 'duplicate') return 'duplicate';
      throw new Error(`hold refused: ${r.op === 'over-limit' ? r.why : r.op === 'refused' ? r.reason : 'unknown'}`);
    },
    fetchAfter: (g, seq) => client.fetchAfter(g, seq),
    received: (g, seq) => client.received(g, seq),
    // Nothing to send: the relay rings the other devices when it stores the frame (see above).
    ring: () => {},
    onRing: (cb) => { ringCbs.push(cb); },
    onConnected: (cb) => { connCbs.push(cb); },
  };
}
