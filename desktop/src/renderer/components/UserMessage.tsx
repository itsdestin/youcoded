import React from 'react';
import { ChatMessage } from '../../shared/types';
import LinkableText from './LinkableText';
import { splitFlowingKeywords } from './FlowingKeywords';
import { formatBubbleTime } from '../utils/format-time';
import { detectFilepaths } from '../hooks/useInlineFilepathDetector';
import { FilepathToken } from './FilepathToken';

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

  // Detect filepaths in the (remaining) typed text and render each as a
  // clickable pill that opens in the artifact viewer, same as assistant
  // messages. Non-path spans keep the flowing-keyword + URL-link treatment.
  // NOTE: this covers the LIVE bubble; a reloaded-from-transcript message
  // loses attachment paths (the transcript stores images as blocks, not
  // paths), so pills there fall back to plain text.
  const matches = detectFilepaths(text);

  let body: React.ReactNode[];
  if (matches.length === 0) {
    body = renderTextRun(text, 't');
  } else {
    body = [];
    let cursor = 0;
    matches.forEach((m, mi) => {
      if (m.start > cursor) body.push(...renderTextRun(text.slice(cursor, m.start), `t${mi}`));
      body.push(<FilepathToken key={`p${mi}`} path={m.path} sessionId={sessionId} />);
      cursor = m.end;
    });
    if (cursor < text.length) body.push(...renderTextRun(text.slice(cursor), 'tend'));
  }
  body = [...attachmentPills, ...body];

  return (
    <div className="flex justify-end px-4 py-2">
      <div className="user-bubble max-w-[80%] break-words rounded-2xl rounded-br-sm bg-accent px-5 py-3 text-sm text-on-accent whitespace-pre-wrap">
        {/* WHY: Find indexes authored text, not the optional timestamp beside it. */}
        <span data-message-find-body="0" data-message-find-plain>{body}</span>
        {showTimestamps && (
          <div className="bubble-timestamp text-4xs text-on-accent/50 text-right mt-1 -mb-0.5 select-none leading-none">
            {formatBubbleTime(message.timestamp)}
          </div>
        )}
      </div>
    </div>
  );
});
