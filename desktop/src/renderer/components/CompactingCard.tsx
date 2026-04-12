import React, { useEffect, useState } from 'react';

// Spinner card shown during /compact (typed or triggered by resume-from-summary).
// Claude Code's summarization takes 10-30s; before this card the user saw nothing
// happening and would often send a second message or give up.

interface Props {
  startedAt: number;
}

export default function CompactingCard({ startedAt }: Props) {
  // Live elapsed counter — reassures the user that something is still happening.
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - startedAt) / 1000));
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  return (
    <div className="flex justify-start px-4 py-2">
      <div className="flex items-center gap-3 bg-inset border border-edge-dim rounded-2xl rounded-bl-sm px-4 py-3 text-fg-2">
        <div className="w-3 h-3 rounded-full bg-accent animate-pulse" />
        <div>
          <div className="text-sm font-medium">Compacting conversation…</div>
          <div className="text-xs text-fg-muted">
            Summarizing earlier messages to free up context · {elapsed}s
          </div>
        </div>
      </div>
    </div>
  );
}
