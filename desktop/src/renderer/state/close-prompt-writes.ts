import { isUnsupportedHere } from '../utils/ipc-error';
import { reportFailure } from '../utils/report-failure';

// Writes what the person chose in the Close session prompt (lists, tags, note) and says which parts did not land.
//
// WHY it exists (R-1 batch 1, code review 2026-11-18): App.tsx fired each write and swallowed a failure, then closed
// the chat. A tag, pin or note the person chose was lost with no word. Now every write is awaited; the caller keeps the
// prompt open and shows a notice when any failed, so nothing is lost silently.
export interface CloseChoices {
  flags: Record<string, boolean | undefined>;
  addTagIds: string[]; removeTagIds: string[]; note: string; noteChanged: boolean;
}

/** Names of the parts that failed, in plain words: any of "lists", "tags", "note". Empty = everything saved. */
export async function applyCloseChoices(id: string, result: CloseChoices): Promise<string[]> {
  const api = (window as any).claude?.session;
  const failed = new Set<string>();
  const run = (part: string, call: () => unknown) =>
    Promise.resolve().then(call).catch((cause: unknown) => {
      // A phone that cannot do this at all has already said so itself (remote shim); that is not a failure to report.
      if (isUnsupportedHere(cause)) return;
      failed.add(part);
      reportFailure({ what: `save the ${part} you chose`, cause, where: 'CloseSessionPrompt.confirm', show: 'log-only' });
    });
  const jobs: Promise<unknown>[] = [];
  for (const [flag, value] of Object.entries(result.flags)) jobs.push(run('lists', () => api.setFlag(id, flag, value)));
  for (const t of result.addTagIds) jobs.push(run('tags', () => api.setTag(id, t, true)));
  for (const t of result.removeTagIds) jobs.push(run('tags', () => api.setTag(id, t, false)));
  if (result.noteChanged) jobs.push(run('note', () => api.setNote(id, result.note)));
  await Promise.all(jobs);
  return ['lists', 'tags', 'note'].filter((p) => failed.has(p));
}
