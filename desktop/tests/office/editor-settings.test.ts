import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanEditorSettings, isEditorSettingKey, readEditorSettings, saveEditorSettings } from '../../src/main/office/editor-settings';

// Finish plan Task 4: the editors' own settings (File → Advanced settings, the view toggles)
// outlive the document's one-time office://<token> origin. Only settings keys are kept.
describe('editor settings', () => {
  let userData: string;
  beforeEach(async () => { userData = await mkdtemp(path.join(tmpdir(), 'office-editor-settings-')); });
  afterEach(async () => { await rm(userData, { recursive: true, force: true, maxRetries: 3 }); });

  it('round trip: what an editor changed is what the next document starts with', async () => {
    await saveEditorSettings(userData, { 'de-settings-unit': '1', 'sse-settings-r1c1': '1', 'pe-settings-showgrid': '0', 'de-hidden-status': '1' });
    await saveEditorSettings(userData, { 'de-settings-spellcheck': '0', 'de-settings-unit': '2' });
    expect(await readEditorSettings(userData)).toEqual({
      'de-settings-unit': '2', 'sse-settings-r1c1': '1', 'pe-settings-showgrid': '0', 'de-hidden-status': '1', 'de-settings-spellcheck': '0',
    });
    // A setting put back to the editor's default (removed from storage) is forgotten.
    await saveEditorSettings(userData, { 'de-settings-unit': null });
    expect(await readEditorSettings(userData)).not.toHaveProperty('de-settings-unit');
  });

  it('keys outside the allow-list are dropped — theme, identity, recent lists, anything unknown', async () => {
    await saveEditorSettings(userData, {
      'de-settings-zoom': '100',
      'ui-theme-id': 'theme-dark', 'content-theme': 'dark', 'settings-tab-style': 'line',
      'guest-username': 'Destin', 'guest-id': 'uid-1',
      'de-recent-shapes': '[1]', 'de-settings-recent-fonts': 'Arial', 'de-recentSymbols': 'x',
      'de-settings-math-correct-add': '[["a","b"]]',
      'de-hidden-rulers': '0', 'de-settings-autosave': '0', 'de-macros-mode': '1',
      'asc.document.body': 'the document text',
    });
    expect(await readEditorSettings(userData)).toEqual({ 'de-settings-zoom': '100' });
    expect(isEditorSettingKey('ui-theme')).toBe(false);
    expect(isEditorSettingKey('toString')).toBe(false);
  });

  it('drops values that are not short plain strings', () => {
    expect(cleanEditorSettings({ 'de-settings-unit': 1, 'de-settings-zoom': 'x'.repeat(65), 'pe-settings-unit': '0', 'sse-settings-unit': null }))
      .toEqual({ 'pe-settings-unit': '0', 'sse-settings-unit': null });
    expect(cleanEditorSettings(null)).toEqual({});
    expect(cleanEditorSettings(['de-settings-unit'])).toEqual({});
  });

  it('a file edited by hand keeps only its allowed keys, and an unreadable one starts over', async () => {
    const file = path.join(userData, 'office-editor-settings.json');
    await writeFile(file, JSON.stringify({ settings: { 'de-settings-unit': '1', 'guest-username': 'someone' } }));
    expect(await readEditorSettings(userData)).toEqual({ 'de-settings-unit': '1' });
    await writeFile(file, '{not json');
    expect(await readEditorSettings(userData)).toEqual({});
    await saveEditorSettings(userData, { 'de-settings-unit': '0' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ settings: { 'de-settings-unit': '0' } });
  });

  it('writes nothing when nothing allowed changed', async () => {
    await saveEditorSettings(userData, { 'guest-username': 'x' });
    await expect(readFile(path.join(userData, 'office-editor-settings.json'))).rejects.toThrow();
  });
});
