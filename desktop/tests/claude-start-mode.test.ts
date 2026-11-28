// Pins which mode a new Claude Code session is started in and what its badge shows at once
// (2026-11-09 final review, Q-8 / F-7: "always start in auto ... unless i toggle bypass permissions").
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { claudeStartMode, projectDefaultMode, refreshProjectDefaultMode } from '../src/main/claude-start-mode';
import { detectPermissionMode, detectAutoRefused } from '../src/shared/permission-mode-detect';
import { SessionLiveFacts } from '../src/main/session-live';
import { SessionRecords } from '../src/main/session-record';
import { createPublish } from '../src/main/publish';

describe('claudeStartMode', () => {
  it('starts in auto, named explicitly, when nothing else is chosen', () => {
    expect(claudeStartMode(false, undefined)).toEqual({ args: ['--permission-mode', 'auto'], badge: 'auto' });
  });

  it('starts in bypass when Skip permissions is on, whatever the settings file says', () => {
    expect(claudeStartMode(true, 'plan')).toEqual({ args: ['--dangerously-skip-permissions'], badge: 'bypass' });
  });

  it("leaves a default the person set in Claude Code's own settings alone, and shows it", () => {
    expect(claudeStartMode(false, 'plan')).toEqual({ args: [], badge: 'plan' });
    expect(claudeStartMode(false, 'acceptEdits')).toEqual({ args: [], badge: 'auto-accept' });
    expect(claudeStartMode(false, 'default')).toEqual({ args: [], badge: 'normal' });
  });

  it('treats an unrecognised or non-text setting as unset', () => {
    expect(claudeStartMode(false, 'something-new').badge).toBe('auto');
    expect(claudeStartMode(false, 42).badge).toBe('auto');
  });
});

describe("a folder's own default mode", () => {
  it('is read from the folder, local file first, and outranks naming auto', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yc-startmode-'));
    try {
      expect(projectDefaultMode(dir)).toBeUndefined();
      mkdirSync(join(dir, '.claude'));
      writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'plan' } }));
      await refreshProjectDefaultMode(dir);
      expect(projectDefaultMode(dir)).toBe('plan');
      expect(claudeStartMode(false, projectDefaultMode(dir))).toEqual({ args: [], badge: 'plan' });
      writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));
      await refreshProjectDefaultMode(dir);
      expect(projectDefaultMode(dir)).toBe('acceptEdits');
      writeFileSync(join(dir, '.claude', 'settings.local.json'), '{ not json');
      await refreshProjectDefaultMode(dir);
      expect(projectDefaultMode(dir)).toBe('plan');
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
  });
});

describe('auto refused by Claude Code', () => {
  it("recognises Claude Code's own notices", () => {
    expect(detectAutoRefused('Auto mode is unavailable for your plan')).toBe(true);
    expect(detectAutoRefused('auto mode unavailable for this model')).toBe(true);
    expect(detectAutoRefused("auto mode isn't available in this session. Restart Claude Code to check again.")).toBe(true);
    expect(detectAutoRefused('auto mode is off while fast mode is on. Run /fast off to change this.')).toBe(true);
  });

  it('does not re-count a notice that was wholly in the previous piece', () => {
    const tail = 'auto mode is unavailable for your plan';
    expect(detectAutoRefused(tail + ' more output', tail.length)).toBe(false);
  });

  it('ignores ordinary talk about auto mode, and is never a mode reading by itself', () => {
    expect(detectAutoRefused('You can switch to auto mode with shift+tab.')).toBe(false);
    expect(detectPermissionMode('auto mode unavailable for this model')).toBeNull();
  });
});

describe('the badge of a session started in auto', () => {
  function reader(mode: string) {
    const records = new SessionRecords({});
    records.begin('s');
    const modes: string[] = [];
    const publish = createPublish({ records, toWindows: (_s, channel, args) => { if (channel === 'session:permission-mode') modes.push((args[0] as any).mode); }, toSockets: () => {} });
    let current = mode;
    const live = new SessionLiveFacts({ publish, records, isClaude: () => true, currentMode: () => current, onModeRead: (_id, m) => { current = m; } });
    return { live, modes };
  }

  it('is corrected to normal when Claude Code says auto is not available', () => {
    const r = reader('auto');
    r.live.noteOutput('s', '   auto mode unavailable for this model\r');
    expect(r.modes).toEqual(['normal']);
  });

  it('is left alone when the same words turn up later in the session (a chat about auto mode)', () => {
    let t = 1_000;
    const records = new SessionRecords({});
    records.begin('s');
    const modes: string[] = [];
    const publish = createPublish({ records, toWindows: (_s, channel, args) => { if (channel === 'session:permission-mode') modes.push((args[0] as any).mode); }, toSockets: () => {} });
    const live = new SessionLiveFacts({ publish, records, isClaude: () => true, currentMode: () => 'auto', now: () => t } as any);
    live.noteOutput('s', 'Claude Code v2.1.322\r');
    t += 5 * 60_000;
    live.noteOutput('s', '● The notice reads "auto mode is unavailable for your plan".\r');
    expect(modes).toEqual([]);
  });

  it('is left alone by the same notice when the session is in another mode (seen in real plan-mode captures)', () => {
    const r = reader('plan');
    r.live.noteOutput('s', '   auto mode unavailable for this model\r');
    expect(r.modes).toEqual([]);
  });
});
