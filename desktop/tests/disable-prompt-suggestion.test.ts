import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { enforcePromptSuggestionDisabled } = await import('../src/main/disable-prompt-suggestion');

describe('enforcePromptSuggestionDisabled', () => {
  let tmpHome: string;
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-disable-suggest-'));
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome;
  });

  afterEach(() => {
    (os as any).homedir = origHomedir;
    try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  });

  function settingsFile() {
    return path.join(tmpHome, '.claude', 'settings.json');
  }
  function readSettings(): any {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  }

  it('writes the key when settings.json does not exist', async () => {
    const result = await enforcePromptSuggestionDisabled();
    expect(result.changed).toBe(true);
    expect(result.prior).toBeUndefined();
    expect(readSettings().promptSuggestionEnabled).toBe(false);
  });

  it('flips the key from true → false', async () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ promptSuggestionEnabled: true, theme: 'dark' }, null, 2),
    );

    const result = await enforcePromptSuggestionDisabled();

    expect(result.changed).toBe(true);
    expect(result.prior).toBe(true);
    const after = readSettings();
    expect(after.promptSuggestionEnabled).toBe(false);
    expect(after.theme).toBe('dark');
  });

  it('inserts the key when absent (CC default of enabled)', async () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ theme: 'dark', model: 'sonnet' }, null, 2),
    );

    const result = await enforcePromptSuggestionDisabled();

    expect(result.changed).toBe(true);
    expect(result.prior).toBeUndefined();
    const after = readSettings();
    expect(after.promptSuggestionEnabled).toBe(false);
    expect(after.theme).toBe('dark');
    expect(after.model).toBe('sonnet');
  });

  it('is a no-op when already false (does not rewrite)', async () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    const original = JSON.stringify({ promptSuggestionEnabled: false, theme: 'dark' }, null, 2);
    fs.writeFileSync(settingsFile(), original);
    const mtimeBefore = fs.statSync(settingsFile()).mtimeMs;

    const result = await enforcePromptSuggestionDisabled();

    expect(result.changed).toBe(false);
    expect(result.prior).toBe(false);
    // File untouched on no-op — same bytes, same mtime (within filesystem
    // resolution we sleep-bypass by reading the contents back).
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(original);
    expect(fs.statSync(settingsFile()).mtimeMs).toBe(mtimeBefore);
  });

  it('preserves all other settings when flipping', async () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    const settings = {
      model: 'sonnet',
      hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo hi' }] }] },
      enabledPlugins: { 'foo@youcoded': true },
      statusLine: { type: 'command', command: 'bash status.sh' },
    };
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));

    await enforcePromptSuggestionDisabled();

    const after = readSettings();
    expect(after.model).toBe('sonnet');
    expect(after.hooks.SessionStart[0].hooks[0].command).toBe('echo hi');
    expect(after.enabledPlugins['foo@youcoded']).toBe(true);
    expect(after.statusLine.command).toBe('bash status.sh');
    expect(after.promptSuggestionEnabled).toBe(false);
  });

  // WHY this inverted (2026-09-16 audit D5): the old module treated an
  // unparseable file as empty and wrote a fresh one over it — wiping the hooks
  // and enabledPlugins a corrupt file still visibly carried. Every writer now
  // refuses; see claude-settings.ts.
  it('refuses to overwrite an unparseable settings.json', async () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(settingsFile(), '{not valid json');

    const result = await enforcePromptSuggestionDisabled();

    expect(result.changed).toBe(false);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('{not valid json');
  });
});
