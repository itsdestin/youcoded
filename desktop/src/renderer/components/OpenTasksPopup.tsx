import React, { useState } from 'react';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import type { TaskState } from '../state/task-state';

// L2 popup opened by OpenTasksChip in the StatusBar. Groups tasks by status:
// In Progress → Pending → Completed (collapsible). A separate "Marked Inactive"
// expander at the bottom holds user-hidden tasks. Each active row has a
// Mark Inactive button; each inactive row has an Unhide button.

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

function StatusDot({ group }: { group: Group }) {
  if (group === 'in_progress') {
    return (
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ background: '#60a5fa', boxShadow: '0 0 0 2px rgba(96,165,250,0.25)' }}
      />
    );
  }
  if (group === 'completed') {
    return <span className="inline-block w-2 h-2 rounded-full bg-fg-muted" />;
  }
  // pending / inactive
  return <span className="inline-block w-2 h-2 rounded-full border border-fg-muted" />;
}

function Row({ t, group, onMarkInactive, onUnhide }: {
  t: TaskState;
  group: Group;
  onMarkInactive: (id: string) => void;
  onUnhide: (id: string) => void;
}) {
  const title = group === 'in_progress' && t.activeForm ? t.activeForm : (t.subject ?? `#${t.id}`);
  const isDeleted = t.status === 'deleted';
  const showDesc = group !== 'completed' && t.description;

  return (
    <div className={`group flex gap-2 items-start px-2 py-1.5 rounded ${group === 'completed' ? 'opacity-60' : ''}`}>
      <div className="pt-1.5"><StatusDot group={group} /></div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[11px] font-mono text-fg-muted">#{t.id}</span>
          <span className={`text-xs ${group === 'in_progress' ? 'text-blue-400 italic' : 'text-fg'} ${group === 'completed' ? 'line-through' : ''}`}>
            {title}
          </span>
          {isDeleted && <span className="text-[10px] px-1 rounded bg-inset text-fg-muted">deleted</span>}
        </div>
        {showDesc && <div className="text-[11px] text-fg-muted mt-0.5 leading-tight">{t.description}</div>}
      </div>
      {group === 'inactive' ? (
        <button
          className="text-[10px] text-fg-muted hover:text-fg bg-inset hover:bg-well px-2 py-0.5 rounded border border-edge-dim"
          onClick={() => onUnhide(t.id)}
          aria-label={`Unhide task #${t.id}`}
        >
          Unhide
        </button>
      ) : (
        <button
          className="text-[10px] text-fg-muted hover:text-fg bg-inset hover:bg-well px-2 py-0.5 rounded border border-edge-dim opacity-40 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
          onClick={() => onMarkInactive(t.id)}
          aria-label={`Mark task #${t.id} inactive`}
        >
          Mark Inactive
        </button>
      )}
    </div>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-fg-muted px-2 pt-2 pb-1 flex justify-between items-baseline">
      <span>{label}</span>
      <span>{count}</span>
    </div>
  );
}

export default function OpenTasksPopup({ open, tasks, onClose, onMarkInactive, onUnhide }: Props) {
  // Compute initial open states from the first render's tasks, then let the user
  // fully control. Avoids fighting user intent when the completed count crosses 5
  // mid-popup.
  const initialCompleted = tasks.filter(t => !t.markedInactive && (t.status === 'completed' || t.status === 'deleted'));
  const initialInactive = tasks.filter(t => t.markedInactive);
  const [completedOpen, setCompletedOpen] = useState(() => initialCompleted.length > 0 && initialCompleted.length <= 5);
  const [inactiveOpen, setInactiveOpen] = useState(() => initialInactive.length > 0 && initialInactive.length <= 5);

  if (!open) return null;

  const running = tasks.filter(t => groupOf(t) === 'in_progress');
  const pending = tasks.filter(t => groupOf(t) === 'pending');
  const completed = tasks.filter(t => groupOf(t) === 'completed');
  const inactive = tasks.filter(t => groupOf(t) === 'inactive');
  const openCount = running.length + pending.length;

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        className="fixed right-3 bottom-8 w-[420px] max-w-[calc(100vw-1.5rem)] max-h-[70vh] overflow-auto rounded-md"
        role="dialog"
        aria-label="Open tasks"
      >
        {/* Header row */}
        <div className="flex justify-between items-baseline px-3 pt-2 pb-1 border-b border-edge-dim">
          <span className="text-sm font-medium text-fg">Open Tasks</span>
          <span className="text-[10px] uppercase tracking-wider text-fg-muted">{openCount} open</span>
        </div>

        {/* Empty state: nothing at all */}
        {openCount === 0 && completed.length === 0 && inactive.length === 0 && (
          <div className="px-3 py-4 text-xs text-fg-muted text-center">No open tasks.</div>
        )}

        {/* Empty state: only completed or inactive remain */}
        {openCount === 0 && (completed.length > 0 || inactive.length > 0) && (
          <div className="px-3 py-3 text-xs text-fg-muted italic">No open tasks.</div>
        )}

        {/* In Progress section */}
        {running.length > 0 && (
          <>
            <SectionHeader label="In Progress" count={running.length} />
            {running.map(t => (
              <Row key={t.id} t={t} group="in_progress" onMarkInactive={onMarkInactive} onUnhide={onUnhide} />
            ))}
          </>
        )}

        {/* Pending section */}
        {pending.length > 0 && (
          <>
            <SectionHeader label="Pending" count={pending.length} />
            {pending.map(t => (
              <Row key={t.id} t={t} group="pending" onMarkInactive={onMarkInactive} onUnhide={onUnhide} />
            ))}
          </>
        )}

        {/* Completed section — collapsible toggle */}
        {completed.length > 0 && (
          <>
            <button
              aria-expanded={completedOpen}
              className="w-full text-left text-[10px] uppercase tracking-wider text-fg-muted px-2 pt-2 pb-1 flex justify-between items-baseline hover:text-fg"
              onClick={() => setCompletedOpen(v => !v)}
            >
              <span>Completed</span>
              <span>{completed.length} {completedOpen ? '▾' : '▸'}</span>
            </button>
            {completedOpen && completed.map(t => (
              <Row key={t.id} t={t} group="completed" onMarkInactive={onMarkInactive} onUnhide={onUnhide} />
            ))}
          </>
        )}

        {/* Marked Inactive section — collapsed by default */}
        {inactive.length > 0 && (
          <>
            <button
              aria-expanded={inactiveOpen}
              className="w-full text-left text-[10px] uppercase tracking-wider text-fg-muted px-2 pt-2 pb-1 flex justify-between items-baseline hover:text-fg border-t border-edge-dim mt-1"
              onClick={() => setInactiveOpen(v => !v)}
            >
              <span>Marked Inactive</span>
              <span>{inactive.length} {inactiveOpen ? '▾' : '▸'}</span>
            </button>
            {inactiveOpen && inactive.map(t => (
              <Row key={t.id} t={t} group="inactive" onMarkInactive={onMarkInactive} onUnhide={onUnhide} />
            ))}
          </>
        )}
      </OverlayPanel>
    </>
  );
}
