// @vitest-environment jsdom
// A page's own automation button: what the page is told, and what it may start.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { handlePageAutomationMessage, pageAutomationStates, PAGE_AUTOMATION_MESSAGE, PAGE_AUTOMATION_RESULT_MESSAGE, PAGE_AUTOMATIONS_STATE_MESSAGE } from '../src/renderer/components/pages/page-automations-host';
import type { AutomationSummary } from '../src/shared/automation-types';

const job = (over: Partial<AutomationSummary>): AutomationSummary => ({
  id: 'one', name: 'Shopping list', instruction: 'x', links: [{ kind: 'page', id: 'p1', name: 'Recipes' }], start: { kind: 'button', label: 'Run' }, model: 'm', subscription: true,
  tools: [], whenAsk: 'wait', waitHours: null, noAnswer: 'skip', late: 'run', overlap: 'skip-new',
  unlisted: { sites: 'never', commands: 'never' }, devices: [], notify: { needs: false, news: false, fails: false },
  enabled: true, usage: { dollars: 0, tokens: 0 }, ...over,
});
const run = (outcome: 'running' | 'done') => ({ id: 'r', when: 'Today at 7:00', outcome, summary: '', tokens: 0, seconds: 0 });

afterEach(() => { delete (window as unknown as { claude?: unknown }).claude; });

function frame() {
  const posted: any[] = [];
  return { posted, win: { postMessage: (m: unknown) => { posted.push(m); } } as unknown as Window };
}

describe("a page's automation button", () => {
  it('tells a page only about automations linked to it, with their state', () => {
    const jobs = [
      job({}),
      job({ id: 'two', name: 'Going', lastRun: run('running') }),
      job({ id: 'three', name: 'Waiting', lastRun: run('running'), waiting: { runId: 'r', action: 'Send', asked: 'Asked just now', until: '' } }),
      job({ id: 'four', name: 'Capped', maxRunsPerDay: 20, runsToday: 20 }),
      job({ id: 'five', name: 'Elsewhere', links: [{ kind: 'page', id: 'other', name: 'Other' }] }),
    ];
    expect(pageAutomationStates(jobs, 'p1')).toEqual([
      { id: 'one', name: 'Shopping list', state: 'idle' },
      { id: 'two', name: 'Going', state: 'running' },
      { id: 'three', name: 'Waiting', state: 'waiting', message: 'Waiting for your OK' },
      { id: 'four', name: 'Capped', state: 'limit', message: 'Daily limit reached. 20 of 20 runs today. It can run again tomorrow.' },
    ]);
  });

  it('answers a list request with the states', () => {
    const { posted, win } = frame();
    expect(handlePageAutomationMessage({ type: PAGE_AUTOMATION_MESSAGE, id: 'g1', op: 'list' }, win, 'p1', [job({})])).toBe(true);
    expect(posted[0]).toEqual({ type: PAGE_AUTOMATIONS_STATE_MESSAGE, jobs: [{ id: 'one', name: 'Shopping list', state: 'idle' }] });
    expect(posted[1]).toEqual({ type: PAGE_AUTOMATION_RESULT_MESSAGE, id: 'g1', result: { ok: true } });
  });

  it("starts through the app with the app's own page id, and passes back why it did not start", async () => {
    const pageStart = vi.fn(async () => ({ ok: false, message: 'Daily limit reached.' }));
    (window as unknown as { claude: unknown }).claude = { automations: { pageStart } };
    const { posted, win } = frame();
    // The page's code cannot name another page: whatever it sends, the id used is the loaded page's.
    handlePageAutomationMessage({ type: PAGE_AUTOMATION_MESSAGE, id: 'g2', op: 'run', job: 'Shopping list', pageId: 'someone-else' } as never, win, 'p1', []);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(pageStart).toHaveBeenCalledWith('p1', { job: 'Shopping list' });
    expect(posted[0]).toEqual({ type: PAGE_AUTOMATION_RESULT_MESSAGE, id: 'g2', result: { ok: false, message: 'Daily limit reached.' } });
  });

  it('sends an event with its information, and refuses too much of it', async () => {
    const pageStart = vi.fn(async () => ({ ok: true }));
    (window as unknown as { claude: unknown }).claude = { automations: { pageStart } };
    const { posted, win } = frame();
    handlePageAutomationMessage({ type: PAGE_AUTOMATION_MESSAGE, id: 'g3', op: 'event', event: 'list-changed', data: '{"n":3}' }, win, 'p1', []);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(pageStart).toHaveBeenCalledWith('p1', { event: 'list-changed', data: '{"n":3}' });
    handlePageAutomationMessage({ type: PAGE_AUTOMATION_MESSAGE, id: 'g4', op: 'event', event: 'x', data: 'a'.repeat(20_001) }, win, 'p1', []);
    expect(posted[1].result.ok).toBe(false);
    expect(pageStart).toHaveBeenCalledTimes(1);
  });

  it('leaves every other message alone', () => {
    expect(handlePageAutomationMessage({ type: 'youcoded:program', id: 'g5' }, frame().win, 'p1', [])).toBe(false);
  });
});
