// propose-automation.ts — the assistant proposing an automation from a chat (finishing Pages, step 4; build
// plan decision 13 and plan-d D-source: "the assistant drafts it when the automation is made and the check
// popup shows it").
//
// The tool itself does nothing: it describes an automation. The app turns that description into a DRAFT
// here, with every setting the assistant did not name filled the way a new automation starts
// (plan-b#E-prefill), and shows it in the "Check this automation" popup. Nothing is saved, and nothing can
// run, until the person presses Turn on there.
//
// WHY the draft is built by the app and not taken whole from the model: the model names what the
// automation should do; it must not be able to hand itself a setting the screens never showed (a made-up
// field, a run already enabled, usage numbers). Only the fields read below exist in a draft.
import type { AutomationLink, AutomationStart, AutomationSummary, AutomationTool } from './automation-types';

export const PROPOSE_AUTOMATION_TOOL = 'ProposeAutomation';
/** The same tool as Claude Code sees it, on the app's page-data MCP server. */
export const CLAUDE_CODE_PROPOSE_AUTOMATION_TOOL = 'mcp__youcoded-pages__ProposeAutomation';
export const isProposeAutomationTool = (name: string | undefined): boolean => name === PROPOSE_AUTOMATION_TOOL || name === CLAUDE_CODE_PROPOSE_AUTOMATION_TOOL;

/** One description for both kinds of chat, so the assistant behaves the same in each. */
export const PROPOSE_AUTOMATION_DESCRIPTION = [
  'Propose an automation: a job YouCoded runs for the person on a schedule, when they press a button on one of their pages, or when a page reports an event.',
  'Calling this shows them a popup with every part of it to check. Nothing is saved and nothing runs until they press Turn on there, so say that you have shown it to them, not that it is set up.',
  'Write `instruction` as the full task in plain words, as you would brief another assistant that knows nothing about this chat.',
  'List in `permissions` only what the task needs, each as narrow as it can be: a folder (to look, or to change), one exact command (use * only for the part that changes, such as a file name), one website, or the page’s own information. Set mode "ask" for anything that sends, deletes, pays or cannot be undone, and "allow" for the rest.',
  'Anything not listed is refused during a run, so a missing permission means a skipped step.',
].join(' ');

/** The tool's input, as JSON Schema (the MCP server's, and the shape the native tool's zod mirrors). */
export const PROPOSE_AUTOMATION_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'A short name, as the person would say it: "Morning money check".' },
    instruction: { type: 'string', description: 'The whole task, in plain words.' },
    start: {
      type: 'object',
      description: 'When it runs.',
      properties: {
        kind: { type: 'string', enum: ['schedule', 'button', 'event'] },
        every: { type: 'string', enum: ['hour', 'day', 'weekday', 'week'], description: 'schedule only.' },
        at: { type: 'string', description: 'schedule only (not hourly): the time, 24-hour "7:00".' },
        day: { type: 'string', description: 'weekly only: the day name, "Friday".' },
        hours: { type: 'number', description: 'hourly only: every this many hours (1 if left out).' },
        label: { type: 'string', description: 'button only: the words on the page’s button.' },
        event: { type: 'string', description: 'event only: the name of the page’s event.' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    page: { type: 'string', description: 'The id of the page it belongs to (from ListPages), when it reads or changes a page or is started from one.' },
    permissions: {
      type: 'array',
      description: 'What it may do. Leave out anything it does not need.',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['folder', 'command', 'site', 'page-read', 'page-write'] },
          mode: { type: 'string', enum: ['allow', 'ask'], description: '"allow" = always allowed; "ask" = the person is asked each time.' },
          folder: { type: 'string', description: 'folder only: the folder, e.g. "~/Downloads".' },
          change: { type: 'boolean', description: 'folder only: true if it may also add, change and remove files; false = look only.' },
          command: { type: 'string', description: 'command only: the exact command; * stands for the part that changes.' },
          label: { type: 'string', description: 'command only: what the command does, in a few plain words: "Turn recordings into text".' },
          site: { type: 'string', description: 'site only: the website, e.g. "bestbuy.com".' },
        },
        required: ['kind', 'mode'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'instruction', 'start'],
  additionalProperties: false,
} as const;

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function startOf(raw: unknown): AutomationStart | string {
  const s = (raw ?? {}) as Record<string, unknown>;
  if (s.kind === 'button') return { kind: 'button', label: text(s.label, 40) || 'Run' };
  if (s.kind === 'event') { const event = text(s.event, 80); return event ? { kind: 'event', event } : 'An event start needs the event’s name.'; }
  if (s.kind !== 'schedule') return '`start.kind` must be "schedule", "button" or "event".';
  const every = s.every;
  if (every !== 'hour' && every !== 'day' && every !== 'weekday' && every !== 'week') return 'A schedule needs `every`: "hour", "day", "weekday" or "week".';
  if (every === 'hour') {
    const hours = typeof s.hours === 'number' && s.hours >= 1 && s.hours <= 23 ? Math.floor(s.hours) : 1;
    return { kind: 'schedule', every, ...(hours > 1 ? { hours } : {}) };
  }
  const at = text(s.at, 5);
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) return 'A daily, weekday or weekly schedule needs `at` as a 24-hour time such as "7:00".';
  if (every === 'week') {
    const day = text(s.day, 9);
    if (!['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].includes(day)) return 'A weekly schedule needs `day` as a day name such as "Friday".';
    return { kind: 'schedule', every, at, day };
  }
  return { kind: 'schedule', every, at };
}

function toolOf(raw: unknown, n: number): AutomationTool | string {
  const p = (raw ?? {}) as Record<string, unknown>;
  const mode = p.mode === 'allow' ? 'allow' as const : 'ask' as const; // anything unclear asks
  const id = `t-${n}`;
  if (p.kind === 'folder') {
    const folder = text(p.folder, 400);
    if (!folder) return 'A folder permission needs `folder`.';
    const change = p.change === true;
    return { id, kind: 'folder', label: change ? 'Change the files in a folder' : 'See the files in a folder', source: 'Your computer', exact: folder, mode, ...(change ? { change: true } : {}) };
  }
  if (p.kind === 'command') {
    const command = text(p.command, 600);
    if (!command) return 'A command permission needs `command`.';
    return { id, kind: 'command', label: text(p.label, 60) || 'Run a command', source: 'Your computer', exact: command, mode };
  }
  if (p.kind === 'site') {
    const site = text(p.site, 200).replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!site.includes('.')) return 'A site permission needs `site` as a website such as "bestbuy.com".';
    return { id, kind: 'site', label: 'Visit a website', source: 'Internet', exact: site, mode };
  }
  if (p.kind === 'page-read') return { id, kind: 'page-read', label: 'Read this page’s information', source: 'This page', mode };
  if (p.kind === 'page-write') return { id, kind: 'page-write', label: 'Change this page’s information', source: 'This page', mode };
  return 'Each permission needs `kind`: "folder", "command", "site", "page-read" or "page-write".';
}

export interface ProposalContext {
  /** A fresh id for the draft. */
  id: string;
  /** The model the proposing chat runs on, so the automation starts on the same one. */
  model: { name: string; runsOn: NonNullable<AutomationSummary['runsOn']>; subscription: boolean };
  /** The page named by `page`, when it exists in the library. */
  page?: AutomationLink;
}

/** Turn what the assistant proposed into a draft for the check popup, or say what is wrong with it. */
export function draftFromProposal(raw: unknown, ctx: ProposalContext): { ok: true; draft: AutomationSummary } | { ok: false; message: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = text(r.name, 80);
  const instruction = text(r.instruction, 8000);
  if (!name) return { ok: false, message: 'The automation needs a `name`.' };
  if (!instruction) return { ok: false, message: 'The automation needs an `instruction`.' };
  const start = startOf(r.start);
  if (typeof start === 'string') return { ok: false, message: start };
  const tools: AutomationTool[] = [];
  for (const [i, p] of (Array.isArray(r.permissions) ? r.permissions.slice(0, 30) : []).entries()) {
    const t = toolOf(p, i + 1);
    if (typeof t === 'string') return { ok: false, message: t };
    tools.push(t);
  }
  if (tools.some((t) => t.kind === 'page-read' || t.kind === 'page-write') && !ctx.page) {
    return { ok: false, message: 'A page permission needs `page`: the id of one of the person’s pages (see ListPages).' };
  }
  if (start.kind !== 'schedule' && !ctx.page) return { ok: false, message: 'A button or event start needs `page`: the id of the page it is started from.' };
  return {
    ok: true,
    draft: {
      id: ctx.id, name, instruction, start, tools,
      links: ctx.page ? [ctx.page] : [],
      model: ctx.model.name, runsOn: ctx.model.runsOn, subscription: ctx.model.subscription,
      // A new automation's starting settings (plan-b#E-prefill): wait for me until its next run, then skip
      // that step; a missed run runs once on wake; due while running skips the new run; anything unlisted
      // is never allowed; this device runs it; a paid model starts at $5 a month (questions#Q-limit).
      whenAsk: 'wait', waitHours: null, noAnswer: 'skip', late: 'run', overlap: 'skip-new',
      unlisted: { sites: 'never', commands: 'never' },
      devices: [{ id: 'here', name: 'This computer', here: true, runs: true }],
      notify: { needs: true, news: true, fails: true },
      ...(ctx.model.subscription ? {} : { limit: 5 }),
      // WHY off: only Turn on in the popup switches it on.
      enabled: false,
      usage: { dollars: 0, tokens: 0 },
    },
  };
}
