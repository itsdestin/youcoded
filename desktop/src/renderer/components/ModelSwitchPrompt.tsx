import { Button, Dialog } from './ui';
import { useEscClose } from '../hooks/use-esc-close';

/**
 * U11 — "This chat is too long for [new model]." Shown by the model picker when
 * a native chat would not fit the model the user just chose. Nothing has
 * changed yet: one button summarizes on the CURRENT model and then switches;
 * X or Esc keeps the current model and the chat exactly as they are.
 *
 * WHY a separate layer-3 dialog rather than inline text in the picker: the
 * picker's list stays usable underneath (pick a bigger model instead), and
 * X/Esc must close only this question, not the whole picker (LIFO Esc stack).
 *
 * While the summary runs the button is disabled and X/Esc means "stop and
 * stay" — the caller interrupts the summary. Copy approved on the Release 2
 * review deck (native-compaction-release2 B-2/B-3).
 */
export type ModelSwitchPromptState =
  | { kind: 'ask' }
  | { kind: 'working' }
  | { kind: 'error'; message: string };

export default function ModelSwitchPrompt({ open, currentLabel, targetLabel, state, onConfirm, onClose }: {
  open: boolean;
  currentLabel: string;
  targetLabel: string;
  state: ModelSwitchPromptState;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEscClose(open, onClose);
  const working = state.kind === 'working';
  return (
    <Dialog open={open} onClose={onClose} layer={3} size="prompt" title="Switch model" scrollBody={false}>
      <div className="p-5 space-y-4">
        <p className="text-sm text-fg">
          This chat is too long for <span className="font-medium">{targetLabel}</span>.{' '}
          <span className="font-medium">{currentLabel}</span> can summarize older messages first.
        </p>
        {working && (
          <p className="text-xs text-fg-muted" role="status">
            Summarizing… this can take a minute. Close to stop and stay on {currentLabel}.
          </p>
        )}
        {state.kind === 'error' && (
          <p className="text-xs text-destructive-fg" role="alert">{state.message}</p>
        )}
        {/* The only action, so it spans the popup (Destin, 2026-09-23). */}
        <Button variant="primary" className="w-full justify-center" onClick={onConfirm} disabled={working}>
          {working ? 'Summarizing…' : 'Summarize and switch'}
        </Button>
      </div>
    </Dialog>
  );
}

/** User-facing copy for a switch that did not happen. Specific where the cause
 *  is known; non-committal otherwise (docs/error-message-standards.md). Every
 *  line says the model did not change, because that is the one thing the user
 *  must not be wrong about. */
export function switchFailureMessage(reason: string, currentLabel: string, targetLabel: string, detail?: string): string {
  const stay = `Still using ${currentLabel}.`;
  switch (reason) {
    case 'turn-in-flight':
      return `Your assistant is still working. Wait for it to finish (or stop it), then try again. ${stay}`;
    case 'summary-failed':
      return `The summary didn't finish, so nothing changed. Try again. ${stay}`;
    case 'cannot-fit':
      return `Even after a summary, the most recent messages are too long for ${targetLabel}. ${stay}`;
    case 'too-small':
      return `${targetLabel} can't hold this chat's instructions and a reply. ${stay}`;
    case 'nothing-to-compact':
      return `There are no older messages to summarize, and the chat is too long for ${targetLabel}. ${stay}`;
    case 'not-live':
      return "This session isn't running, so the model can't be changed.";
    default:
      return detail ? `Couldn't switch models: ${detail}. ${stay}` : `Couldn't switch models. ${stay}`;
  }
}
