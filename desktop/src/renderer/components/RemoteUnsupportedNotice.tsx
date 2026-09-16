// Announces features that aren't bridged to remote access yet.
//
// Most of window.claude's channels have no handler in remote-server.ts. They
// now answer immediately with {ok:false, unsupported:true} rather than hanging
// for 30 seconds, but the answer lands in call sites that largely don't check
// it — ProjectView's listProjectsIndex().then() has no .catch(), account-context
// calls reloadFromStore() as `void` — so without this the user just gets an
// empty panel and no reason for it.
//
// Mount-only; renders nothing until the shim reports something. The shim
// dedupes by feature, so this shows at most one toast per feature per page load
// even for channels polled on a loop.

import { useEffect, useState } from 'react';
import { REMOTE_UNSUPPORTED_EVENT, type RemoteUnsupportedDetail } from '../remote-unsupported';
import { CloseButton } from './ui';

const VISIBLE_MS = 6000;

export default function RemoteUnsupportedNotice() {
  const [notice, setNotice] = useState<RemoteUnsupportedDetail | null>(null);
  // Features that arrived while this notice was already up. WHY: opening one screen can
  // touch three unbridged channels at once, and each replacing the last produced a
  // flicker of half-read sentences. They become one sentence instead.
  const [also, setAlso] = useState<string[]>([]);

  useEffect(() => {
    const onUnsupported = (e: Event) => {
      const detail = (e as CustomEvent).detail as RemoteUnsupportedDetail | undefined;
      if (!detail) return;
      setNotice(prev => {
        if (prev && prev.feature !== detail.feature) {
          setAlso(list => (list.includes(detail.feature) ? list : [...list, detail.feature]));
          return prev;
        }
        return detail;
      });
    };
    window.addEventListener(REMOTE_UNSUPPORTED_EVENT, onUnsupported);
    return () => window.removeEventListener(REMOTE_UNSUPPORTED_EVENT, onUnsupported);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => { setNotice(null); setAlso([]); }, VISIBLE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  if (!notice) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      // Bottom-center, above the input chrome. --vvp-offset keeps it clear of
      // the soft keyboard on a phone, the same way .jump-to-bottom does.
      className="fixed left-1/2 -translate-x-1/2 z-[9500] max-w-[min(28rem,calc(100vw-2rem))] px-3 py-2 rounded-lg bg-panel border border-edge shadow-lg text-sm-tight text-fg-2 flex items-start gap-2"
      style={{ bottom: `calc(var(--bottom-chrome-height, 5rem) + var(--vvp-offset, 0px) + 0.75rem)` }}
    >
      <span className="shrink-0 mt-0.5 text-fg-muted" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="10" />
          <path strokeLinecap="round" d="M12 8h.01M11 12h1v4h1" />
        </svg>
      </span>
      <span className="min-w-0">
        {notice.message}
        {also.length > 0 && (
          <span className="block text-fg-muted mt-0.5">
            {also.length === 1 ? `${also[0]} either.` : `${also.slice(0, -1).join(', ')} and ${also[also.length - 1]} either.`}
          </span>
        )}
      </span>
      {/* Same migration as CopyPicker's — the approved icon+ghost recipe,
          which this had reimplemented at a different size with no focus ring. */}
      <CloseButton onClick={() => { setNotice(null); setAlso([]); }} label="Dismiss" className="shrink-0 -mr-1 -mt-0.5" />
    </div>
  );
}
