// Automations (finishing Pages, step 4) — the shapes the screens are drawn against.
//
// WHY here and nothing behind it yet: step 4 is at the design stage (feature flow: questions →
// mockups → review). These types are the screens' contract; the runner that fills them (card #61's
// job store, schedules, hidden runs, spend) is built only after Destin approves the screens. Until
// then only the workbench fake answers `window.claude.automations` (dev/workbench/mock-only.ts).
//
// Every per-job setting below is Destin's: the step 4 questions deck
// (docs/active/design/2026-10-24-pages-finish/pages-finish-step4.questions.answers.json) answered
// almost every behaviour with "set per job", each with a sensible default.

import type { PageIcon } from './pages-types';

/** When a job starts. A page button is pressed in the page; it has no time of its own. */
export type AutomationStart =
  | { kind: 'schedule'; every: 'hour' | 'day' | 'weekday' | 'week'; at?: string; day?: string; hours?: number }
  | { kind: 'event'; event: string }
  | { kind: 'button'; label: string };

/** One thing a job may do. Q-blocked note: "always allowed to read emails, ask before writing
 *  emails, run this exact command without asking, and that's it" — so each tool has its own
 *  switch, and a command can be named exactly. */
export interface AutomationTool {
  id: string;
  /** What it does, in the person's words: "Read your email". */
  label: string;
  /** Where it comes from, shown small: "Gmail", "This page", "Your computer". */
  source: string;
  mode: 'allow' | 'ask';
  /** What it matches, when the tool has a detail: a folder, a website, or a command (where `*` stands for
   *  any part that changes). One kind of command permission, as narrow or wide as the job needs (2026-11-12). */
  exact?: string;
  /** What sort of permission it is; absent on the earlier sample jobs. Folder, site and command can be edited. */
  kind?: 'page-read' | 'page-write' | 'folder' | 'site' | 'command' | 'service';
}

/** What a waiting job does when nobody answered in time (Q-wait-long: "set ways to proceed"). */
type AutomationNoAnswer = 'skip' | 'stop' | 'fallback';

/** What a job does when its time passed while the computer was asleep (Q-asleep, per job).
 *  Plan deck S-start note: "run differently" covers a different time as well as different
 *  instructions (which can also change what it produces), so 'later' runs at `lateAt`. */
type AutomationLate = 'run' | 'skip' | 'later' | 'fallback';

/** A page or project an automation is linked to. Plan deck Q-pagejobs / Q-deletepage: an
 *  automation is its own thing that can be linked to any number of pages and projects (or none),
 *  never owned by one; a linked page may run it from a button. */
export interface AutomationLink {
  kind: 'page' | 'project';
  id: string;
  name: string;
  icon?: PageIcon;
}

/** One device that knows about this automation (plan deck Q-devices: every synced device lists
 *  it; each one is switched on or off for running it, with a warning when two are on). */
export interface AutomationDevice {
  id: string;
  name: string;
  /** This is the device showing the screen. */
  here: boolean;
  runs: boolean;
}

export interface AutomationSummary {
  id: string;
  name: string;
  /** The instruction it runs, as the person wrote or approved it. */
  instruction: string;
  /** The pages and projects it is linked to; empty = it stands alone (every job shows in Automations). */
  links: AutomationLink[];
  start: AutomationStart;
  /** The model's name as the model picker shows it. */
  model: string;
  /** True when it runs on the person's Claude subscription (no money limit, usage still counted). */
  subscription: boolean;
  tools: AutomationTool[];
  /** Q-blocked: chosen per job. */
  whenAsk: 'wait' | 'skip';
  /** How long a waiting job waits, in hours; null = until its next run. */
  waitHours: number | null;
  noAnswer: AutomationNoAnswer;
  /** The instruction it follows instead, when noAnswer or late is 'fallback'. */
  fallback?: string;
  late: AutomationLate;
  /** The time a late run happens instead, when late is 'later' ("18:00"). */
  lateAt?: string;
  lateFallback?: string;
  /** Plan deck Q-overlap: per job — when it is due while its last run is still going. */
  overlap: 'skip-new' | 'stop-old' | 'both';
  /** What happens to websites and to commands or files not in `tools` (stored per job). */
  unlisted: { sites: 'never' | 'ask'; commands: 'never' | 'ask' };
  /** Which devices run it (plan deck Q-devices). */
  devices: AutomationDevice[];
  /** Q-tell: three kinds, each on or off per job. */
  notify: { needs: boolean; news: boolean; fails: boolean };
  /** The most runs in one day, for a job a button or an event starts (review deck Q-cap: only where it makes
   *  sense, so never on a schedule). null = any number. */
  maxRunsPerDay?: number | null;
  /** How many runs it has started today, counted by the runner; with `maxRunsPerDay` it says whether another may start. */
  runsToday?: number;
  /** Monthly limit in dollars (Q-limit: $5 to start, changeable). Absent on a subscription job. */
  limit?: number;
  enabled: boolean;
  /** This month's use (Q-subscription note: tokens per job, per model, for every provider). */
  usage: { dollars: number; tokens: number };
  lastRun?: AutomationRun;
  /** Set while a run is waiting for the person. */
  waiting?: AutomationWaiting;
  /** When it runs next, already worded ("Tomorrow at 7:00"); absent for a button. */
  next?: string;
}

export type AutomationOutcome = 'done' | 'news' | 'waiting' | 'skipped' | 'stopped' | 'limit' | 'missed' | 'failed' | 'running';

export interface AutomationRun {
  id: string;
  /** Already worded: "Today at 7:00". */
  when: string;
  outcome: AutomationOutcome;
  /** One line of what it did. */
  summary: string;
  /** What it left undone, when it skipped. */
  skipped?: string[];
  dollars?: number;
  tokens: number;
  seconds: number;
}

interface AutomationWaiting {
  runId: string;
  /** What it wants to do, in words: "Send a reply to Sam Lee". */
  action: string;
  /** The detail it would send or run, shown so the yes is an informed one. */
  detail?: string;
  /** The permission the step falls under, which "Allow from now on" turns to Always allowed. */
  toolId?: string;
  /** Already worded: "Asked 2 h ago". */
  asked: string;
  /** Already worded: "Skips it at 7:00 tomorrow if you don't answer". */
  until: string;
}

/** `window.claude.automations` — answered only by the workbench fake until the runner exists. */
export interface AutomationsBridge {
  list(): Promise<AutomationSummary[]>;
  runs(id: string): Promise<AutomationRun[]>;
  save(job: AutomationSummary): Promise<AutomationSummary[]>;
  setEnabled(id: string, enabled: boolean): Promise<AutomationSummary[]>;
  runNow(id: string): Promise<AutomationSummary[]>;
  /** Plan deck S-answer: an answer may carry a note for the assistant; Don't allow needs one, so
   *  the run knows what to do instead rather than trying again. */
  answer(id: string, allow: boolean, note?: string, fromNowOn?: boolean): Promise<AutomationSummary[]>;
  /** Delete an automation with its settings and saved runs (review deck S-delete). */
  remove(id: string): Promise<AutomationSummary[]>;
}

/** The built-in Automations page (Q-home note: "the main area could probably be a built-in
 *  page") — listed, pinned and opened like Office. */
export const AUTOMATIONS_PAGE_ID = 'builtin:automations';
