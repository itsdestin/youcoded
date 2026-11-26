// The red card in the chat for "Couldn't compact / clear this conversation" (waiting-notice T4, deck L-sort-failed / R-card).
//
// WHY ErrorState and nothing of our own: the deck's choice c-card is "the app's existing red error card", the same look as the
// AI-service error card. The words come from notice-words (shared sentences); the computer's own reason, when there is one, is
// only ever folded under "Details" (the one approved place for technical text).
import React from 'react';
import { ErrorState } from './ui/states';
import { controlFailureWords } from '../utils/notice-words';
import type { ControlFailureOp, ControlFailureWhy } from '../state/chat-types';

interface Props {
  op: ControlFailureOp;
  why?: ControlFailureWhy;
  detail?: string;
  /** Resolves true when the retry worked (the entry is then removed by the reducer, so nothing here needs to react). */
  onTryAgain: () => Promise<boolean>;
}

function ControlFailureCard({ op, why, detail, onTryAgain }: Props) {
  // WHY busy: a second press while the first retry is running would start a second compaction.
  const [busy, setBusy] = React.useState(false);
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);
  return (
    <div className="px-4 py-1" data-control-failure={op}>
      <ErrorState
        variant="block"
        message={controlFailureWords(op, why)}
        details={detail}
        busy={busy}
        onRetry={() => { setBusy(true); void onTryAgain().finally(() => { if (mounted.current) setBusy(false); }); }}
      />
    </div>
  );
}

export default React.memo(ControlFailureCard);
