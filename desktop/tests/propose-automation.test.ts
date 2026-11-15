// The assistant proposing an automation from a chat: what becomes of its description, and who sees it.
import { describe, it, expect } from 'vitest';
import { draftFromProposal, PROPOSE_AUTOMATION_INPUT_SCHEMA, type ProposalContext } from '../src/shared/propose-automation';
import { pageNamed, watchProposals } from '../src/main/automations/propose';
import { ProposeAutomationTool } from '../src/main/harness/tools/propose-automation';
import type { PageSummary } from '../src/shared/pages-types';
import type { AutomationSummary } from '../src/shared/automation-types';
import type { TranscriptEvent } from '../src/shared/types';

const paid: ProposalContext['model'] = { name: 'gpt-x', runsOn: { runtime: 'native', providerId: 'openrouter', modelId: 'gpt-x' }, subscription: false };
const ctx = (over: Partial<ProposalContext> = {}): ProposalContext => ({ id: 'job-1', model: paid, ...over });
const money = { kind: 'page' as const, id: 'personal:money', name: 'Money' };
const good = {
  name: 'Morning money check', instruction: 'Look at yesterday’s spending and note anything unusual.',
  start: { kind: 'schedule', every: 'day', at: '7:00' }, page: 'money',
  permissions: [
    { kind: 'page-read', mode: 'allow' }, { kind: 'page-write', mode: 'ask' },
    { kind: 'folder', mode: 'allow', folder: '~/Downloads' }, { kind: 'folder', mode: 'ask', folder: '~/Downloads', change: true },
    { kind: 'command', mode: 'allow', command: 'whisper ~/Recordings/*', label: 'Turn recordings into text' },
    { kind: 'site', mode: 'allow', site: 'https://bestbuy.com/deals' },
  ],
};

describe('a proposed automation', () => {
  it('becomes a draft that is off, with a new automation’s starting settings', () => {
    const r = draftFromProposal(good, ctx({ page: money }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft).toMatchObject({
      id: 'job-1', name: 'Morning money check', enabled: false, links: [money],
      start: { kind: 'schedule', every: 'day', at: '7:00' }, model: 'gpt-x', subscription: false, limit: 5,
      whenAsk: 'wait', waitHours: null, noAnswer: 'skip', late: 'run', overlap: 'skip-new', unlisted: { sites: 'never', commands: 'never' },
      usage: { dollars: 0, tokens: 0 },
    });
    expect(r.draft.tools.map((t) => [t.kind, t.mode, t.exact, t.change ?? false, t.label])).toEqual([
      ['page-read', 'allow', undefined, false, 'Read this page’s information'],
      ['page-write', 'ask', undefined, false, 'Change this page’s information'],
      ['folder', 'allow', '~/Downloads', false, 'See the files in a folder'],
      ['folder', 'ask', '~/Downloads', true, 'Change the files in a folder'],
      ['command', 'allow', 'whisper ~/Recordings/*', false, 'Turn recordings into text'],
      ['site', 'allow', 'bestbuy.com', false, 'Visit a website'],
    ]);
  });

  it('takes nothing the screens never showed: no made-up field, never already on, no usage', () => {
    const r = draftFromProposal({ ...good, enabled: true, usage: { dollars: 0, tokens: 0 }, runsToday: 0, limit: 9999, unlisted: { sites: 'ask', commands: 'ask' }, id: '../x' }, ctx({ page: money }));
    expect(r.ok && r.draft).toMatchObject({ id: 'job-1', enabled: false, limit: 5, unlisted: { sites: 'never', commands: 'never' } });
  });

  it('a plan has no money limit, and an unclear mode asks', () => {
    const r = draftFromProposal({ name: 'A', instruction: 'B', start: { kind: 'schedule', every: 'hour', hours: 3 }, permissions: [{ kind: 'site', site: 'a.com', mode: 'whatever' }] },
      ctx({ model: { name: 'Claude Sonnet', runsOn: { runtime: 'claude', modelId: 'sonnet' }, subscription: true } }));
    expect(r.ok && r.draft.limit).toBeUndefined();
    expect(r.ok && r.draft.tools[0].mode).toBe('ask');
    expect(r.ok && r.draft.start).toEqual({ kind: 'schedule', every: 'hour', hours: 3 });
  });

  it('says what is missing instead of guessing', () => {
    const bad = (over: Record<string, unknown>, c = ctx({ page: money })) => { const r = draftFromProposal({ ...good, ...over }, c); return r.ok ? 'ok' : r.message; };
    expect(bad({ name: '  ' })).toMatch(/name/);
    expect(bad({ instruction: '' })).toMatch(/instruction/);
    expect(bad({ start: { kind: 'schedule', every: 'day', at: '7am' } })).toMatch(/24-hour/);
    expect(bad({ start: { kind: 'schedule', every: 'week', at: '7:00', day: 'Fri' } })).toMatch(/day name/);
    expect(bad({ start: { kind: 'event' } })).toMatch(/event/);
    expect(bad({ permissions: [{ kind: 'folder', mode: 'allow' }] })).toMatch(/folder/);
    expect(bad({ permissions: [{ kind: 'site', mode: 'allow', site: 'localhost' }] })).toMatch(/website/);
    // A page permission, or a page button, needs a page the person really has.
    expect(bad({}, ctx())).toMatch(/page/);
    expect(bad({ start: { kind: 'button', label: 'Make the list' }, permissions: [] }, ctx())).toMatch(/page/);
  });

  it('the tool for the app’s own models accepts the same shape and changes nothing', async () => {
    expect(ProposeAutomationTool.inputSchema.safeParse(good).success).toBe(true);
    expect(ProposeAutomationTool.inputSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
    expect(Object.keys(PROPOSE_AUTOMATION_INPUT_SCHEMA.properties).sort()).toEqual(Object.keys((ProposeAutomationTool.inputSchema as any).shape).sort());
    expect(ProposeAutomationTool.permissionSubject(good as never)).toBeUndefined();
  });
});

describe('who sees a proposal', () => {
  const pages = [{ id: 'personal:money', name: 'Money', icon: 'money' }, { id: 'project:Work:board', name: 'Work board', icon: 'list' }] as unknown as PageSummary[];
  const ev = (toolName: string, toolUseId: string, toolInput: unknown): TranscriptEvent => ({ type: 'tool-use', sessionId: 's1', uuid: toolUseId, timestamp: 1, data: { toolUseId, toolName, toolInput } } as unknown as TranscriptEvent);

  it('finds the page by the app’s id, by the page tools’ shorter id, or by its name', () => {
    expect(pageNamed(pages, 'personal:money')?.id).toBe('personal:money');
    expect(pageNamed(pages, 'money')?.id).toBe('personal:money');
    expect(pageNamed(pages, 'project:board')?.id).toBe('project:Work:board');
    expect(pageNamed(pages, 'Work board')?.id).toBe('project:Work:board');
    expect(pageNamed(pages, 'nope')).toBeUndefined();
  });

  it('shows a proposal from either kind of chat once, on the model that chat runs on', async () => {
    const shown: AutomationSummary[] = [];
    const note = watchProposals({ pages: async () => pages, modelFor: (id) => (id === 's1' ? paid : null), show: (d) => { shown.push(d); } });
    note(ev('ProposeAutomation', 't1', good));
    note(ev('ProposeAutomation', 't1', good)); // reported twice: shown once
    note(ev('mcp__youcoded-pages__ProposeAutomation', 't2', { ...good, name: 'From Claude' }));
    note(ev('Bash', 't3', { command: 'ls' }));
    note(ev('ProposeAutomation', 't4', { name: '', instruction: '' })); // unusable: nothing shown
    await expect.poll(() => shown.length).toBe(2);
    expect(shown.map((d) => [d.name, d.model, d.links[0]?.id, d.enabled])).toEqual([
      ['Morning money check', 'gpt-x', 'personal:money', false], ['From Claude', 'gpt-x', 'personal:money', false],
    ]);
    expect(new Set(shown.map((d) => d.id)).size).toBe(2);
  });
});
