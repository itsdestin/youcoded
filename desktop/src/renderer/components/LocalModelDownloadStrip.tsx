import { useCallback, useEffect, useState } from 'react';
import { Button } from './ui';
import { ProgressBar } from './ui/ProgressBar';
import { StatusStrip } from './ui/StatusStrip';

/**
 * The band above the message box while a model chosen at setup is still
 * downloading, or was left half-downloaded (design
 * 2026-09-14-first-run-local-models: Q-4 "open while downloading", Q-7 "open the
 * app, with a notice and a button to finish").
 *
 * One strip, two states, because they are the same fact at two moments: this
 * conversation's model is not on the computer yet.
 *
 * Round 3 review (B-5/B-6, Destin 2026-09-14): ONLY for the first download, when
 * the app would otherwise be unusable. If any other model or provider can already
 * answer, main reports null and this strip never appears — an ordinary download
 * started from Local models is not announced here.
 */

export interface SetupDownloadStatus {
  state: 'downloading' | 'stopped' | 'done';
  modelLabel: string;
  percent: number;
  minutesLeft: number | null;
}

export function LocalModelDownloadStrip({ sessionId }: { sessionId: string | null }) {
  const [status, setStatus] = useState<SetupDownloadStatus | null>(null);

  useEffect(() => {
    const read = (window as any).claude?.firstRun?.localDownload;
    // WHY a missing channel renders nothing: until the backend exists, no install
    // has a setup download to report, and a strip must never claim one.
    if (typeof read !== 'function') return;
    let alive = true;
    const tick = () => {
      Promise.resolve(read(sessionId))
        .then((s: SetupDownloadStatus | null) => { if (alive) setStatus(s ?? null); })
        .catch(() => { /* a failed read keeps the last answer rather than flashing */ });
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [sessionId]);

  const resume = useCallback(() => {
    void (window as any).claude?.firstRun?.resumeLocalDownload?.(sessionId);
  }, [sessionId]);

  if (!status || status.state === 'done') return null;

  if (status.state === 'stopped') {
    return (
      <div className="px-2 sm:px-3 pb-1.5">
        <StatusStrip
          tone="warn"
          detail="Setup closed before the download finished, so this chat can’t answer yet."
          action={<Button variant="secondary" size="sm" onClick={resume}>Resume download</Button>}
        >
          {status.modelLabel} isn’t downloaded yet
        </StatusStrip>
      </div>
    );
  }

  const left = status.minutesLeft == null
    ? 'Your assistant can answer once this finishes.'
    : `About ${status.minutesLeft} ${status.minutesLeft === 1 ? 'minute' : 'minutes'} left. Your assistant can answer once this finishes.`;

  return (
    <div className="px-2 sm:px-3 pb-1.5">
      <StatusStrip tone="busy" detail={left}>
        <span className="flex items-center gap-3">
          <span className="shrink-0">Downloading {status.modelLabel}</span>
          <ProgressBar percent={status.percent} showLabel className="flex-1 min-w-0" aria-label={`Downloading ${status.modelLabel}`} />
        </span>
      </StatusStrip>
    </div>
  );
}
