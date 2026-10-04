// desktop/src/renderer/dev/workbench/fixtures/xray.ts
//
// A saved Claude Code session for the X-ray view to read in the workbench, shaped
// like a real `~/.claude/projects/<slug>/<id>.jsonl`: a prompt, a skill loaded in
// as hidden text, reminders, a hook message, thinking, and then the model stuck
// re-running the same failing test command — the case X-ray exists for.
// `?scenario=stress` repeats it to ~3,000 lines so the view's drawing bound shows.
import type { XrayRawLine, XrayChatFate } from '../../../../shared/xray-types';

const SID = 'b3f1c2d4-7e8a-4c1b-9f2e-5a6d7c8b9e0f';
let clock = Date.parse('2026-10-04T14:02:11.000Z');
let uuid = 0;

function at(stepMs: number): string { clock += stepMs; return new Date(clock).toISOString(); }
function base(stepMs = 1200) {
  uuid += 1;
  return { sessionId: SID, uuid: `u-${uuid}`, timestamp: at(stepMs), cwd: '/home/destin/projects/budget-app' };
}

type Entry = [record: Record<string, unknown>, chat: XrayChatFate];

function user(text: string, extra: Record<string, unknown> = {}, chat: XrayChatFate = 'shown', step?: number): Entry {
  return [{ type: 'user', ...base(step), ...extra, message: { role: 'user', content: text } }, chat];
}
function say(text: string, step?: number): Entry {
  return [{ type: 'assistant', ...base(step), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] } }, 'shown'];
}
function think(text: string): Entry {
  return [{ type: 'assistant', ...base(800), message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } }, 'hidden'];
}
let callN = 0;
function call(name: string, input: Record<string, unknown>, result: string, isError = false, step?: number): Entry[] {
  callN += 1;
  const id = `toolu_${String(callN).padStart(3, '0')}`;
  return [
    [{ type: 'assistant', ...base(step ?? 900), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }, 'shown'],
    [{ type: 'user', ...base(1600), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: result }] } }, 'shown'],
  ];
}

function build(): Entry[] {
  const out: Entry[] = [];
  out.push([{ type: 'file-history-snapshot', messageId: 'm-0', snapshot: { trackedFileBackups: {} } }, 'hidden']);
  out.push([{ type: 'system', ...base(0), subtype: 'SessionStart:startup hook', content: 'Brain repo: 1 uncommitted change', level: 'info' }, 'hidden']);
  out.push(user('<system-reminder>\nAs you answer the user\'s questions, you can use the following context:\n# claudeMd\nContents of /home/destin/.claude/CLAUDE.md …\n</system-reminder>', { isMeta: true }, 'hidden'));
  out.push(user('The monthly totals on the summary page are off by a few cents. Can you find out why and fix it?', {}, 'shown', 4000));
  out.push(think('Rounding issue likely — totals summed from floats. Look at the summary module and its tests first.'));
  out.push(say('I\'ll start by looking at how the summary page adds up the totals.'));
  out.push(...call('Grep', { pattern: 'monthlyTotal', path: 'src' }, 'src/summary/totals.ts:14\nsrc/summary/totals.test.ts:3'));
  out.push(...call('Read', { file_path: 'src/summary/totals.ts' }, '1\texport function monthlyTotal(items) {\n2\t  return items.reduce((a, b) => a + b.amount, 0);\n3\t}'));
  out.push(user('<system-reminder>\nThe file src/summary/totals.ts was read. Note: this file is 3 lines.\n</system-reminder>', { isMeta: true }, 'hidden', 50));
  out.push(say('Found it: amounts are added as decimals, which drifts by fractions of a cent. I\'ll add them as whole cents instead.'));
  out.push(...call('Edit', { file_path: 'src/summary/totals.ts', old_string: 'a + b.amount', new_string: 'a + Math.round(b.amount * 100)' }, 'The file src/summary/totals.ts has been updated.'));
  out.push([{ type: 'attachment', ...base(200), attachment: { type: 'hook_success', hookName: 'PostToolUse:Edit', content: 'prettier: formatted 1 file' } }, 'hidden']);
  // The loop: the same failing command, four times, with nothing changed between.
  const failing = 'FAIL src/summary/totals.test.ts\n  ● monthlyTotal › sums cents\n    Expected: 12.34\n    Received: 1234';
  out.push(...call('Bash', { command: 'npm test -- totals', description: 'Run the totals tests' }, failing, true));
  out.push(say('The test still expects dollars. Let me run it again to be sure.'));
  out.push(...call('Bash', { command: 'npm test -- totals', description: 'Run the totals tests' }, failing, true));
  out.push(think('Same failure. Maybe the test cache is stale.'));
  out.push(...call('Bash', { command: 'npm test -- totals', description: 'Run the totals tests' }, failing, true));
  out.push(user('<system-reminder>\nThe task tools haven\'t been used recently. If you\'re working on tasks that would benefit from tracking progress, consider using TaskCreate.\n</system-reminder>', { isMeta: true }, 'hidden', 50));
  out.push(...call('Bash', { command: 'npm test -- totals', description: 'Run the totals tests' }, failing, true));
  // A long stall: nothing written for over four minutes.
  out.push(...call('Bash', { command: 'npm test -- totals --no-cache', description: 'Run the totals tests without cache' }, failing, true, 252_000));
  out.push(user('[Request interrupted by user]', {}, 'trimmed', 9000));
  out.push(user('stop running the test, the function has to return dollars, divide by 100 at the end', {}, 'shown', 14000));
  out.push(say('Understood — I\'ll keep adding in cents and divide by 100 when returning.'));
  out.push(...call('Edit', { file_path: 'src/summary/totals.ts', old_string: ', 0);', new_string: ', 0) / 100;' }, 'The file src/summary/totals.ts has been updated.'));
  out.push(...call('Bash', { command: 'npm test -- totals', description: 'Run the totals tests' }, 'PASS src/summary/totals.test.ts\n  ✓ sums cents (3 ms)'));
  out.push(say('Fixed. Totals are now added in whole cents and converted back to dollars at the end, so they no longer drift. The tests pass.'));
  out.push([{ type: 'system', ...base(300), subtype: 'turn_duration', durationMs: 301_200, content: '' }, 'hidden']);
  return out;
}

function toLines(entries: Entry[], startAt = 1): XrayRawLine[] {
  return entries.map(([record, chat], i) => ({ n: startAt + i, raw: JSON.stringify(record), chat }));
}

export const XRAY_FILE = `/home/destin/.claude/projects/-home-destin-projects-budget-app/${SID}.jsonl`;

/** The whole fixture file. `stress` repeats the session until it is ~3,000 lines. */
export function xrayFixtureLines(stress: boolean): XrayRawLine[] {
  const one = build();
  if (!stress) return toLines(one);
  const all: Entry[] = [];
  while (all.length < 3000) all.push(...build());
  return toLines(all);
}
