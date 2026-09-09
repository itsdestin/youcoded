import { describe, it, expect } from 'vitest';
import { sharedDoctrine } from '../src/main/harness/prompts/shared-doctrine';

// The doctrine is composed by flags that are fixed per session. Each flag has a
// reason to exist; each test pins the reason, not the wording.
const FULL = { audience: 'user' as const, tools: true, batching: true, compact: false };

describe('sharedDoctrine — composition', () => {
  it('full user doctrine carries every section and the tool-preference sentence the assembly test looks for', () => {
    const d = sharedDoctrine(FULL);
    for (const h of ['Working rules, every conversation:', 'Before you finish:', 'How you write:', 'Messages you may see:', 'Git:']) expect(d).toContain(h);
    expect(d).toContain('Prefer dedicated tools over shell');
    expect(d).toContain('<untrusted-content>');
    expect(d).toContain('<steer>');
    expect(d).not.toContain('<specialists-status>');   // retired 2026-09-09: status is on demand (Task list: true)
  });

  it('batching is sent ONLY when the flag says the runtime runs calls in parallel', () => {
    expect(sharedDoctrine(FULL)).toContain('request them in one turn');
    expect(sharedDoctrine({ ...FULL, batching: false })).not.toContain('request them in one turn');
  });

  it('a specialist (audience parent) gets no writing-for-the-user block and no "last message" rule', () => {
    const d = sharedDoctrine({ ...FULL, audience: 'parent' });
    expect(d).not.toContain('How you write:');
    expect(d).not.toContain('one of three things');
    expect(d).not.toContain('<specialists-status>');
    // …but keeps the parts that apply to any model doing work
    expect(d).toContain('Keep going until the task is done');
    expect(d).toContain('<untrusted-content>');
  });

  it('a tool-less model keeps honesty and writing, drops every tool sentence', () => {
    const d = sharedDoctrine({ ...FULL, tools: false, batching: false });
    expect(d).not.toContain('Working rules, every conversation:');
    expect(d).not.toContain('Prefer dedicated tools');
    expect(d).not.toContain('<untrusted-content>');
    expect(d).not.toContain('Git:');
    expect(d).toContain('Before you finish:');
    expect(d).toContain('How you write:');
  });

  it('compact (small local model) is the same rules in far fewer words, never with the batching line', () => {
    const full = sharedDoctrine(FULL);
    const compact = sharedDoctrine({ ...FULL, compact: true, batching: false });
    expect(compact.split(/\s+/).length).toBeLessThan(full.split(/\s+/).length / 2);
    expect(compact).toContain('Prefer dedicated tools over shell');
    expect(compact).toContain('Keep going until the task is done');
    expect(compact).toContain('<untrusted-content>');
    expect(compact).not.toContain('request them in one turn');
  });

  it('is byte-identical for identical flags (prefix-cache safety)', () => {
    expect(sharedDoctrine(FULL)).toBe(sharedDoctrine({ ...FULL }));
  });
});

describe('sharedDoctrine — question vs action (Destin, 2026-09-05)', () => {
  it('the root session is told not to change anything unless the user clearly expects it, in both sizes', () => {
    expect(sharedDoctrine(FULL)).toContain('unless the user unambiguously expects you to');
    expect(sharedDoctrine({ ...FULL, compact: true, batching: false })).toContain('A question ends in an answer, not an edit');
  });
  it('a specialist is not — it always works toward a task it was given', () => {
    expect(sharedDoctrine({ ...FULL, audience: 'parent' })).not.toContain('unambiguously expects');
  });
});

describe('sharedDoctrine — consolidation review (Destin, 2026-09-05)', () => {
  it('the visual-review rule reaches every audience and both sizes', () => {
    expect(sharedDoctrine(FULL)).toContain('check the finished result the way the user will see it');
    expect(sharedDoctrine({ ...FULL, audience: 'parent' })).toContain('check the finished result the way the user will see it');
    expect(sharedDoctrine({ ...FULL, compact: true, batching: false })).toContain('look at the result as the user will see it');
  });
  it('planning is said once, to the root session, with the threshold', () => {
    expect(sharedDoctrine(FULL)).toContain('never make a one-item plan');
    expect(sharedDoctrine({ ...FULL, audience: 'parent' })).not.toContain('TodoWrite');
  });
  it('the writing block is Destin\'s wording', () => {
    expect(sharedDoctrine(FULL)).toContain('optimize responses for glanceability');
  });
});

describe('sharedDoctrine — capability assumption (Destin, 2026-09-05)', () => {
  it('every audience is told to find a way before declining, in both sizes', () => {
    expect(sharedDoctrine(FULL)).toContain('Assume you can do whatever the user asks');
    expect(sharedDoctrine({ ...FULL, audience: 'parent' })).toContain('Assume you can do whatever the user asks');
    expect(sharedDoctrine({ ...FULL, compact: true, batching: false })).toContain('Assume you can do what the user asks');
  });
  it('a tool-less model is NOT told to reach for tools it does not have', () => {
    expect(sharedDoctrine({ ...FULL, tools: false, batching: false })).not.toContain('Assume you can do');
  });
});
