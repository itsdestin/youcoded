import { expect, it } from 'vitest';
import { validateHandoffDraft } from '../src/shared/handoff-draft';

it('validates a bounded local detached draft with attachment paths before transfer', () => {
  expect(validateHandoffDraft({ text: 'unsent', attachments: ['/project/shot.png'] }))
    .toEqual({ text: 'unsent', attachments: ['/project/shot.png'] });
  expect(validateHandoffDraft({ text: '', attachments: [] })).toEqual({ text: '', attachments: [] });
  expect(validateHandoffDraft({ text: 'a', attachments: ['bad\0path'] })).toBeNull();
  expect(validateHandoffDraft({ text: 'x'.repeat(1_000_001), attachments: [] })).toBeNull();
  expect(validateHandoffDraft({ text: '', attachments: new Array(101).fill('/project/f') })).toBeNull();
});
