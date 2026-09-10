import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const preload = read('../src/main/preload.ts');
const handlers = read('../src/main/ipc-handlers.ts');
const shim = read('../src/renderer/remote-shim.ts');
const kotlin = read('../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt');
const CHANNELS = ['remote:devices:list', 'remote:devices:rename', 'remote:devices:unpair'];

describe('the device list exists on every platform', () => {
  it('each channel is registered in preload, the desktop handlers and the shim', () => {
    // WHY a parity test and not a type: shim-parity compares SHAPES, so a channel missing
    // from one side of the bridge type-checks and then does nothing at runtime.
    for (const c of CHANNELS) {
      expect(preload).toContain(`'${c}'`);
      expect(shim).toContain(`'${c}'`);
    }
    expect(handlers).toContain('IPC.REMOTE_DEVICES_LIST');
    expect(handlers).toContain('IPC.REMOTE_DEVICES_RENAME');
    expect(handlers).toContain('IPC.REMOTE_DEVICES_UNPAIR');
  });

  it('Android answers all three rather than falling through to unsupported', () => {
    // shim-parity.test.ts cannot see Kotlin, so a missing case here is invisible until a
    // phone hits it. Every channel must appear in the when-block.
    for (const c of CHANNELS) expect(kotlin).toContain(`"${c}"`);
  });

  it('the channel that looked like it removed access is gone, not merely unused', () => {
    // remote:disconnect-client closed the socket and left the credential valid. Keeping it
    // beside Unpair would put two near-identical labels with very different consequences
    // next to each other.
    expect(preload).not.toContain('disconnectClient');
    expect(shim).not.toContain('disconnectClient:');
    expect(kotlin).not.toContain('"remote:disconnect-client"');
    expect(read('../src/main/remote-server.ts')).not.toContain('disconnectClient(clientId: string)');
    // The server still REFUSES the old channel rather than ignoring it, so a client that
    // has not updated is told no instead of being met with silence.
    expect(read('../src/main/remote-server.ts')).toContain("case 'remote:disconnect-client'");
  });
});
