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
import { splitComposeRefs, jumpToRef } from './context-menu/compose-ref';
import { useOpenFilepath } from '../hooks/useOpenFilepath';
import { TokenPill } from './comments/TokenPill';

interface Props {
  message: ChatMessage;
  sessionId: string;
  showTimestamps: boolean;
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

export default React.memo(function UserMessage({ message, sessionId, showTimestamps }: Props) {
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
  splitComposeRefs(text).forEach((seg, i) => {
    if (seg.type === 'ref') {
      body.push(<TokenPill key={`ref-${seg.ref.id}-${i}`} ref_={seg.ref} onJump={(r) => jumpToRef(r, openFile)} tone="on-accent" />);
    } else {
      body.push(...renderProseSegment(seg.value, `s${i}-`));
    }
  });

  return (
    <div className="flex justify-end px-4 py-2">
      <div className="user-bubble max-w-[80%] break-words rounded-2xl rounded-br-sm bg-accent px-5 py-3 text-sm text-on-accent whitespace-pre-wrap">
        {body}
        {showTimestamps && (
          <div className="bubble-timestamp text-4xs text-on-accent/50 text-right mt-1 -mb-0.5 select-none leading-none">
            {formatBubbleTime(message.timestamp)}
          </div>
        )}
      </div>
    </div>
  );
});
