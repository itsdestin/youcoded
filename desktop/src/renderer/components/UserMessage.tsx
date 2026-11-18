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
import { Button } from './ui';

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
  // WHY a strip INSIDE the bubble (Destin, pinned-bubbles-review-2#N-1/#N-2, 2026-11-18: "put it inside the chat message/bubble at the bottom,
  // full width of the bubble. dark send again on the right side with light dismiss on left. no x"): the note belongs to this message, so it is
  // the bubble's own foot — tinted with the status colour (amber = a doubt, red = known not received; the hue in the tint, never the words), its
  // buttons at the right with the light one first and the dark Send again last.
  const notSent = sendNote === 'not-sent';
  const note = sendNote && (
    <div role="status" data-send-note={sendNote}
      className={`-mx-5 -mb-3 mt-3 px-5 py-2.5 border-t whitespace-normal select-text ${notSent ? 'bg-destructive/35 border-destructive/60' : 'bg-amber-500/35 border-amber-500/60'}`}>
      <div className="text-xs">{notSent ? "This didn't send — your computer never received it." : 'Not sure this was sent.'}</div>
      {(onDiscard || onDismiss || onSendAgain) && (
        <div data-parts-agree="send note buttons" className="mt-2 flex flex-wrap items-center justify-end gap-2">
          {onDiscard && <Button variant="on-accent-outline" size="sm" className="whitespace-nowrap" onClick={onDiscard} aria-label="Discard unsent message">Discard</Button>}
          {onDismiss && <Button variant="on-accent-outline" size="sm" className="whitespace-nowrap" onClick={onDismiss}>Dismiss</Button>}
          {onSendAgain && <Button variant="on-accent-solid" size="sm" className="whitespace-nowrap" onClick={onSendAgain}>Send again</Button>}
        </div>
      )}
    </div>
  );

  const bubble = (
    <div className={`user-bubble max-w-[80%] break-words rounded-2xl rounded-br-sm bg-accent px-5 py-3 text-sm text-on-accent whitespace-pre-wrap${note ? ' overflow-hidden' : ''}`}>
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
