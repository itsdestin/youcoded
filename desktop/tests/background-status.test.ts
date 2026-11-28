import { describe, it, expect } from 'vitest';
import { BackgroundStatusTracker, describeAsk, statusText } from '../src/main/background-status';
import type { SessionSummary } from '../src/shared/session-summary-types';

const sum = (o: Partial<SessionSummary> = {}): SessionSummary =>
  ({ working: false, awaitingCount: 0, attention: 'ok', hasHistory: true, queuedCount: 0, started: true, ...o });

function make() {
  const t = new BackgroundStatusTracker();
  let foreground = false;
  let watching = new Set<string>();
  const run = (summaries: Record<string, SessionSummary>) => t.update({
    summaries, foreground, watched: (id) => watching.has(id),
    nameOf: (id) => `Name ${id}`, askTextOf: () => 'Wants to run: ls',
  });
  return { run, setForeground: (v: boolean) => { foreground = v; }, watch: (...ids: string[]) => { watching = new Set(ids); } };
}

describe('statusText', () => {
  it('shows only non-zero parts, or Ready', () => {
    expect(statusText(0, 0, 0)).toBe('Ready');
    expect(statusText(2, 1, 3)).toBe('2 working · 1 waiting for you · 3 done');
    expect(statusText(0, 0, 1)).toBe('1 done');
  });
});

describe('BackgroundStatusTracker', () => {
  it('counts working and waiting sessions, and lists who needs you', () => {
    const m = make();
    const s = m.run({ a: sum({ working: true }), b: sum({ working: true, awaitingCount: 1 }), c: sum() });
    expect(s).toMatchObject({ working: 1, waiting: 1, done: 0, text: '1 working · 1 waiting for you' });
    expect(s.needs).toEqual([{ sessionId: 'b', name: 'Name b', text: 'Wants to run: ls' }]);
  });

  it('marks a session done when its turn ends off screen, and clears it when looked at', () => {
    const m = make();
    m.run({ a: sum({ working: true }) });
    expect(m.run({ a: sum() }).text).toBe('1 done');
    m.setForeground(true); m.watch('a');
    expect(m.run({ a: sum() }).text).toBe('Ready');
  });

  it('does not mark done a session you are watching on screen, or one that is just idle', () => {
    const m = make();
    m.setForeground(true); m.watch('a');
    m.run({ a: sum({ working: true }), b: sum() });
    expect(m.run({ a: sum(), b: sum() }).done).toBe(0);
  });

  it('app on screen but a different session watched: still done', () => {
    const m = make();
    m.setForeground(true); m.watch('b');
    m.run({ a: sum({ working: true }), b: sum() });
    expect(m.run({ a: sum(), b: sum() }).done).toBe(1);
  });

  it('a new turn or a closed session clears done', () => {
    const m = make();
    m.run({ a: sum({ working: true }), b: sum({ working: true }) });
    expect(m.run({ a: sum(), b: sum() }).done).toBe(2);
    expect(m.run({ a: sum({ working: true }) }).done).toBe(0);
  });

  it('answering clears the needs-you entry', () => {
    const m = make();
    expect(m.run({ a: sum({ awaitingCount: 1 }) }).needs).toHaveLength(1);
    expect(m.run({ a: sum() }).needs).toHaveLength(0);
  });
});

describe('describeAsk', () => {
  it('reads commands, files, questions and falls back', () => {
    expect(describeAsk({ payload: { tool_name: 'Bash', tool_input: { command: 'rm x' } } })).toBe('Wants to run: rm x');
    expect(describeAsk({ payload: { tool_name: 'Edit', tool_input: { file_path: '/a/b.ts' } } })).toBe('Wants to change b.ts');
    expect(describeAsk({ payload: { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which one?' }] } } })).toBe('Which one?');
    expect(describeAsk(undefined)).toBe('Waiting for your approval');
    expect(describeAsk({ payload: { tool_name: 'Bash', tool_input: { command: 'x'.repeat(300) } } }).length).toBe(120);
  });
});
