import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps remote Info available in the preview, and gates its body on a rendered view', () => {
  // WHY: unknown Workbench APIs return callable proxies/Promises, so API
  // truthiness is not evidence that the preview actually rendered. The Info
  // action itself always stays — round-1 review rejected removing controls.
  const source = readFileSync(new URL('../src/renderer/components/SettingsPanel.tsx', import.meta.url), 'utf8');
  expect(source).toContain('headerActions={showInfo ? undefined');
  expect(source).toContain('{showInfo ? (previewView ?');
  expect(source).not.toContain('{showInfo ? (preview ?');
});
