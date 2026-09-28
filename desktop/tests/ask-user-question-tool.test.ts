import { describe, it, expect } from 'vitest';
import { AskUserQuestionTool, formatAnswers } from '../src/main/harness/tools/ask-user-question';

const q = (over: Partial<any> = {}) => ({
  question: 'Which color?', header: 'Color', multiSelect: false,
  options: [{ label: 'Blue' }, { label: 'Red', description: 'bold choice' }], ...over,
});

describe('AskUserQuestion schema', () => {
  it('accepts the CC shape', () => {
    expect(AskUserQuestionTool.inputSchema.safeParse({ questions: [q()] }).success).toBe(true);
  });
  it('rejects zero questions, >4 questions, <2 options', () => {
    expect(AskUserQuestionTool.inputSchema.safeParse({ questions: [] }).success).toBe(false);
    expect(AskUserQuestionTool.inputSchema.safeParse({ questions: [q(), q(), q(), q(), q()] }).success).toBe(false);
    expect(AskUserQuestionTool.inputSchema.safeParse({ questions: [q({ options: [{ label: 'only' }] })] }).success).toBe(false);
  });
  it('is marked interactive with no permission subject', () => {
    expect(AskUserQuestionTool.interactive).toBe(true);
    expect(AskUserQuestionTool.permissionSubject({ questions: [q()] } as any)).toBeUndefined();
  });
});

describe('formatAnswers', () => {
  it('uses ordered native answers for repeated wording and the original question order', () => {
    const questions = [q({ header: 'First' }), q({ header: 'Second', options: [{ label: 'Green' }, { label: 'Yellow' }] })];
    const text = formatAnswers({ questions } as any, { questions: [q({ question: 'FAKE' })],
      answers: { 'Which color?': 'WRONG' }, orderedAnswers: [
        { answer: 'Blue', note: 'lighter' }, { answer: 'teal', note: '' },
      ] });
    expect(text).toBe('The user answered:\n\nQ: Which color?\nA: Blue\nNote from the user: lighter\n\nQ: Which color?\nA (the user typed their own answer): teal');
    expect(text).not.toContain('FAKE');
  });

  it('falls back to the legacy answer map for malformed ordered arrays', () => {
    const questions = [q(), q({ question: 'Size?', header: 'Size' })];
    for (const orderedAnswers of [[{ answer: 'Blue' }], [{ answer: 42 }, { answer: 'Large' }],
      [{ answer: 'Blue', note: 12 }, { answer: 'Large' }],
      [{ answer: ['Blue', 4] }, { answer: 'Large' }], 'bad', null]) {
      expect(formatAnswers({ questions } as any, { answers: { 'Which color?': 'Red', 'Size?': 'Small' }, orderedAnswers }))
        .toBe('The user answered:\n\nQ: Which color?\nA: Red\n\nQ: Size?\nA (the user typed their own answer): Small');
    }
    expect(() => formatAnswers({ questions } as any, { orderedAnswers: [{ answer: 'Blue' }, { answer: 'Large' }] })).not.toThrow();
  });
  it('pairs each question with its answer', () => {
    const text = formatAnswers({ questions: [q(), q({ question: 'Size?', header: 'Size' })] } as any,
      { questions: [], answers: { 'Which color?': 'Blue', 'Size?': 'Large, Medium' } });
    expect(text).toContain('Which color?');
    expect(text).toContain('Blue');
    expect(text).toContain('Large, Medium');
  });
  it('marks unanswered questions instead of dropping them', () => {
    const text = formatAnswers({ questions: [q()] } as any, { questions: [], answers: {} });
    expect(text).toMatch(/no selection|did not answer/i);
  });
  it('is TOTAL on untrusted answer shapes (array / number) — never throws, produces a sensible pairing', () => {
    // updatedInput is UNTRUSTED (renderer AND remote WS clients). An array is the
    // natural way a client might encode a multi-select answer; a number is junk.
    // A throw here would skip the role:'tool' history push → dangling tool_call →
    // bricked session. formatAnswers MUST stay total.
    let text = '';
    expect(() => {
      text = formatAnswers(
        { questions: [q(), q({ question: 'Size?', header: 'Size' })] } as any,
        { questions: [], answers: { 'Which color?': ['Blue', 'Red'], 'Size?': 5 } },
      );
    }).not.toThrow();
    expect(text).toContain('Blue, Red');                 // array joined
    expect(text).toMatch(/Size\?/);                       // still paired
    expect(text).toMatch(/no selection|did not answer/i); // number → fallback
  });
  it('does not throw when answers itself is not an object (null / array)', () => {
    expect(() => formatAnswers({ questions: [q()] } as any, { questions: [], answers: null as any })).not.toThrow();
    expect(() => formatAnswers({ questions: [q()] } as any, { questions: [], answers: [] as any })).not.toThrow();
    expect(() => formatAnswers({ questions: [q()] } as any, undefined)).not.toThrow();
  });
});

// Ledger G-2 (2026-08-26 harness comparison): the card can send a typed "Other"
// answer and a per-question note. The model must be able to tell an own answer
// from a listed label, and must see the note.
describe('formatAnswers — Other and notes (G-2)', () => {
  it('flags an answer that is not one of the listed labels as the user\'s own', () => {
    const text = formatAnswers({ questions: [q()] } as any,
      { questions: [], answers: { 'Which color?': 'teal, but only on the sidebar' } });
    expect(text).toContain('typed their own answer');
    expect(text).toContain('teal, but only on the sidebar');
  });
  it('does NOT flag a listed label (or a multi-select of listed labels) as an own answer', () => {
    const text = formatAnswers({ questions: [q()] } as any,
      { questions: [], answers: { 'Which color?': 'Blue, Red' } });
    expect(text).not.toContain('typed their own answer');
  });
  it('appends the note when a listed option was chosen with a note', () => {
    const text = formatAnswers({ questions: [q()] } as any,
      { questions: [], answers: { 'Which color?': 'Blue' }, notes: { 'Which color?': 'but a lighter shade' } });
    expect(text).toContain('A: Blue');
    expect(text).toContain('Note from the user: but a lighter shade');
  });
  it('ignores notes that are not non-empty strings, and a non-object notes map', () => {
    const t1 = formatAnswers({ questions: [q()] } as any,
      { questions: [], answers: { 'Which color?': 'Blue' }, notes: { 'Which color?': 42 } });
    expect(t1).not.toContain('Note from the user');
    const t2 = formatAnswers({ questions: [q()] } as any,
      { questions: [], answers: { 'Which color?': 'Blue' }, notes: ['junk'] });
    expect(t2).not.toContain('Note from the user');
    expect(() => formatAnswers({ questions: [q()] } as any, { questions: [], answers: {}, notes: null })).not.toThrow();
  });
});
