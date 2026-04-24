import React from 'react';

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
 * Visual: "TASKS 1◐ 2○" — blue running count, amber pending count. Numbers
 * carry the color; the chip surface stays neutral so it doesn't compete with
 * the salmon BYPASS chip next to it.
 */
export default function OpenTasksChip({ running, pending, onOpen }: Props) {
  const total = running + pending;
  if (total === 0) return null;

  const parts: string[] = [];
  if (running > 0) parts.push(`${running} in progress`);
  if (pending > 0) parts.push(`${pending} pending`);
  const tooltip = `${parts.join(', ')} — click to view tasks`;

  return (
    <button
      onClick={onOpen}
      className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm border cursor-pointer hover:brightness-125 transition-colors"
      style={{
        backgroundColor: 'var(--inset)',
        color: 'var(--fg-muted)',
        borderColor: 'var(--edge-dim)',
      }}
      title={tooltip}
      aria-label={tooltip}
    >
      <span className="hidden sm:inline">TASKS</span>
      {running > 0 && (
        <span className="inline-flex items-center gap-0.5" style={{ color: '#60a5fa' }}>
          <span>{running}</span>
          <span aria-hidden>◐</span>
        </span>
      )}
      {pending > 0 && (
        <span className="inline-flex items-center gap-0.5" style={{ color: '#fbbf24' }}>
          <span>{pending}</span>
          <span aria-hidden>○</span>
        </span>
      )}
    </button>
  );
}
