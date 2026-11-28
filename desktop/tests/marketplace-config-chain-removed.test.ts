// marketplace-config-chain-removed.test.ts — pins the deletion of the unused plugin-settings channels.
//
// WHY (card #151 item 5, Destin's decision): `marketplace:get-config` / `marketplace:set-config` outlived the settings form
// that used them. No screen calls them and no registry entry declares a settings schema, so the whole chain was deleted. This
// fails if any door (contract, channel table, desktop bridge, phone bridge) grows it back without a decision.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { IPC } from '../src/shared/backend-contract';
import { CHANNEL_TABLE } from '../src/main/ipc/channel-table';

const GONE = ['marketplace:get-config', 'marketplace:set-config'];
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('the plugin-settings get/set-config chain is gone', () => {
  it('is in neither the channel contract nor the channel table', () => {
    const names = new Set(Object.values(IPC) as string[]);
    for (const n of GONE) {
      expect(names.has(n), n).toBe(false);
      expect(CHANNEL_TABLE.some((d) => d.name === n), n).toBe(false);
    }
  });
  it('is not wired in the desktop bridge, the phone bridge or the settings store', () => {
    for (const f of ['src/main/preload.ts', 'src/renderer/remote-shim.ts', 'src/main/ipc/marketplace.ts', 'src/main/skill-provider.ts']) {
      const src = read(f);
      for (const n of GONE) expect(src.includes(n), `${f} ${n}`).toBe(false);
      expect(src.includes('marketplace-config-store'), f).toBe(false);
    }
    expect(fs.existsSync(path.join(__dirname, '..', 'src/main/marketplace-config-store.ts'))).toBe(false);
  });
});
