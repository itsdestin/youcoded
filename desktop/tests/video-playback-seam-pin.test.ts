// The camera-video host takes its peer connection and frame source from the
// bridge's `videoPlayback` property so the workbench can run without a camera
// (step 3 code review, finding 8). That is a way to hand the host a fake peer
// that sees every raw picture and network address, so ONLY the workbench's mock
// may set it. A real bridge that set it would silently swap the browser's own
// WebRTC out from under every page.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('the videoPlayback seam belongs to the workbench alone', () => {
  it.each(['main/preload.ts', 'renderer/remote-shim.ts', 'renderer/remote-pages-bridge.ts'])('%s never sets it', (file) => {
    expect(read(file)).not.toContain('videoPlayback');
  });

  it('the workbench mock does set it (so this pin is looking at the right name)', () => {
    expect(read('renderer/dev/workbench/mock-shim.ts')).toContain('videoPlayback');
  });
});
