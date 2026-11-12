import { describe, it, expect } from 'vitest';
import { AskUserQuestionTool } from '../src/main/harness/tools/ask-user-question';

describe('AskUserQuestion header limit', () => {
  const q = (header: string) => ({ questions: [{ question: 'Where?', header, options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] });
  it('trims a header that is a little too long instead of rejecting the call', () => {
    const r = (AskUserQuestionTool.inputSchema as any).safeParse(q('Save location'));
    expect(r.success).toBe(true);
    expect(r.data.questions[0].header).toBe('Save locatio');
  });
  it('still rejects an empty header', () => {
    expect((AskUserQuestionTool.inputSchema as any).safeParse(q('')).success).toBe(false);
  });
});
