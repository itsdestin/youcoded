import React, { useCallback, useState } from 'react';
import type { ShellRunView } from '../../../shared/types';
import { Button, StatusStrip } from '../ui';
import { useElapsed } from '../tool-views/ToolBody';

/**
 * "Running as admin" — a command that passed the admin password card is still
 * running something with full control of the computer (admin-password design,
 * Q-still-running, 2026-09-25: one approval must not quietly grant admin power
 * for hours). Sits on the card OUTSIDE the collapsible body, so it stays in view
 * while the card is folded, until the command ends.
 */
export function AdminRunStrip({ run, sessionId }: { run: ShellRunView; sessionId?: string }) {
  const elapsed = useElapsed(run.startedAt || undefined, run.endedAt);
  const [stopping, setStopping] = useState(false);
  const stop = useCallback(async () => {
    if (!sessionId) return;
    setStopping(true);
    try {
      const r = await window.claude.native.killShell(sessionId, run.shellId);
      if (!r.ok) setStopping(false);
    } catch (err) { console.error('KillShell failed:', err); setStopping(false); }
  }, [run.shellId, sessionId]);

  return (
    <div className="px-3 py-2 border-t border-edge">
      <StatusStrip
        tone="warn"
        detail="Still has full control of your computer until it ends."
        action={<Button size="sm" variant="danger-outline" disabled={stopping} onClick={stop}>{stopping ? 'Stopping…' : 'Stop'}</Button>}
      >
        Running as admin{elapsed ? ` · ${elapsed}` : ''}
      </StatusStrip>
    </div>
  );
}
