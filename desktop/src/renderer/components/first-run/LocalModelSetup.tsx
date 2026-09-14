import { useEffect, useState } from 'react';
import { Button, Callout, LoadingState, Radio, RadioGroup } from '../ui';
import { StatusStrip } from '../ui/StatusStrip';

/**
 * "Use a local model" on the first-run sign-in card (design
 * 2026-09-14-first-run-local-models):
 *  - Q-2 set up inside setup, not by sending a new user to Settings;
 *  - Q-3 one model suggested for this computer, with the full list one link away;
 *  - Q-6 the option is always offered, with a warning on a computer too small to
 *    run a model well;
 *  - Q-4 pressing Download hands off to the app, which keeps downloading.
 */

export interface LocalSetupModel {
  id: string;
  label: string;
  notes: string;
  sizeBytes: number;
  /** The fit verdict in words, e.g. "Runs fast — fits on your graphics card". */
  fitLabel: string;
}

export interface LocalSetupInfo {
  suggested: LocalSetupModel;
  others: LocalSetupModel[];
  /** Set only when this computer will run every model slowly. */
  memoryWarning: string | null;
}

const gb = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(1)} GB`;

// WHY every action here is the sign-in card's outlined pill (Destin,
// 2026-09-14): all buttons on this screen are one colour with a hover, and none
// is an underlined link.
const PILL = 'px-6 py-3 rounded-full font-semibold text-base w-full';

export function LocalModelSetup({ onBack, onStart }: { onBack: () => void; onStart: (modelId: string) => void }) {
  const [info, setInfo] = useState<LocalSetupInfo | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [picked, setPicked] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.resolve((window as any).claude?.firstRun?.localSetup?.())
      .then((i: LocalSetupInfo | undefined) => {
        if (!alive || !i) return;
        setInfo(i);
        setPicked(i.suggested.id);
      })
      .catch(() => { /* build stage: an ErrorState with Retry belongs here */ });
    return () => { alive = false; };
  }, []);

  const chosen = info ? (info.others.find((m) => m.id === picked) ?? info.suggested) : null;

  return (
    <div className="w-full flex flex-col items-center gap-4">
      <div className="text-center">
        <p className="text-base font-medium text-fg">Run a model on this computer</p>
        <p className="mt-1 text-sm text-fg-dim leading-relaxed">
          No account needed. Your chats are answered right here, on this computer.
        </p>
      </div>

      {!info || !chosen ? (
        <LoadingState what="this computer" verb="Checking" />
      ) : starting ? (
        <StatusStrip tone="busy" className="w-full" detail="YouCoded opens in a moment and keeps downloading there.">
          Getting {chosen.label} ready…
        </StatusStrip>
      ) : (
        <>
          {info.memoryWarning && (
            <Callout tone="warning" className="w-full">{info.memoryWarning}</Callout>
          )}

          {!choosing ? (
            <div className="w-full rounded-lg bg-inset px-4 py-3 text-left">
              <p className="text-2xs uppercase tracking-wide text-fg-muted">Suggested for this computer</p>
              <p className="mt-1 text-sm font-medium text-fg">{info.suggested.label}</p>
              <p className="text-xs text-fg-2">{info.suggested.notes}</p>
              <p className="mt-1.5 text-2xs text-fg-muted">
                {gb(info.suggested.sizeBytes)} download · {info.suggested.fitLabel}
              </p>
            </div>
          ) : (
            <RadioGroup
              options={info.others.map((m) => m.id)}
              value={picked}
              onChange={setPicked}
              aria-label="Choose a model"
              className="w-full flex flex-col gap-2"
            >
              {info.others.map((m) => (
                <label
                  key={m.id}
                  className="w-full flex items-start gap-3 rounded-md border border-edge-dim bg-inset px-3 py-2.5 text-left cursor-pointer"
                >
                  <Radio checked={picked === m.id} onChange={() => setPicked(m.id)} className="mt-1" aria-label={m.label} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-fg">{m.label}</span>
                    <span className="block text-2xs text-fg-muted">{gb(m.sizeBytes)} · {m.fitLabel}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          )}

          {/* Documented pill exception: the first-run card's hero actions keep
              rounded-full and their larger padding (see AuthScreen). */}
          <div className="flex flex-col items-stretch gap-3 w-full">
            <Button variant="secondary" onClick={() => { setStarting(true); onStart(chosen.id); }} className={PILL}>
              Download {chosen.label}
            </Button>
            {!choosing && (
              <Button variant="secondary" onClick={() => setChoosing(true)} className={PILL}>
                Choose a different model
              </Button>
            )}
            <Button variant="secondary" onClick={onBack} className={PILL}>
              Back to sign-in
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
