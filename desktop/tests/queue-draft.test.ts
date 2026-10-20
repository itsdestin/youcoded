import { describe, it, expect } from 'vitest';
import { createQueueDraft } from '../src/renderer/state/queue-draft';
describe('synchronous queued draft authority', () => {
 it('refuses both a newer text update and attachment-only draft before deferred React rendering', () => {
  const draft=createQueueDraft('s');const before=draft.snapshot();draft.text('new words');expect(draft.fill(before,'old',['/tmp/a.png'])).toBe(false);
  draft.text('');const empty=draft.snapshot();draft.files(['/tmp/new.png']);expect(draft.snapshot().empty).toBe(false);expect(draft.fill(empty,'old',[])).toBe(false);
 });
 it('transfers exact files/text once and rejects a session switch or another in-flight edit', () => {
  const draft=createQueueDraft('s');const before=draft.snapshot();expect(draft.fill(before,'é\nexact',['/tmp/image.png'])).toBe(true);expect(draft.fill(before,'second',[])).toBe(false);
  draft.session('other');expect(draft.fill(before,'old',[])).toBe(false);
 });
});
