// The note the app writes when the model cannot summarise a full chat (review deck 2 Q-3, 2026-11-12).
import { describe, it, expect } from 'vitest';
import { standInSummary, summaryOrStandIn, markAppGenerated } from '../src/main/harness/compaction';

const span = [
  { role: 'user', content: 'Please   tidy the\nreport folder' },
  { role: 'assistant', content: 'On it.' },
  markAppGenerated({ role: 'user', content: '[Earlier conversation summary]\nold' } as any),
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'Read', output: { type: 'text', value: 'SECRET FILE BODY' } }] },
  { role: 'user', content: 'y'.repeat(900) },
] as any;

describe('standInSummary', () => {
  it('says the app wrote it and lists only what the user asked, oldest first, shortened', () => {
    const text = standInSummary(span);
    expect(text).toMatch(/^The app wrote this note, not the model\./);
    expect(text).toContain('- Please tidy the report folder');
    expect(text).toContain(`- ${'y'.repeat(240)}…`);
    expect(text.indexOf('Please tidy')).toBeLessThan(text.indexOf('yyyy'));
    expect(text).not.toContain('SECRET FILE BODY');   // tool results are not carried over
    expect(text).not.toContain('Earlier conversation summary');   // nor messages the app itself wrote
  });
  it('stays short however long the removed part was', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ role: 'user', content: `request ${i} ${'z'.repeat(300)}` })) as any;
    const text = standInSummary(many);
    expect(text.length).toBeLessThan(2_600);
    expect(text).toContain('request 499');   // the most recent requests are the ones kept
    expect(text).not.toContain('request 0 ');
  });
});

describe('summaryOrStandIn', () => {
  const fits = (s: string) => s.length < 5_000;
  it('uses the model summary when it is usable and fits', () => {
    expect(summaryOrStandIn('a real summary', fits, span, true)).toBe('a real summary');
  });
  it('falls back to the stand-in only where allowed', () => {
    expect(summaryOrStandIn('', fits, span, true)).toMatch(/^The app wrote this note/);
    expect(summaryOrStandIn('x'.repeat(6_000), fits, span, true)).toMatch(/^The app wrote this note/);
    expect(summaryOrStandIn('', fits, span, false)).toBe('');
  });
});
