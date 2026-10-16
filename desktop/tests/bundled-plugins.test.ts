import { describe, it, expect } from 'vitest';
import { BUNDLED_PLUGIN_IDS } from '../src/shared/bundled-plugins';

// Android clean rebuild (2026-10-14): the phone runs the desktop backend, so there is one
// bundled-plugin list (src/shared/bundled-plugins.ts) and no Kotlin mirror to keep in sync.
describe('bundled plugin list', () => {
  it('includes chatsearch', () => {
    expect([...BUNDLED_PLUGIN_IDS]).toContain('youcoded-chatsearch');
  });
});
