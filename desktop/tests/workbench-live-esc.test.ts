import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readSource } from './helpers/guard-scope';

describe('live Workbench popup dismissal', () => {
  it('mounts the same Escape stack provider as the app around real popup candidates', () => {
    // WHY: useEscClose deliberately soft-fails without its provider. A review
    // pane must not silently make every real popup appear broken on Escape.
    const source = readSource(join(__dirname, '..', 'src', 'renderer', 'index.tsx'));
    const live = source.split("if (__view === 'live') {")[1]?.split('// Attachment-chip page')[0];
    expect(live).toContain("import('./hooks/use-esc-close')");
    expect(live).toContain('<EscCloseProvider><LiveCandidate /></EscCloseProvider>');
  });
});
