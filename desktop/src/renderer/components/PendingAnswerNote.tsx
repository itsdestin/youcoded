import { useEffect, useState } from 'react';

/** One-core R6-2: a phone drew a permission answer and the computer has not confirmed it yet. Drawn only after a short delay, so a quick confirmation
 *  (the usual case) never flashes a line that is gone a moment later. */
export default function PendingAnswerNote() {
  const [late, setLate] = useState(false);
  useEffect(() => { const t = setTimeout(() => setLate(true), 700); return () => clearTimeout(t); }, []);
  if (!late) return null;
  return <div className="px-3 pb-2 text-xs text-fg-dim" data-testid="tool-card-answer-pending">Waiting for your computer to confirm your answer</div>;
}
