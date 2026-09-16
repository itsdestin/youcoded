import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Three-surface parity for `transcript:page` (perf cycle 2).
 *
 * Android is DELIBERATELY absent: on-device paging is a later cycle (Destin's
 * decision 1a, 2026-08-27). The phone hydrates over `chat:hydrate` today and
 * pages through the remote bridge when connected to a desktop, so the Kotlin
 * surface has nothing to answer yet. When on-device paging lands, this block
 * grows a SessionService.kt assertion.
 *
 * Until then the shim refuses the call QUIETLY on the phone's own bridge
 * (remote-shim.ts requestTranscriptPage, 2026-09-10): App.tsx asks for every
 * session's first page on launch, and before this the bridge's bare `{error}`
 * reply resolved into the chat reducer as junk.
 */
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('transcript:page channel parity (desktop + remote; Android is a later cycle)', () => {
  const CHANNEL = 'transcript:page';

  it('declared in shared/types.ts and preload.ts with the same value', () => {
    expect(read('src/shared/types.ts')).toContain(`TRANSCRIPT_PAGE: '${CHANNEL}'`);
    expect(read('src/main/preload.ts')).toContain(`TRANSCRIPT_PAGE: '${CHANNEL}'`);
  });

  it('exposed on preload as requestTranscriptPage', () => {
    expect(read('src/main/preload.ts')).toMatch(/requestTranscriptPage:\s*\(/);
  });

  it('handled in ipc-handlers.ts', () => {
    expect(read('src/main/ipc-handlers.ts')).toContain('IPC.TRANSCRIPT_PAGE');
  });

  it('sent by remote-shim.ts as a real call, not a no-op stub', () => {
    const shim = read('src/renderer/remote-shim.ts');
    expect(shim).toContain(CHANNEL);
    // requestTranscriptReplay shipped as `() => {}` and silently did nothing on
    // the phone for months. Never again on this channel.
    expect(shim).not.toMatch(/requestTranscriptPage:\s*\([^)]*\)\s*=>\s*\{\s*\}/);
  });

  it('answered by a remote-server.ts WS case', () => {
    expect(read('src/main/remote-server.ts')).toContain(`'${CHANNEL}'`);
  });

  // "I could not locate the transcript" vs "you have reached the beginning of
  // the conversation" were the same answer until 2026-09-07, and the renderer
  // acted on the second — dropping the cursor and the scroll-up sentinel, so
  // the rest of the conversation became unreachable in that window. The SAME
  // React renderer runs over the remote bridge, so a surface that answers this
  // channel without the distinction reintroduces the bug on that surface only.
  it('both answering surfaces distinguish "unresolved" from "no more history"', () => {
    expect(read('src/shared/types.ts')).toMatch(/unresolved\?: true/);
    expect(read('src/main/ipc-handlers.ts')).toMatch(/unresolved: true/);
    expect(read('src/main/remote-server.ts')).toMatch(/unresolved: true/);
  });
});
