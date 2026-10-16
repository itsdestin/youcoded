import { useState } from 'react';
import { memoWhileClosed } from './memo-while-closed';
import type { TaskState } from '../state/task-state';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, Dialog, FoldRow, Pill, SectionLabel, SettingRow } from './ui';

// The Open tasks popup, opened by OpenTasksChip in the status bar: the to-do list Claude (or a
// native-harness assistant) is keeping for this session (state/task-state.ts derives it).
//
// WHY rebuilt from existing pieces only (Destin, small-fixes-1#SF-8: "this whole page needs a
// rework to align with the new ui guide … this is an old popup"; built without review rounds,
// per Destin 2026-10-13). Each part follows a guide recipe and a real screen doing the same job:
// - title and container: the shared popup, narrow `panel` (Session details, Close session);
// - groups: a small label, then one first-level card (About, Performance — guide "Spacing":
//   nothing bare on the popup, a label first, every card labelled);
// - task rows: one nested box per task holding the shared setting row, its button at the right
//   (Unsaved changes' file rows, the Games friend rows);
// - row status: the running task's green "Working" pill beside its words (the SF-8 fix, kept);
//   nothing else marks a row — its group already says it (guide "show a state only once");
// - folded sections: the shared fold inside the card (About's Privacy and Licenses folds);
// - empty: one quiet grey line in the card (guide "Empty states"; Unsaved changes' "Everything
//   is saved." in its card);
// - buttons: outlined, small, at the right of the row's line (guide "Buttons": less important
//   actions are outlined, never bare text; a lone button that fits its line sits at its right);
// - scrolling: the shared popup body and its fade. No footer: nothing here must stay in view.
// Removed as invented styling: the dots, the "#7" numbers, crossed-out finished tasks, the
// half-faded "Mark inactive" ghost button, the hand-made "deleted" tag.

interface Props {
  open: boolean;
  tasks: TaskState[];                      // pre-sorted by orderIndex ascending
  onClose: () => void;
  onMarkInactive: (taskId: string) => void;
  onUnhide: (taskId: string) => void;
}

type Group = 'in_progress' | 'pending' | 'completed' | 'inactive';

function groupOf(t: TaskState): Group {
  if (t.markedInactive) return 'inactive';
  if (t.status === 'in_progress') return 'in_progress';
  if (t.status === 'completed' || t.status === 'deleted') return 'completed';
  return 'pending';
}

/** What a task is called: the "-ing" words while it runs ("Fixing the bug"), else its name. */
function taskTitle(t: TaskState, group: Group): string {
  return (group === 'in_progress' && t.activeForm) ? t.activeForm : (t.subject ?? 'Untitled task');
}

/** The running task's words with its live status pill (the SF-8 fix, kept as it was approved). */
function RunningTitle({ title }: { title: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span>{title}</span>
      {/* Centred on the title's FIRST line (a long title wraps under it), like the name + pill
          rows elsewhere (NameWithPill): a box one text line tall, the pill centred in it. */}
      <span className="self-start flex items-center h-4 shrink-0"><Pill tone="ok" dot>Working</Pill></span>
    </span>
  );
}

/** One open task: its own nested box holding the shared setting row (Unsaved changes' rows). */
function OpenRow({ t, group, onMarkInactive }: { t: TaskState; group: Group; onMarkInactive: (id: string) => void }) {
  const title = taskTitle(t, group);
  return (
    <li className={`${CARD_LEVEL_2} px-3 py-1`}>
      <SettingRow
        header
        variant="item"
        title={group === 'in_progress' ? <RunningTitle title={title} /> : title}
        // The task's longer note, two lines at most (guide "Cards": description, two lines at most).
        description={t.description ? <span className="line-clamp-2">{t.description}</span> : undefined}
        control={(
          <Button variant="secondary" size="sm" onClick={() => onMarkInactive(t.id)} aria-label={`Mark "${title}" inactive`}>
            Mark inactive
          </Button>
        )}
      />
    </li>
  );
}

/** A task inside a fold: a plain row in the fold's one shared box (guide "Card levels": lists of
 *  short names are plain rows inside one shared box). A hidden task keeps its Unhide button. */
function FoldedRow({ t, onUnhide }: { t: TaskState; onUnhide?: (id: string) => void }) {
  const title = taskTitle(t, groupOf(t));
  return (
    <li>
      <SettingRow
        header
        variant="item"
        title={title}
        control={onUnhide ? (
          <Button variant="secondary" size="sm" onClick={() => onUnhide(t.id)} aria-label={`Unhide "${title}"`}>
            Unhide
          </Button>
        ) : undefined}
      />
    </li>
  );
}

const countWords = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

function OpenTasksPopup({ open, tasks, onClose, onMarkInactive, onUnhide }: Props) {
  // WHY no useEscClose here any more: the shared popup already takes Escape (Dialog.tsx), and a
  // second entry on the Escape stack is what that file says a caller must not add.

  // Compute initial open states from the first render's tasks, then let the user
  // fully control. Avoids fighting user intent when the completed count crosses 5
  // mid-popup.
  const initialCompleted = tasks.filter(t => groupOf(t) === 'completed');
  const initialInactive = tasks.filter(t => groupOf(t) === 'inactive');
  const [completedOpen, setCompletedOpen] = useState(() => initialCompleted.length > 0 && initialCompleted.length <= 5);
  const [inactiveOpen, setInactiveOpen] = useState(() => initialInactive.length > 0 && initialInactive.length <= 5);

  if (!open) return null;

  // The running task first, then what is waiting, each in Claude's own order.
  const openTasks = [
    ...tasks.filter(t => groupOf(t) === 'in_progress'),
    ...tasks.filter(t => groupOf(t) === 'pending'),
  ];
  const completed = tasks.filter(t => groupOf(t) === 'completed');
  const inactive = tasks.filter(t => groupOf(t) === 'inactive');

  return (
    <Dialog screen="chat/open-tasks" open onClose={onClose} title="Open tasks" size="panel">
      {/* WHY one "To do" group, not "In progress" + "Pending": the running task already says so
          with its Working pill, and the guide shows a state once and asks for fewer sections
          (principle 4). The label never repeats the popup's title (guide "Spacing"). */}
      <section>
        <SectionLabel className="mb-2">To do</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3`}>
          {openTasks.length === 0 ? (
            <p className="text-sm text-fg-muted">No open tasks.</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Open tasks">
              {openTasks.map(t => (
                <OpenRow key={t.id} t={t} group={groupOf(t)} onMarkInactive={onMarkInactive} />
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* WHY the shared fold for both sections (Destin, submit-ticket-5#ST5-Q2: no hard line; one
          fold-out look that opens inside itself), now inside a labelled card like About's
          Privacy folds, so nothing sits bare on the popup. The count stays in the fold's hint
          so a closed section still says how much is inside. */}
      {(completed.length > 0 || inactive.length > 0) && (
        <section>
          <SectionLabel className="mb-2">Other tasks</SectionLabel>
          <div className={`${CARD_LEVEL_1} p-3 space-y-2`}>
            {completed.length > 0 && (
              <FoldRow title="Completed" description={countWords(completed.length)}
                open={completedOpen} onToggle={setCompletedOpen}>
                <ul className="flex flex-col">
                  {completed.map(t => <FoldedRow key={t.id} t={t} />)}
                </ul>
              </FoldRow>
            )}
            {inactive.length > 0 && (
              <FoldRow title="Marked inactive" description={countWords(inactive.length)}
                open={inactiveOpen} onToggle={setInactiveOpen}>
                <ul className="flex flex-col">
                  {inactive.map(t => <FoldedRow key={t.id} t={t} onUnhide={onUnhide} />)}
                </ul>
              </FoldRow>
            )}
          </div>
        </section>
      )}
    </Dialog>
  );
}

// WHY (2026-10-05): mounted by the shell all the time, so every session switch rebuilt this closed popup.
// memoWhileClosed ignores prop changes until `open` flips (memo-while-closed.ts).
export default memoWhileClosed(OpenTasksPopup);
