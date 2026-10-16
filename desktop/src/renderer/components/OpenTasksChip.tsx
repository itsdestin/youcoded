import { RowStatus, Tooltip } from './ui';

interface Props {
  running: number;   // count of in_progress tasks
  pending: number;   // count of pending tasks
  onOpen: () => void;
}

/**
 * StatusBar chip showing an at-a-glance count of open tasks (running + pending).
 * Hidden entirely when both counts are 0 — matches the announcement-pill pattern.
 * Clicking opens the OpenTasksPopup (parent owns the popup state).
 *
 * Visual: "Tasks ●1 ◐ 2 ○" — every word and number in the chip's normal text colour; the running
 * count carries the green status dot the session list's Working uses.
 *
 * WHY no coloured numbers (Open tasks rework, 2026-10-13; the status-colour sweep's rule,
 * small-fixes-3#SF3-10): the guide keeps status hues out of words and numbers, and these were
 * hand-typed hex blue and amber. The state is the small dot before the number (RowStatus — the
 * status bar's usage and context numbers do the same). "Tasks", not "TASKS": sentence case
 * (only the mode badges stay in capitals).
 */
export default function OpenTasksChip({ running, pending, onOpen }: Props) {
  const total = running + pending;
  if (total === 0) return null;

  const parts: string[] = [];
  if (running > 0) parts.push(`${running} in progress`);
  if (pending > 0) parts.push(`${pending} pending`);
  const tooltip = `${parts.join(', ')} — click to view tasks`;

  return (
    <Tooltip text={tooltip}>
    <button
      onClick={onOpen}
      className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm border cursor-pointer hover:brightness-125 transition-colors"
      style={{
        backgroundColor: 'var(--inset)',
        color: 'var(--fg-muted)',
        borderColor: 'var(--edge-dim)',
      }}
      aria-label={tooltip}
    >
      <span className="hidden sm:inline">Tasks</span>
      {running > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <RowStatus dotClassName="bg-green-400">{running}</RowStatus>
          <span aria-hidden>◐</span>
        </span>
      )}
      {pending > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <span>{pending}</span>
          <span aria-hidden>○</span>
        </span>
      )}
    </button>
    </Tooltip>
  );
}
