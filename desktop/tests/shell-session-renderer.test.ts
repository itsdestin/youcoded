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
// The pure functions are CALLED here — that is the real behaviour. The App.tsx /
// HeaderBar / SessionStrip branches (App.tsx cannot be mounted in a unit test)
// used to be pinned here as source text. WHY they are not any more (Plan B,
// 2026-09-16): they are ast-grep rules in youcoded-dev's scripts/ast-grep/rules/ —
// shell-session-view-forced, shell-session-view-toggle-hidden,
// shell-session-no-claude-ui, shell-session-permission-cycle-guarded,
// runtime-union-has-no-shell and session-strip-runtime-never-shell.
import { describe, it, expect } from 'vitest';
import { sessionRuntimeLabel } from '../src/renderer/components/header/session-runtime-label';
import { modelChipFor, supportsAliasCycling } from '../src/renderer/components/model-chip';
import { canPtySend } from '../src/renderer/state/pty-input-gate';
import { routeSlashResult } from '../src/renderer/state/native-slash-actions';

describe('a shell session in the renderer', () => {
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

    it("reports a slash command as unavailable instead of typing it", () => {
      const r = routeSlashResult('shell', { handled: true, alsoSendToPty: '/cost\r' });
      expect(r).toEqual({ via: 'none-native-no-pty', command: '/cost' });
    });

    it('a Claude Code session still routes to its PTY', () => {
      expect(routeSlashResult('claude', { handled: true, alsoSendToPty: '/cost\r' }))
        .toEqual({ via: 'pty', text: '/cost\r' });
    });
  });
});
