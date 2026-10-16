// The Open tasks popup over practice tasks (`shoot dev/open-tasks`). WHY (submit-ticket-5#ST5-Q2):
// no practice conversation creates tasks, so the real popup only ever showed "No open tasks" and
// its folded Completed / Marked inactive sections could not be photographed. This mounts the REAL
// OpenTasksPopup beside the app, in the photo-only build only (index.tsx), like the icon sheet.
// Never ships.
//
// WHY the tasks are made from tool calls (Open tasks rework, 2026-10-13): they go through the
// app's own buildTasksById, so the picture shows what a real session would — a Claude Code
// session's TaskCreate / TaskUpdate calls by default, and a native session's TodoWrite list with
// `?tasks=native` (`dev/open-tasks#native`), the path that was missing before.
import { useEffect, useMemo, useState } from 'react';
import OpenTasksPopup from '../../components/OpenTasksPopup';
import { buildTasksById, type TaskState } from '../../state/task-state';
import type { ToolCallState } from '../../../shared/types';
import { useScreenOpen } from '../../shoot-mode';

const call = (toolUseId: string, toolName: string, input: Record<string, unknown>, response?: string): ToolCallState =>
  ({ toolUseId, toolName, input, status: 'complete', ...(response !== undefined && { response }) }) as ToolCallState;

/** A Claude Code session: tasks created one by one, then moved along. */
function claudeCodeCalls(): ToolCallState[] {
  const create = (n: number, subject: string, description: string, activeForm: string) =>
    call(`c${n}`, 'TaskCreate', { subject, description, activeForm }, `Task #${n} created successfully: ${subject}`);
  return [
    create(1, 'Read the ticket and find the screen it names', 'Open the ticket and note which popup it is about.', 'Reading the ticket'),
    create(2, 'Reproduce the cut-off Volume card on a phone', 'Shrink the window to 390 wide and look at Settings → Sound.', 'Reproducing the cut-off card'),
    create(3, 'Fix the card width at phone size', 'The card keeps its desktop width below 640 wide, so its right edge is cut off.', 'Fixing the card width'),
    create(4, 'Check every theme at 390px', 'Light, a dark theme and a wallpaper theme.', 'Checking every theme'),
    create(5, 'Write the test for narrow widths', '', 'Writing the test'),
    create(6, 'Ask about the old sound list', '', 'Asking about the old sound list'),
    call('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    call('u2', 'TaskUpdate', { taskId: '2', status: 'completed' }),
    call('u3', 'TaskUpdate', { taskId: '3', status: 'in_progress' }),
  ];
}

/** A native-harness session: TodoWrite replaces the whole list each time. */
function nativeCalls(): ToolCallState[] {
  const todo = (content: string, status: string, activeForm: string) => ({ content, status, activeForm });
  return [
    call('w1', 'TodoWrite', { todos: [
      todo('Find where the budget numbers come from', 'in_progress', 'Finding where the numbers come from'),
      todo('Add up this month’s spending', 'pending', 'Adding up the spending'),
      todo('Write the summary', 'pending', 'Writing the summary'),
    ] }, 'Todo list updated: 3 items, 0 completed.'),
    call('w2', 'TodoWrite', { todos: [
      todo('Find where the budget numbers come from', 'completed', 'Finding where the numbers come from'),
      todo('Add up this month’s spending', 'in_progress', 'Adding up the spending'),
      todo('Write the summary', 'pending', 'Writing the summary'),
      todo('Check last month’s receipts too', 'pending', 'Checking last month’s receipts'),
    ] }, 'Todo list updated: 4 items, 1 completed.'),
  ];
}

function practiceTasks(): TaskState[] {
  const native = new URLSearchParams(location.search).get('tasks') === 'native';
  const calls = native ? nativeCalls() : claudeCodeCalls();
  const tasks = [...buildTasksById(new Map(calls.map((c) => [c.toolUseId, c]))).values()]
    .sort((a, b) => a.orderIndex - b.orderIndex);
  // One stale task already marked inactive, so the Marked inactive fold is in the picture.
  const hidden = native ? 'Check last month’s receipts too' : 'Ask about the old sound list';
  return tasks.map((t) => ({ ...t, markedInactive: t.subject === hidden }));
}

export default function OpenTasksPractice() {
  const [open, setOpen] = useState(false);
  const initial = useMemo(practiceTasks, []);
  const [tasks, setTasks] = useState(initial);
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
