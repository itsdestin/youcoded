// Remote access batch 2, design §2 (T3): every window tells main which session
// it shows (`session:selected`), and main caches it per window so a phone opens
// on what the desktop is showing. Four surfaces, and each is one line that a
// refactor could drop without any behaviour test noticing on the desktop — the
// desktop itself never reads the cache.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readStripped, assertPatternMatches } from './helpers/guard-scope';

const src = (...p: string[]) => readStripped(join(__dirname, '..', 'src', ...p));

describe('session:selected, renderer → main', () => {
  it('both IPC maps name the channel', () => {
    const constant = /SESSION_SELECTED:\s*'session:selected'/;
    assertPatternMatches(constant, "SESSION_SELECTED: 'session:selected',", 'the IPC map entry');
    expect(src('main', 'preload.ts')).toMatch(constant);
    expect(src('shared', 'types.ts')).toMatch(constant);
  });

  it('App reports every selection change', () => {
    const effect = /useEffect\(\(\) => \{[^{}]*session[^{}]*noteSelected\?\.\(sessionId\)[^{}]*\}, \[sessionId\]\)/;
    assertPatternMatches(effect, "useEffect(() => {\n    (window.claude.session as any).noteSelected?.(sessionId);\n  }, [sessionId])", 'an effect keyed on sessionId');
    expect(src('renderer', 'App.tsx')).toMatch(effect);
  });

  it('preload sends it to main', () => {
    const send = /noteSelected:\s*\([^)]*\)\s*=>\s*ipcRenderer\.send\(IPC\.SESSION_SELECTED/;
    assertPatternMatches(send, 'noteSelected: (sessionId: string | null) =>\n      ipcRenderer.send(IPC.SESSION_SELECTED, sessionId)', 'the preload send');
    expect(src('main', 'preload.ts')).toMatch(send);
  });

  it('main caches it per window', () => {
    const handler = /ipcMain\.on\(IPC\.SESSION_SELECTED,[\s\S]{0,400}?setSelectedSession\(\s*evt\.sender\.id/;
    assertPatternMatches(handler, 'ipcMain.on(IPC.SESSION_SELECTED, (evt, sessionId) => {\n windowRegistry?.setSelectedSession(evt.sender.id, x)', 'the cache write');
    expect(src('main', 'ipc-handlers.ts')).toMatch(handler);
  });

  it('the remote shim has the member and sends nothing — a phone has no desktop window to report', () => {
    const noop = /noteSelected:\s*\([^)]*\)\s*=>\s*\{\s*\}/;
    assertPatternMatches(noop, 'noteSelected: (_sessionId: string | null) => {}', 'an empty arrow');
    expect(src('renderer', 'remote-shim.ts')).toMatch(noop);
  });
});
