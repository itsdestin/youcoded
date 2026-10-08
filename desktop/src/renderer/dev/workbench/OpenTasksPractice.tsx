// The Open tasks popup over practice tasks (`shoot dev/open-tasks`). WHY (submit-ticket-5#ST5-Q2):
// no practice conversation creates tasks, so the real popup only ever showed "No open tasks" and
// its folded Completed / Marked inactive sections — where the sweep found a hard line — could not
// be photographed. This mounts the REAL OpenTasksPopup with fixed tasks, beside the app, in the
// photo-only build only (index.tsx), like the icon sheet. Never ships.
import { useEffect, useState } from 'react';
import OpenTasksPopup from '../../components/OpenTasksPopup';
import type { TaskState } from '../../state/task-state';
import { useScreenOpen } from '../../shoot-mode';

const task = (id: string, subject: string, status: TaskState['status'], orderIndex: number, markedInactive = false): TaskState =>
  ({ id, subject, status, orderIndex, events: [], markedInactive, activeForm: status === 'in_progress' ? `${subject}…` : undefined });

const TASKS: TaskState[] = [
  task('1', 'Read the ticket and find the screen it names', 'completed', 0),
  task('2', 'Reproduce the cut-off Volume card on a phone', 'completed', 1),
  task('3', 'Fix the card width at phone size', 'in_progress', 2),
  task('4', 'Check every theme at 390px', 'pending', 3),
  task('5', 'Write the test for narrow widths', 'pending', 4),
  task('6', 'Ask about the old sound list', 'pending', 5, true),
];

export default function OpenTasksPractice() {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState(TASKS);
  useScreenOpen('dev/open-tasks', () => setOpen(true));
  // Escape closes it like any layer (shoot --check presses it). Capture phase, like the icon
  // sheet: this sits OUTSIDE the app's tree, so the app's own Escape handlers sit above it.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  return <OpenTasksPopup open={open} tasks={tasks} onClose={() => setOpen(false)}
    onMarkInactive={(id) => setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, markedInactive: true } : t)))}
    onUnhide={(id) => setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, markedInactive: false } : t)))} />;
}
