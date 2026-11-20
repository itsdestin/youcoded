import React from 'react';
import { ChatMessage } from '../../shared/types';
import LinkableText from './LinkableText';
import { splitFlowingKeywords } from './FlowingKeywords';
import { formatBubbleTime } from '../utils/format-time';
import { detectFilepaths } from '../hooks/useInlineFilepathDetector';
import { FilepathToken } from './FilepathToken';
// Round 2 (Destin): a reference token typed via "Ask about this" / "Send to
// assistant" rides in message.content as an invisible marker (compose-ref.ts)
// — decode it back into the SAME pill the composer showed, inline in the
// sentence, so a reference reads identically before and after sending.
import { splitComposeRefs, jumpToRef, type ComposeRef } from './context-menu/compose-ref';
import { useOpenFilepath } from '../hooks/useOpenFilepath';
import { TokenPill } from './comments/TokenPill';
import { Button, Callout } from './ui';

interface Props {
  message: ChatMessage;
  sessionId: string;
  showTimestamps: boolean;
  /**
   * What the computer's record leaves in doubt about this message (one-core R5-4b): `unsure` (it could not tell) or `not-sent` (it shows the computer
   * never got it). Drawn under the bubble with a "Send again" button; absent once the message is confirmed.
   */
  sendNote?: 'unsure' | 'not-sent';
  /** "Send again": the person's own decision, never automatic (a duplicate is worse than a wait). */
  onSendAgain?: () => void;
  /** "Discard" (only on `not-sent`): the unsent bubble goes from this screen; its words return to an empty composer. Never sends. */
  onDiscard?: () => void;
  /** "Dismiss" (only on `unsure`): hides the note and keeps the bubble, since the message may well have arrived. Never sends. */
  onDismiss?: () => void;
}

// Render a plain-text run with the existing treatment: flowing-keyword spans +
// URL linking. Used for the text BETWEEN detected filepaths.
function renderTextRun(text: string, keyPrefix: string): React.ReactNode[] {
  return splitFlowingKeywords(text).map((seg, i) =>
    seg.flowing ? (
      <span key={`${keyPrefix}-${i}`} className="flowing-word">{seg.text}</span>
    ) : (
      <LinkableText key={`${keyPrefix}-${i}`} text={seg.text} />
    ),
  );
}

export default React.memo(function UserMessage({ message, sessionId, showTimestamps, sendNote, onSendAgain, onDiscard, onDismiss }: Props) {
  // A chip click opens its file when it isn't already open, then jumps to
  // the source text (compose-ref.ts "Chip ↔ source text").
  const openFile = useOpenFilepath(sessionId);
  const content = message.content;

  // Attached files: message.attachments carries the EXACT picker paths (which
  // routinely contain spaces the joined content string can't be split back out
  // of). By construction (InputBar), content = attachments space-joined + the
  // typed text — strip the known prefix so the remainder is just the text.
  // Falls back gracefully: if the prefix doesn't line up, everything renders
  // through the regex path like before.
  const attachments = message.attachments ?? [];
  let text = content;
  const attachmentPills: React.ReactNode[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const p = attachments[i];
    if (!text.startsWith(p)) break;
    text = text.slice(p.length).replace(/^ /, '');
    attachmentPills.push(<FilepathToken key={`a${i}`} path={p} sessionId={sessionId} />);
    if (i < attachments.length - 1 || text.length > 0) attachmentPills.push(' ');
  }

  // Detect filepaths in a plain-text segment and render each as a clickable
  // pill that opens in the artifact viewer, same as assistant messages.
  // Non-path spans keep the flowing-keyword + URL-link treatment. NOTE: this
  // covers the LIVE bubble; a reloaded-from-transcript message loses
  // attachment paths (the transcript stores images as blocks, not paths), so
  // pills there fall back to plain text.
  function renderProseSegment(segment: string, keyPrefix: string): React.ReactNode[] {
    const matches = detectFilepaths(segment);
    if (matches.length === 0) return renderTextRun(segment, keyPrefix);
    const out: React.ReactNode[] = [];
    let cursor = 0;
    matches.forEach((m, mi) => {
      if (m.start > cursor) out.push(...renderTextRun(segment.slice(cursor, m.start), `${keyPrefix}t${mi}`));
      out.push(<FilepathToken key={`${keyPrefix}p${mi}`} path={m.path} sessionId={sessionId} />);
      cursor = m.end;
    });
    if (cursor < segment.length) out.push(...renderTextRun(segment.slice(cursor), `${keyPrefix}end`));
    return out;
  }

  // Reference tokens (compose-ref.ts) split out from the REMAINING text —
  // they can sit anywhere, interleaved with ordinary words and filepaths.
  // The pill uses tone="on-accent": this bubble is bg-accent, and the
  // composer's neutral pill (tuned for a panel background) would sit at low
  // contrast on it — same reasoning as Button's own on-accent variant.
  const body: React.ReactNode[] = [...attachmentPills];
  const segs = splitComposeRefs(text);
  const pill = (ref: ComposeRef, key: string) => (
    <TokenPill key={key} ref_={ref} onJump={(r) => jumpToRef(r, openFile)} tone="on-accent" />
  );
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.type === 'ref') body.push(pill(seg.ref, `ref-${seg.ref.id}-${i}`));
    else body.push(...renderProseSegment(seg.value, `s${i}-`));
  }

  // The wording says what is KNOWN and how (error-message-standards.md): "not-sent" is the computer's record showing it never arrived; "unsure" is
  // the record unable to tell (it restarted, the question could not be asked, or no echo came back in time), so it claims nothing about a cause.
  // WHY the app's own notice card (Callout), unchanged, sitting INSIDE the bubble at its foot (Destin, pinned-bubbles-review-3#B-1, 2026-11-18:
  // "i just wanted the error cards from before to sit inside the message bubbles at the bottom"; review-2#N-1: "full width of the bubble. dark
  // send again on the right side with light dismiss on left. no x"). The card is the same one every other warning/error uses (red = known not
  // received, amber = a doubt): outlined Dismiss/Discard first, filled Send again last, and no ✕.
  // WHY its colours come from the bubble (surface="on-accent", the on-accent buttons), Destin, pinned-bubbles-review-7#V-3 after rounds 4–6
  // ("these look so dark", "almost looks too light", "in regular youcoded i can barely tell the red/yellow apart"): the page's own tint sat
  // inside a bubble of the opposite brightness and fought it. The fill is now the bubble colour blended toward amber/red with a solid
  // amber/red outline, and the words and buttons use the bubble's text colour, as the file and reference pills in this bubble already do.
  const notSent = sendNote === 'not-sent';
  const note = sendNote && (
    <div className="mt-2.5 whitespace-normal select-text" data-send-note={sendNote}>
      <Callout tone={notSent ? 'danger' : 'warning'} surface="on-accent" compact role="status"
        actions={(onDiscard || onDismiss || onSendAgain) && <>
          {onDiscard && <Button variant="on-accent-outline" size="sm" className="whitespace-nowrap" onClick={onDiscard} aria-label="Discard unsent message">Discard</Button>}
          {onDismiss && <Button variant="on-accent-outline" size="sm" className="whitespace-nowrap" onClick={onDismiss}>Dismiss</Button>}
          {onSendAgain && <Button variant="on-accent-solid" size="sm" className="whitespace-nowrap" onClick={onSendAgain}>Send again</Button>}
        </>}>
        {notSent ? "This didn't send — your computer never received it." : 'Not sure this was sent.'}
      </Callout>
    </div>
  );

  const bubble = (
    <div className="user-bubble max-w-[80%] break-words rounded-2xl rounded-br-sm bg-accent px-5 py-3 text-sm text-on-accent whitespace-pre-wrap">
      {/* WHY: Find indexes authored text, not the optional timestamp beside it. */}
      <span data-message-find-body="0" data-message-find-plain>{body}</span>
      {showTimestamps && (
        <div className="bubble-timestamp text-4xs text-on-accent/50 text-right mt-1 -mb-0.5 select-none leading-none">
          {formatBubbleTime(message.timestamp)}
        </div>
      )}
      {note}
    </div>
  );
  return <div className="flex justify-end px-4 py-2">{bubble}</div>;
});
