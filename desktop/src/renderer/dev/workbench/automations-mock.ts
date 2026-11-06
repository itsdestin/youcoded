// `window.claude.automations` for the workbench — pages-finish step 4, design stage.
//
// WHY a fake with nothing real behind it: the screens come first (feature flow), and this is the
// only thing that answers until the runner exists. Every channel is listed in mock-only.ts, so it
// can never pass as built. The six jobs are the six examples Destin picked on the step 4 questions
// deck (Q-uses: "basically any of these"), each set up the way his answers say it would be.
import type { AutomationRun, AutomationSummary, AutomationsBridge } from '../../../shared/automation-types';

function seedJobs(): AutomationSummary[] {
  return [
    {
      id: 'job-email', name: 'Email sorter',
      instruction: 'When an email arrives, put it under the right label and draft a reply if it needs one. Never send anything without asking me.',
      owner: { kind: 'alone' }, start: { kind: 'event', event: 'An email arrives in Gmail' },
      model: 'GPT-5 mini', subscription: false,
      tools: [
        { id: 't-read', label: 'Read your email', source: 'Gmail', mode: 'allow' },
        { id: 't-label', label: 'Label an email', source: 'Gmail', mode: 'allow' },
        { id: 't-draft', label: 'Write a draft reply', source: 'Gmail', mode: 'allow' },
        { id: 't-send', label: 'Send an email', source: 'Gmail', mode: 'ask' },
      ],
      whenAsk: 'wait', waitHours: 12, noAnswer: 'skip', late: 'run',
      notify: { needs: true, news: false, fails: true }, limit: 5, enabled: true,
      usage: { dollars: 1.84, tokens: 612_000 },
      lastRun: { id: 'r-e1', when: 'Today at 9:12', outcome: 'waiting', summary: 'Labelled it "Plans" and drafted a reply to Sam Lee.', dollars: 0.02, tokens: 6_400, seconds: 14 },
      waiting: {
        runId: 'r-e1', action: 'Send a reply to Sam Lee',
        detail: 'Hi Sam, Thursday at 3 works for me. See you then. Destin',
        asked: 'Asked 2 h ago', until: 'If you don’t answer by 9:12 tonight, it leaves the draft unsent.',
      },
    },
    {
      id: 'job-money', name: 'Morning money check',
      instruction: 'Look at yesterday’s spending on this page. If anything looks unusual, write a short note at the top and tell me.',
      owner: { kind: 'page', pageId: 'page-money', pageName: 'Money', pageIcon: 'money' },
      start: { kind: 'schedule', every: 'day', at: '7:00' },
      model: 'Claude Sonnet', subscription: true,
      tools: [
        { id: 't-pread', label: 'Read this page’s information', source: 'Money', mode: 'allow' },
        { id: 't-pnote', label: 'Write a note on this page', source: 'Money', mode: 'allow' },
      ],
      whenAsk: 'skip', waitHours: null, noAnswer: 'skip', late: 'run',
      notify: { needs: true, news: true, fails: true }, enabled: true,
      usage: { dollars: 0, tokens: 182_000 }, next: 'Tomorrow at 7:00',
      lastRun: { id: 'r-m1', when: 'Today at 7:00', outcome: 'news', summary: 'Flagged a $214 charge at Best Buy, about four times your usual there.', tokens: 9_100, seconds: 22 },
    },
    {
      id: 'job-shopping', name: 'Shopping list',
      instruction: 'Read this week’s meals on this page and write one shopping list, grouped by aisle, leaving out what’s already in the pantry list.',
      owner: { kind: 'page', pageId: 'page-recipes', pageName: 'Recipe notes', pageIcon: 'notes' },
      start: { kind: 'button', label: 'Make this week’s shopping list' },
      model: 'Claude Haiku', subscription: true,
      tools: [
        { id: 't-rread', label: 'Read this page’s information', source: 'Recipe notes', mode: 'allow' },
        { id: 't-rwrite', label: 'Change this page’s information', source: 'Recipe notes', mode: 'allow' },
      ],
      whenAsk: 'skip', waitHours: null, noAnswer: 'skip', late: 'skip',
      notify: { needs: true, news: false, fails: true }, enabled: true,
      usage: { dollars: 0, tokens: 41_000 },
      lastRun: { id: 'r-s1', when: 'Sunday at 18:40', outcome: 'done', summary: 'Made a list of 23 items in 6 aisles.', tokens: 7_800, seconds: 11 },
    },
    {
      id: 'job-weekly', name: 'Friday wrap-up',
      instruction: 'Summarise what I worked on this week from my chat list into the Weekly briefing page: what got done, what is still open, what to start Monday.',
      owner: { kind: 'page', pageId: 'page-weekly-briefing', pageName: 'Weekly briefing', pageIcon: 'notes' },
      start: { kind: 'schedule', every: 'week', day: 'Friday', at: '17:00' },
      model: 'Claude Sonnet', subscription: true,
      tools: [
        { id: 't-chats', label: 'Read your chat list and chat names', source: 'YouCoded', mode: 'allow' },
        { id: 't-wwrite', label: 'Change this page’s information', source: 'Weekly briefing', mode: 'allow' },
      ],
      whenAsk: 'wait', waitHours: null, noAnswer: 'skip', late: 'run',
      notify: { needs: true, news: true, fails: true }, enabled: true,
      usage: { dollars: 0, tokens: 96_000 }, next: 'Friday at 17:00',
      lastRun: { id: 'r-w1', when: 'Friday at 17:00', outcome: 'done', summary: 'Wrote this week’s briefing: 9 things done, 4 still open.', tokens: 31_000, seconds: 48 },
    },
    {
      id: 'job-price', name: 'Headphones price watch',
      instruction: 'Check the price of the Sony WH-1000XM6 on bestbuy.com. Tell me only when it is under $200.',
      owner: { kind: 'alone' }, start: { kind: 'schedule', every: 'hour', hours: 3 },
      model: 'Gemini Flash', subscription: false,
      tools: [
        { id: 't-visit', label: 'Visit one website', source: 'Internet', mode: 'allow', exact: 'bestbuy.com' },
      ],
      whenAsk: 'skip', waitHours: null, noAnswer: 'skip', late: 'skip',
      notify: { needs: true, news: true, fails: false }, limit: 5, enabled: false,
      usage: { dollars: 0.31, tokens: 204_000 },
      lastRun: { id: 'r-p1', when: 'Yesterday at 15:00', outcome: 'done', summary: 'Still $249. Nothing to tell you.', dollars: 0.004, tokens: 3_200, seconds: 6 },
    },
    {
      id: 'job-tidy', name: 'Downloads tidy-up',
      instruction: 'Sort my Downloads folder into Documents, Pictures, Installers and Other. Ask before moving anything you are not sure about.',
      owner: { kind: 'alone' }, start: { kind: 'schedule', every: 'day', at: '2:00' },
      model: 'Claude Haiku', subscription: true,
      tools: [
        { id: 't-list', label: 'See the files in a folder', source: 'Your computer', mode: 'allow', exact: '~/Downloads' },
        { id: 't-move', label: 'Move files within a folder', source: 'Your computer', mode: 'ask', exact: '~/Downloads' },
        { id: 't-cmd', label: 'Run one command', source: 'Your computer', mode: 'allow', exact: 'du -sh ~/Downloads' },
      ],
      whenAsk: 'skip', waitHours: null, noAnswer: 'skip', late: 'fallback', lateFallback: 'Only sort files older than a day, and tell me it ran late.',
      notify: { needs: true, news: false, fails: true }, enabled: true,
      usage: { dollars: 0, tokens: 118_000 }, next: 'Tonight at 2:00',
      lastRun: { id: 'r-t1', when: 'Today at 8:31', outcome: 'skipped', summary: 'Ran late (the computer was asleep at 2:00). Sorted 41 files.', skipped: ['Moving 3 files it was not sure about'], tokens: 14_000, seconds: 37 },
    },
  ];
}

function seedRuns(job: AutomationSummary): AutomationRun[] {
  const last = job.lastRun ? [job.lastRun] : [];
  const older: AutomationRun[] = [
    { id: `${job.id}-2`, when: 'Yesterday at 7:00', outcome: 'done', summary: 'Nothing unusual.', tokens: 8_200, seconds: 19, dollars: job.subscription ? undefined : 0.01 },
    { id: `${job.id}-3`, when: 'Tuesday at 7:00', outcome: 'missed', summary: 'Missed: the computer was off. It ran once when it woke at 9:40.', tokens: 0, seconds: 0 },
    { id: `${job.id}-4`, when: 'Tuesday at 9:40', outcome: 'done', summary: 'Nothing unusual.', tokens: 8_900, seconds: 20, dollars: job.subscription ? undefined : 0.01 },
    { id: `${job.id}-5`, when: 'Monday at 7:00', outcome: 'failed', summary: 'Couldn’t reach the model. It will try again at the next run.', tokens: 0, seconds: 30 },
    { id: `${job.id}-6`, when: 'Sunday at 7:00', outcome: 'done', summary: 'Nothing unusual.', tokens: 7_700, seconds: 18, dollars: job.subscription ? undefined : 0.01 },
  ];
  return [...last, ...older];
}

export function createAutomationsMock(scenario: string): AutomationsBridge {
  let jobs = scenario === 'empty' ? [] : seedJobs();
  const copy = () => jobs.map((j) => ({ ...j }));
  return {
    list: async () => copy(),
    runs: async (id) => { const j = jobs.find((x) => x.id === id); return j ? seedRuns(j) : []; },
    save: async (job) => { jobs = jobs.some((j) => j.id === job.id) ? jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...jobs]; return copy(); },
    setEnabled: async (id, enabled) => { jobs = jobs.map((j) => (j.id === id ? { ...j, enabled } : j)); return copy(); },
    runNow: async (id) => {
      jobs = jobs.map((j) => (j.id === id ? { ...j, lastRun: { id: `${id}-now`, when: 'Just now', outcome: 'running', summary: 'Running…', tokens: 0, seconds: 0 } } : j));
      return copy();
    },
    answer: async (id, allow) => {
      jobs = jobs.map((j) => (j.id !== id ? j : {
        ...j, waiting: undefined,
        lastRun: j.lastRun && { ...j.lastRun, outcome: allow ? 'done' : 'skipped', summary: allow ? 'Sent the reply to Sam Lee.' : 'Left the draft unsent, as you asked.' },
      }));
      return copy();
    },
  };
}
