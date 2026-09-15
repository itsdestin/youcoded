import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, StatusStrip } from './ui';

export const SPECIALIST_SETTINGS_EVENT = 'youcoded:open-specialist-settings';
export const SPECIALIST_DEFAULTS_CHANGED_EVENT = 'youcoded:specialist-defaults-changed';
export const AUTOMATIC_SPECIALIST_MODEL_COPY = 'No Selection – Model will be chosen automatically';
const SPECIALIST_MODEL_UNAVAILABLE_PREFIX = 'SPECIALIST_MODEL_UNAVAILABLE:';
// Only the most recent card that opened Settings owns the next successful save.
let activeRecoveryOwner: symbol | null = null;

export function parseSpecialistModelUnavailable(error: string | undefined): 'budget' | 'frontier' | null {
  if (error === `${SPECIALIST_MODEL_UNAVAILABLE_PREFIX}budget`) return 'budget';
  if (error === `${SPECIALIST_MODEL_UNAVAILABLE_PREFIX}frontier`) return 'frontier';
  return null;
}

export interface SpecialistModelUnavailableProps {
  sessionId?: string;
  tier: 'budget' | 'frontier';
  agent: string;
  description: string;
  prompt: string;
  workDir?: string;
}

/** A recoverable Task refusal: the app stopped before an automatic fallback
 * could silently spend the conversation's expensive model. */
export default function SpecialistModelUnavailable({
  sessionId,
  tier,
  agent,
  description,
  prompt,
  workDir,
}: SpecialistModelUnavailableProps) {
  const owner = useRef(Symbol('specialist-recovery'));
  const [awaitingSelection, setAwaitingSelection] = useState(false);
  const [retryStatus, setRetryStatus] = useState<'idle' | 'sending' | 'queued' | 'resumed' | 'failed' | 'unknown'>('idle');

  const retry = useCallback(async () => {
    if (!sessionId || retryStatus === 'sending' || retryStatus === 'resumed') return;
    setRetryStatus('sending');
    try {
      // WHY this is a new visible turn: the failed tool call has already
      // returned to its model; replaying execution behind that model's back
      // would create a specialist run the transcript never requested.
      const result = await window.claude.native.send(
        sessionId,
        `Try the ${agent} specialist again using the ${tier} specialist model. Original task: ${description}. Work folder: ${workDir || 'the current conversation folder'}. Brief: ${prompt}`,
      );
      setRetryStatus(result.status === 'sent' ? 'resumed' : result.status);
    } catch {
      // A rejected remote invoke does not prove whether the send ran. Do not
      // offer one-click retry: it could duplicate a turn accepted before the
      // acknowledgement was lost.
      setRetryStatus('unknown');
    }
  }, [agent, description, prompt, retryStatus, sessionId, tier, workDir]);

  useEffect(() => {
    const changed = (event: Event) => {
      const changedTier = (event as CustomEvent<{ tier?: string }>).detail?.tier;
      // WHY ownership is renderer-global: opening card B must disarm card A,
      // even though both components remain mounted in the transcript.
      if (awaitingSelection && activeRecoveryOwner === owner.current
          && (!changedTier || changedTier === tier)) {
        activeRecoveryOwner = null;
        setAwaitingSelection(false);
        void retry();
      }
    };
    window.addEventListener(SPECIALIST_DEFAULTS_CHANGED_EVENT, changed);
    return () => window.removeEventListener(SPECIALIST_DEFAULTS_CHANGED_EVENT, changed);
  }, [awaitingSelection, retry, tier]);

  useEffect(() => () => {
    if (activeRecoveryOwner === owner.current) activeRecoveryOwner = null;
  }, []);

  const openSettings = () => {
    activeRecoveryOwner = owner.current;
    setAwaitingSelection(true);
    // WHY a window event: the card is six component layers below App, while
    // Assistant settings already supports page deep-links at the App boundary.
    window.dispatchEvent(new CustomEvent(SPECIALIST_SETTINGS_EVENT));
  };

  const action = retryStatus === 'failed' ? (
    <Button size="sm" onClick={() => void retry()}>Resume specialist</Button>
  ) : retryStatus === 'idle' ? (
    <Button size="sm" onClick={openSettings}>Choose specialist models</Button>
  ) : undefined;

  return (
    <div role="alert">
      <StatusStrip
        tone="warn"
        detail={retryStatus === 'failed'
          ? 'Your model was saved, but YouCoded couldn’t start the retry turn. Resume when the conversation is ready.'
          : retryStatus === 'unknown'
            ? 'The retry may still have been accepted. Check the conversation before trying it again.'
            : retryStatus === 'queued'
            ? 'Your model was saved. The retry will start after the conversation’s current turn finishes.'
            : retryStatus === 'sending' || retryStatus === 'resumed'
              ? 'Your model was saved. The assistant is automatically trying this specialist again.'
              : `This specialist wasn’t started. Choose a ${tier} specialist model so YouCoded doesn’t fall back to an expensive conversation model.`}
        action={action}
      >
        {retryStatus === 'failed'
          ? 'Specialist still paused.'
          : retryStatus === 'unknown'
            ? 'Couldn’t confirm the specialist retry.'
            : retryStatus === 'queued'
            ? 'Specialist retry queued.'
            : retryStatus === 'sending' || retryStatus === 'resumed'
              ? 'Resuming specialist…'
              : 'A safe automatic model wasn’t available.'}
      </StatusStrip>
    </div>
  );
}
