// What the renderer draws for a shell session (local-engine upgrades §F, T5).
//
// A shell session is a plain terminal the app opened for the user — no model, no
// transcript, no assistant. "Run in terminal" creates one AND selects it, so the
// user is sitting inside a session every renderer branch has to have an opinion
// about. Everything wrong here is wrong in a way the user sees: a composer that
// sends nowhere, a red "Model Unknown" chip on a session that has no model, a
// toggle that strands them on an empty chat pane, or a Claude Code slash command
// typed at their shell prompt.
//
// TWO KINDS OF ASSERTION, on purpose.
//   * The pure functions are CALLED. That is the real behaviour.
//   * App.tsx is asserted as SOURCE TEXT, the way tests/app-resume-session-
//     listener.test.ts does — App.tsx is ~3,900 lines and mounting it needs the
//     full renderer boot sequence, which no test here has ever managed. A source
//     pin is weaker than a render, and it is what exists; each one below quotes
//     the exact branch so deleting the branch fails the test.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sessionRuntimeLabel } from '../src/renderer/components/header/session-runtime-label';
import { modelChipFor, supportsAliasCycling } from '../src/renderer/components/model-chip';
import { canPtySend } from '../src/renderer/state/pty-input-gate';
import { routeSlashResult } from '../src/renderer/state/native-slash-actions';

const src = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const appSrc = src('renderer', 'App.tsx');
const headerSrc = src('renderer', 'components', 'HeaderBar.tsx');

describe('a shell session in the renderer', () => {
  // Sanity: if these reads ever return the wrong file, every source pin below
  // passes or fails for reasons that have nothing to do with the shell provider.
  it('the source scan reads the files it thinks it reads', () => {
    expect(appSrc).toContain('const currentViewMode =');
    expect(headerSrc).toContain('const showToggle =');
    expect(appSrc.length).toBeGreaterThan(100_000);
  });

  describe('the terminal view is forced', () => {
    it('a new shell session opens on the terminal, not on chat', () => {
      expect(appSrc).toContain("const defaultView = info.provider === 'shell' ? 'terminal' : 'chat';");
    });

    it('the view is forced, not merely defaulted, so nothing can leave it', () => {
      expect(appSrc).toContain("const isShellSession = activeSessionProvider === 'shell';");
      expect(appSrc).toContain("const currentViewMode = isShellSession ? 'terminal' :");
    });

    it('both panes read the forced view, not the raw per-session map', () => {
      // Reading the map here would put the chat pane back on screen for a shell
      // session whose map entry was never seeded.
      expect(appSrc).toContain("visible={s.id === sessionId && currentViewMode === 'chat'}");
      expect(appSrc).toContain("visible={s.id === sessionId && currentViewMode === 'terminal'}");
    });

    it('the toggle handler refuses a shell session', () => {
      // Ctrl+` lands in handleToggleView (a remote switch-view no longer reaches App — batch 2 §5).
      expect(appSrc).toContain(
        "if (sessionsRef.current.find((x) => x.id === sessionId)?.provider === 'shell') return;"
      );
    });

    it('the header hides the chat/terminal toggle for a shell session', () => {
      expect(headerSrc).toContain(
        "const showToggle = activeSessionProvider !== 'native' && activeSessionProvider !== 'shell';"
      );
    });
  });

  describe('no composer, no stop button, no model picker', () => {
    it('the whole bottom chrome is skipped for a shell session', () => {
      // ChatInputBar carries the composer AND the Stop button; StatusBar carries
      // the model chip and the way into the model picker. One gate removes all
      // four, which is why there is no per-control assertion here.
      expect(appSrc).toContain('{!isShellSession && (<>');
      const gate = appSrc.indexOf('{!isShellSession && (<>');
      const close = appSrc.indexOf('</>)}', gate);
      expect(close).toBeGreaterThan(gate);
      const gated = appSrc.slice(gate, close);
      expect(gated).toContain('<ChatInputBar');
      expect(gated).toContain('<StatusBar');
    });

    it('the model picker cannot open for a shell session', () => {
      expect(appSrc).toContain('open={modelPickerOpen && !isShellSession}');
    });

    it("Preferences' Advanced button is Claude Code only", () => {
      // It types /config into the PTY. In a shell session that is just a wrong
      // command at the user's prompt.
      expect(appSrc).toContain(
        "showAdvanced={currentSession?.provider !== 'native' && currentSession?.provider !== 'shell'}"
      );
    });
  });

  describe('the session says what it is', () => {
    it('labels a shell session by its shell, not as Claude Code', () => {
      const label = sessionRuntimeLabel({ provider: 'shell', shellName: 'fish' });
      expect(label.runtime).toBe('Terminal');
      expect(label.text).toBe('Terminal · fish');
      expect(label.text).not.toContain('Claude');
    });

    it('still labels a shell session honestly when the shell name is missing', () => {
      expect(sessionRuntimeLabel({ provider: 'shell' }).text).toBe('Terminal');
    });

    it('leaves the Claude Code and native labels alone', () => {
      expect(sessionRuntimeLabel({ provider: 'claude' }).runtime).toBe('Claude Code');
      expect(sessionRuntimeLabel({ provider: 'native', harnessId: 'coder' }).runtime).toBe('YouCoded Coder');
    });

    it('Settings closes itself when a shell session lands, or the user never sees it', () => {
      expect(appSrc).toContain("if (info.provider === 'shell') setSettingsOpen(false);");
    });
  });

  describe('no model', () => {
    it('shows no model chip at all — not the red "Model Unknown" one', () => {
      expect(modelChipFor({ provider: 'shell' }, 'unknown')).toBeUndefined();
      expect(modelChipFor({ provider: 'shell' }, 'sonnet')).toBeUndefined();
    });

    it('a Claude session still gets its chip', () => {
      expect(modelChipFor({ provider: 'claude' }, 'sonnet')).toEqual({ kind: 'alias', alias: 'sonnet' });
    });

    it('refuses the Shift+Space alias cycle, which would type /model at a prompt', () => {
      expect(supportsAliasCycling({ provider: 'shell' })).toBe(false);
      expect(supportsAliasCycling({ provider: 'claude' })).toBe(true);
    });
  });

  describe('the app never types Claude Code text at the user\'s prompt', () => {
    it('refuses every programmatic PTY write to a shell session', () => {
      // A shell session HAS a PTY, so this is "must not", not "cannot": /sync,
      // /config, /model and skill invocations all funnel through this gate.
      expect(canPtySend({ provider: 'shell' }, undefined)).toBe(false);
      expect(canPtySend({ provider: 'claude' }, undefined)).toBe(true);
      expect(canPtySend({ provider: 'native' }, undefined)).toBe(false);
    });

    it('the permission cycle refuses a shell session', () => {
      // cyclePermission calls session.sendInput RAW — it does not ask
      // canPtySend — and its only other shield is isTypingTarget, which is
      // false whenever xterm does not hold focus. Click the header pill in a
      // shell session, press Shift+Tab, and \x1b[Z lands at the user's prompt.
      const cycle = appSrc.slice(appSrc.indexOf('const cyclePermission ='));
      const guard = "if (sessionsRef.current.find((x) => x.id === sessionId)?.provider === 'shell') return;";
      expect(cycle.slice(0, cycle.indexOf("sendInput(sessionId, '\\x1b[Z')"))).toContain(guard);
    });

    it("reports a slash command as unavailable instead of typing it", () => {
      const r = routeSlashResult('shell', { handled: true, alsoSendToPty: '/cost\r' });
      expect(r).toEqual({ via: 'none-native-no-pty', command: '/cost' });
    });

    it('a Claude Code session still routes to its PTY', () => {
      expect(routeSlashResult('claude', { handled: true, alsoSendToPty: '/cost\r' }))
        .toEqual({ via: 'pty', text: '/cost\r' });
    });

    it('says the honest thing in the toast for a shell session', () => {
      // The native-runtime sentence would be a lie here.
      expect(appSrc).toContain("isn't available in a terminal session — it's a Claude Code command.");
    });
  });

  describe('the provider is not offered in the new-session form', () => {
    it('the form derives its runtime from a MODEL choice, which a shell has none of', () => {
      const stripSrc = src('renderer', 'components', 'SessionStrip.tsx');
      const bindingSrc = src('renderer', 'components', 'RuntimeBinding.tsx');
      // The form's `runtime` is typed by RuntimeBinding's Runtime union, which
      // has no 'shell' member — so no code path in the form can produce one.
      expect(bindingSrc).toContain("export type Runtime = 'claude' | 'native';");
      // The INITIAL value moved to defaultRuntime() upstream, so pinning the literal
      // 'claude' pinned an incidental detail. What this guard is actually for is that
      // the state is typed by the union above — that is what makes a shell runtime
      // unrepresentable here, whatever the initial value is computed from.
      expect(stripSrc).toContain("useState<Runtime>(");
      // ...and nothing sets it to a shell anyway.
      expect(stripSrc).not.toContain("setRuntime('shell')");
    });
  });
});
