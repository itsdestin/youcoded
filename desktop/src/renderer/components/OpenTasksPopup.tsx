import { useState } from 'react';
import { useEscClose } from '../hooks/use-esc-close';
import type { TaskState } from '../state/task-state';
import { Button, Dialog } from './ui';

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
          <span className="text-2xs font-mono text-fg-muted">#{t.id}</span>
          <span className={`text-xs ${group === 'in_progress' ? 'text-blue-400 italic' : 'text-fg'} ${group === 'completed' ? 'line-through' : ''}`}>
            {title}
          </span>
          {isDeleted && <span className="text-3xs px-1 rounded bg-inset text-fg-muted">deleted</span>}
        </div>
        {showDesc && <div className="text-2xs text-fg-muted mt-0.5 leading-tight">{t.description}</div>}
      </div>
      {group === 'inactive' ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onUnhide(t.id)}
          aria-label={`Unhide task #${t.id}`}
        >
          Unhide
        </Button>
      ) : (
        // The 40% resting opacity is deliberate (spec decision 74): it's the
        // standing hint that rows are dismissible, so it is NOT dropped to 0.
        // Careful: 40% sits BELOW BUTTON_BASE's `disabled:opacity-50`, so if a
        // `disabled` prop is ever added here a disabled button would render
        // BRIGHTER than an enabled one — revisit this resting value first.
        <Button
          variant="ghost"
          size="sm"
          className="opacity-40 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
          onClick={() => onMarkInactive(t.id)}
          aria-label={`Mark task #${t.id} inactive`}
        >
          Mark Inactive
        </Button>
      )}
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="text-3xs font-medium text-fg-muted tracking-wider uppercase px-2 pt-2 pb-1">
      {label}
    </div>
  );
}

export default function OpenTasksPopup({ open, tasks, onClose, onMarkInactive, onUnhide }: Props) {
  // ESC routing through the central LIFO stack — same pattern as other L2 popups (AboutPopup, etc.)
  useEscClose(open, onClose);

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
      <Dialog screen="chat/open-tasks" open onClose={onClose} title="Open Tasks" size="panel">
        <>
          {/* Empty state: nothing at all */}
          {openCount === 0 && completed.length === 0 && inactive.length === 0 && (
            <div className="px-3 py-4 text-xs text-fg-muted text-center">No open tasks.</div>
          )}

          {/* Empty state: only completed or inactive remain */}
          {openCount === 0 && (completed.length > 0 || inactive.length > 0) && (
            <div className="px-3 py-3 text-xs text-fg-muted italic">No open tasks.</div>
          )}

          {/* In Progress section — no count suffix, the rows are visible right below. */}
          {running.length > 0 && (
            <>
              <SectionHeader label="In Progress" />
              {running.map(t => (
                <Row key={t.id} t={t} group="in_progress" onMarkInactive={onMarkInactive} onUnhide={onUnhide} />
              ))}
            </>
          )}

          {/* Pending section — no count suffix, the rows are visible right below. */}
          {pending.length > 0 && (
            <>
              <SectionHeader label="Pending" />
              {pending.map(t => (
                <Row key={t.id} t={t} group="pending" onMarkInactive={onMarkInactive} onUnhide={onUnhide} />
              ))}
            </>
          )}

          {/* Completed section — collapsible. Keep the count on the toggle itself
              so a collapsed section signals "there are N items hidden here." */}
          {completed.length > 0 && (
            <>
              <button
                aria-expanded={completedOpen}
                className="w-full text-left text-3xs font-medium text-fg-muted tracking-wider uppercase px-2 pt-2 pb-1 flex justify-between items-baseline hover:text-fg"
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

          {/* Marked Inactive section — same collapsed-toggle-with-count pattern. */}
          {inactive.length > 0 && (
            <>
              <button
                aria-expanded={inactiveOpen}
                className="w-full text-left text-3xs font-medium text-fg-muted tracking-wider uppercase px-2 pt-2 pb-1 flex justify-between items-baseline hover:text-fg border-t border-edge-dim mt-1"
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
        </>
      </Dialog>
    </>
  );
}
