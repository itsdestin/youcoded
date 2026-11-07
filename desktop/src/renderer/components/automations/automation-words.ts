// The words every Automations screen uses for a job's start and a run's outcome — one place, so
// the list, the builder, the runs and the check card never word the same fact two ways.
import type { AutomationOutcome, AutomationStart } from '../../../shared/automation-types';
import type { PillTone } from '../ui/Pill';

export function startWords(s: AutomationStart): string {
  if (s.kind === 'button') return `From a button: “${s.label}”`;
  if (s.kind === 'event') return `When ${s.event.charAt(0).toLowerCase()}${s.event.slice(1)}`;
  if (s.every === 'hour') return s.hours && s.hours > 1 ? `Every ${s.hours} hours` : 'Every hour';
  if (s.every === 'week') return `Every ${s.day ?? 'Monday'} at ${s.at ?? '9:00'}`;
  if (s.every === 'weekday') return `Every weekday at ${s.at ?? '9:00'}`;
  return `Every day at ${s.at ?? '9:00'}`;
}

/** The outcome's pill: a word and its status tint (the colour rides in the tint, never the word). */
export const OUTCOME: Record<AutomationOutcome, { word: string; tone: PillTone }> = {
  done: { word: 'Done', tone: 'ok' },
  news: { word: 'Has news', tone: 'info' },
  waiting: { word: 'Waiting for you', tone: 'warning' },
  skipped: { word: 'Skipped a step', tone: 'warning' },
  stopped: { word: 'Stopped', tone: 'neutral' },
  limit: { word: 'Reached its limit', tone: 'danger' },
  missed: { word: 'Missed', tone: 'neutral' },
  failed: { word: 'Failed', tone: 'danger' },
  running: { word: 'Running', tone: 'info' },
};

export function tokenWords(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M tokens`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k tokens`;
  return `${n} tokens`;
}

export function dollarWords(d: number): string {
  return d < 0.01 && d > 0 ? 'under $0.01' : `$${d.toFixed(2)}`;
}

/** The short form for a chip ("Daily at 7:00", "Email arrives"): a card's chip row, where the full
 *  sentence would scroll off. */
export function scheduleWords(s: AutomationStart): string {
  if (s.kind === 'button') return 'Page button';
  if (s.kind === 'event') return s.event.replace(/ in Gmail$/, '').replace(/^An? /, '').replace(/^./, (c) => c.toUpperCase()).replace(/ arrives$/, ' arrives');
  if (s.every === 'hour') return s.hours && s.hours > 1 ? `Every ${s.hours} hours` : 'Hourly';
  if (s.every === 'week') return `${s.day ?? 'Monday'}s at ${s.at ?? '9:00'}`;
  if (s.every === 'weekday') return `Weekdays at ${s.at ?? '9:00'}`;
  return `Daily at ${s.at ?? '9:00'}`;
}
