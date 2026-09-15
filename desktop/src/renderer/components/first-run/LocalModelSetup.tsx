import { useEffect, useRef, useState } from 'react';
import type { CuratedModel, DownloadProgress, FitEstimate, QuantOption } from '../../../shared/model-manager-types';
import { LocalModelBrowser, RepoCard } from '../LocalModelsSection';
import { Button, LoadingState } from '../ui';
import { LocalAppConnect } from './LocalAppConnect';

/**
 * "Use a local model" on the first-run sign-in card (design
 * 2026-09-14-first-run-local-models):
 *  - Q-2 set up inside setup, not by sending a new user to Settings;
 *  - Q-3 one model suggested for this computer, with the full list one press away;
 *  - Q-6 the option is always offered, with a warning on a small computer;
 *  - Destin's note: or use a model app already running on this computer.
 *
 * WHY the suggestion is a Local models row and the full list IS the Local models
 * browser (round 3 review B-3/B-4, Destin 2026-09-14: "this list should match the
 * search/list provided in the assistant settings -> local models download screen",
 * "warnings should match existing styling"): one list and one warning style for
 * the same thing, so setup and Settings cannot drift apart. A download started
 * from either is what finishes setup.
 */

type QuantWithFit = QuantOption & { fit: FitEstimate };

export interface LocalSetupInfo {
  /** One of the curated models, chosen for this computer. */
  suggested: CuratedModel;
}

// WHY every action is the card's outlined pill: first-run rule, Destin 2026-09-14.
const PILL = 'px-6 py-3 rounded-full font-semibold text-base w-full';

export function LocalModelSetup({ onBack }: { onBack: () => void }) {
  const [info, setInfo] = useState<LocalSetupInfo | null>(null);
  const [view, setView] = useState<'suggested' | 'browse' | 'connect'>('suggested');
  const [expanded, setExpanded] = useState(false);
  // The suggested row needs what RepoCard needs inside Local models: live
  // download progress and the resolved quant options.
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({});
  const quantOptsByKeyRef = useRef<Record<string, QuantWithFit>>({});

  useEffect(() => {
    let alive = true;
    Promise.resolve((window as any).claude?.firstRun?.localSetup?.())
      .then((i: LocalSetupInfo | null | undefined) => { if (alive && i?.suggested) setInfo(i); })
      .catch(() => { /* build stage: an ErrorState with Retry belongs here */ });
    const off = (window as any).claude?.models?.onDownloadProgress?.((p: DownloadProgress) => {
      setDownloads((prev) => ({ ...prev, [p.downloadId]: p }));
    });
    return () => { alive = false; if (typeof off === 'function') off(); };
  }, []);

  if (view === 'connect') return <LocalAppConnect onBack={() => setView('suggested')} />;

  if (view === 'browse') {
    return (
      <div className="w-full flex flex-col items-center gap-4">
        <p className="text-base font-medium text-fg text-center">Choose a model</p>
        <div className="w-full text-left">
          <LocalModelBrowser />
        </div>
        <Button variant="secondary" onClick={() => setView('suggested')} className={PILL}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col items-center gap-4">
      <div className="text-center">
        <p className="text-base font-medium text-fg">Run a model on this computer</p>
        <p className="mt-1 text-sm text-fg-dim leading-relaxed">
          No account needed. Your chats are answered right here, on this computer.
        </p>
      </div>

      {!info ? (
        <LoadingState what="this computer" verb="Checking" />
      ) : (
        <>
          {/* Round 4 review (B-4): no separate warning above the card — on a small
              computer the row's own amber fit line is the warning. */}
          <div className="w-full text-left">
            <p className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">Suggested for this computer</p>
            <RepoCard
              repo={info.suggested.hfRepo}
              label={info.suggested.label}
              sub={info.suggested.notes}
              preferredQuant={info.suggested.quantDefault}
              autoResolve
              downloads={downloads}
              quantOptsByKeyRef={quantOptsByKeyRef}
              expanded={expanded}
              onToggle={() => setExpanded((e) => !e)}
            />
          </div>
        </>
      )}

      <div className="flex flex-col items-stretch gap-3 w-full">
        <Button variant="secondary" onClick={() => setView('browse')} className={PILL}>
          Choose a different model
        </Button>
        <Button variant="secondary" onClick={() => setView('connect')} className={PILL}>
          Use an app on this computer
        </Button>
        <Button variant="secondary" onClick={onBack} className={PILL}>
          Back to sign-in
        </Button>
      </div>
    </div>
  );
}
