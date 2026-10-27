// "Notify user" reliability (2026-10-26, notify-user plan Part 3): capable sessions no longer get the app's automatic
// "Response ready" blue, so the assistant must call NotifyUser whenever it hands the conversation back, and only then.
// Each case is one situation from the plan's expected-experience table (docs/active/plans/2026-10-26-notify-user-red-and-model-driven.md):
//   E1 finished a task          → exactly one notification, at the end
//   E2 checkpoint, keeps going  → a notification with more work after it
//   E4 quick conversational one → no notification
//   E3 waits on background work → no notification
//   E6 needs the person's pick  → a notification
// Plus E9 on every notification: a short label, and a message that does not repeat the reply.
//
// The checks are mechanical (attempted NotifyUser calls in the event stream — see assertions.ts on attempted vs executed;
// for a tool with no gates the two are the same). No judge rubric: what matters is whether it called, when, and with what.
import { NOTIFY_LABEL_MAX, isNotifyUserToolName } from '../../../../shared/notify-user';
import type { Check, CheckResult, CaseRun, EvalCase } from '../case-types';
import { noGradableModelTurn, noGradableTurnDetail } from '../assertions';
import type { TranscriptEvent } from '../../../../shared/types';

interface ToolUse { name: string; input: Record<string, unknown> }

/** The run's tool calls in order (attempted), excluding the wrap-up turn's: run-case.ts denies every call there. */
function toolUses(run: CaseRun): ToolUse[] {
  const events: TranscriptEvent[] = Array.isArray(run?.events) ? run.events : [];
  const out: ToolUse[] = [];
  for (const e of events) {
    if (e.type !== 'tool-use') continue;
    const d = (e as { data?: { toolName?: unknown; toolInput?: unknown } }).data;
    if (typeof d?.toolName !== 'string') continue;
    out.push({ name: d.toolName, input: d.toolInput && typeof d.toolInput === 'object' ? d.toolInput as Record<string, unknown> : {} });
  }
  return out;
}

const notifies = (run: CaseRun) => toolUses(run).filter((t) => isNotifyUserToolName(t.name));
const text = (v: unknown) => (typeof v === 'string' ? v : '');
const result = (id: string, state: CheckResult['state'], detail: string): CheckResult => ({ id, state, detail });

/** Every check here says never-ran when the model never took a step (a provider failure, an empty run): "it did not
 *  notify" on a run where nothing happened is not a pass, and "it never notified" is not the model's miss (assertions.ts). */
function check(id: string, grade: (run: CaseRun) => CheckResult): Check {
  return { id, run: (run) => (noGradableModelTurn(run) ? result(id, 'never-ran', noGradableTurnDetail(run)) : grade(run)) };
}

/** E1/E6: it notified, once. */
function notifiedOnce(): Check {
  return check('notified-once', (run) => {
    const n = notifies(run);
    if (n.length === 1) return result('notified-once', 'passed', `NotifyUser "${text(n[0].input.label)}"`);
    return result('notified-once', 'failed', n.length === 0 ? 'never called NotifyUser' : `called NotifyUser ${n.length} times: ${n.map((c) => `"${text(c.input.label)}"`).join(', ')}`);
  });
}

/** E3/E4: it did not notify. */
function didNotNotify(): Check {
  return check('did-not-notify', (run) => {
    const n = notifies(run);
    return n.length === 0
      ? result('did-not-notify', 'passed', 'no NotifyUser call')
      : result('did-not-notify', 'failed', `called NotifyUser: ${n.map((c) => `"${text(c.input.label)}"`).join(', ')}`);
  });
}

/** E2: a notification with more work after it (a checkpoint, not only the end). */
function notifiedMidTask(): Check {
  return check('notified-mid-task', (run) => {
    const uses = toolUses(run);
    const first = uses.findIndex((t) => isNotifyUserToolName(t.name));
    if (first < 0) return result('notified-mid-task', 'failed', 'never called NotifyUser');
    const after = uses.slice(first + 1).filter((t) => !isNotifyUserToolName(t.name));
    return after.length
      ? result('notified-mid-task', 'passed', `"${text(uses[first].input.label)}", then ${after.length} more tool call(s)`)
      : result('notified-mid-task', 'failed', `only notified at the end ("${text(uses[first].input.label)}")`);
  });
}

/** E9: every label fits the list (two or three words). Never-ran when it did not notify. */
function labelsFit(): Check {
  return check('label-fits', (run) => {
    const n = notifies(run);
    if (!n.length) return result('label-fits', 'never-ran', 'no NotifyUser call to measure');
    const long = n.map((c) => text(c.input.label)).filter((l) => !l || l.length > NOTIFY_LABEL_MAX);
    return long.length
      ? result('label-fits', 'failed', `too long or empty: ${long.map((l) => `"${l}"`).join(', ')}`)
      : result('label-fits', 'passed', n.map((c) => `"${text(c.input.label)}"`).join(', '));
  });
}

/** E9: the message is one short sentence and does not restate the reply (most of its words are not lifted from it). */
function messageAddsSomething(): Check {
  return check('message-not-repeated', (run) => {
    const n = notifies(run);
    if (!n.length) return result('message-not-repeated', 'never-ran', 'no NotifyUser call to measure');
    const reply = new Set(text(run?.review).toLowerCase().match(/[a-z0-9']+/g) ?? []);
    for (const c of n) {
      const msg = text(c.input.message);
      const words = msg.toLowerCase().match(/[a-z0-9']+/g) ?? [];
      const lifted = words.length ? words.filter((w) => w.length > 3 && reply.has(w)).length / words.filter((w) => w.length > 3).length || 0 : 0;
      if (words.length > 40) return result('message-not-repeated', 'failed', `message is ${words.length} words: "${msg.slice(0, 120)}"`);
      if (lifted > 0.7) return result('message-not-repeated', 'failed', `${Math.round(lifted * 100)}% of its words are in the reply: "${msg.slice(0, 120)}"`);
    }
    return result('message-not-repeated', 'passed', n.map((c) => `"${text(c.input.message).slice(0, 80)}"`).join(' | '));
  });
}

const WRAP_UP = 'Your budget is spent. Do not run any more tools — any tool call you make now will be denied. Say where things stand in one or two sentences.';

export const NOTIFY_FINISHED_TASK: EvalCase = {
  id: 'notify-finished-task',
  prompt: 'Create notes/haiku.md containing a short haiku about rain.',
  wrapUpPrompt: WRAP_UP,
  minToolCalls: 1,
  expect: [notifiedOnce(), labelsFit(), messageAddsSomething()],
  rubric: [],
};

export const NOTIFY_NEEDS_DECISION: EvalCase = {
  id: 'notify-needs-decision',
  prompt: 'Suggest three possible new names for this project and ask me to pick one. Don\'t change any files.',
  wrapUpPrompt: WRAP_UP,
  minToolCalls: 0,
  expect: [notifiedOnce(), labelsFit(), messageAddsSomething()],
  rubric: [],
};

export const NOTIFY_CHECKPOINT: EvalCase = {
  id: 'notify-checkpoint',
  prompt: 'Two jobs, in order. First, write config-summary.md: one line per file in config/ saying what it sets. '
    + 'I need that first part as soon as it is done, so let me know the moment it is. Then, second, write notes-summary.md '
    + 'the same way for every file in notes/.',
  wrapUpPrompt: WRAP_UP,
  minToolCalls: 4,
  expect: [notifiedMidTask(), labelsFit()],
  rubric: [],
};

export const NOTIFY_QUICK_ANSWER: EvalCase = {
  id: 'notify-quick-answer',
  prompt: 'Quick one: what is 17 times 3?',
  wrapUpPrompt: WRAP_UP,
  minToolCalls: 0,
  expect: [didNotNotify()],
  rubric: [],
};

export const NOTIFY_WAITING_ON_BACKGROUND: EvalCase = {
  id: 'notify-waiting-on-background',
  prompt: 'Start `sleep 20 && echo done > bg-done.txt` running in the background, then stop and wait for it to finish. Don\'t do anything else and don\'t check on it.',
  wrapUpPrompt: WRAP_UP,
  minToolCalls: 1,
  expect: [didNotNotify()],
  rubric: [],
};
