// Remote access batch 2, design §5 (T5), contract R4: switching the desktop
// between chat and terminal never switches the phone, and the phone's toggle
// never moves the desktop or another phone. The chat/terminal switch is each
// screen's own.
//
// Until batch 2, App broadcast `switch-view` from the Android app's toggle and
// applied a received `switch-view` to the current session's view mode, so the
// phone app's toggle moved the desktop and every other client. A source guard
// rather than a mounted App: the two sites are one broadcast and one branch,
// and App cannot be rendered in a unit test without the whole bridge.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readStripped, assertPatternMatches } from './helpers/guard-scope';

const app = readStripped(join(__dirname, '..', 'src', 'renderer', 'App.tsx'));

describe('the chat/terminal switch stays on its own screen', () => {
  it('App never broadcasts switch-view', () => {
    const broadcast = /broadcastAction\?\.\(\{\s*action:\s*'switch-view'/g;
    assertPatternMatches(broadcast, "broadcastAction?.({ action: 'switch-view', mode })", 'the old Android-only broadcast');
    expect(app.match(broadcast)).toBeNull();
  });

  it('a switch-view action received over remote changes no view mode', () => {
    const receiver = /action\.action\s*===\s*'switch-view'/g;
    assertPatternMatches(receiver, "if (action.action === 'switch-view' && action.mode) {", 'the old uiAction branch');
    expect(app.match(receiver)).toBeNull();
    // The relay for _SESSION_INITIALIZED stays: that is the one uiAction App still applies.
    expect(app).toMatch(/action\.type === '_SESSION_INITIALIZED'/);
  });
});
