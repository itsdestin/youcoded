import type { SessionChatState, TimelineEntry, AssistantTurn, CopyPickerOption } from '../state/chat-types';

// Extract all text from an assistant turn. Joins text segments in order;
// plan segments contribute their markdown content; tool groups are skipped
// because tool calls aren't meaningful to copy as "Claude's response".
function turnFullText(turn: AssistantTurn): string {
  const parts: string[] = [];
  for (const seg of turn.segments) {
    if (seg.type === 'text') parts.push(seg.content);
    else if (seg.type === 'plan') parts.push(seg.content);
    // 'tool-group' skipped — tool IO isn't copyable "response" content
  }
  return parts.join('\n\n');
}

// Parse ```language\n...\n``` fenced code blocks out of markdown text.
// Returns the blocks with their language labels. Doesn't care about exact
// whitespace — good enough for user-facing copy.
function extractCodeBlocks(markdown: string): { language: string; content: string }[] {
  const blocks: { language: string; content: string }[] = [];
  const re = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    blocks.push({ language: match[1] || 'text', content: match[2] });
  }
  return blocks;
}

function preview(text: string, max = 80): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max) + '…' : collapsed;
}

export type CopyPayload =
  | { mode: 'empty' }                                             // No assistant turn found
  | { mode: 'single'; content: string; label: string }            // Single block, copy directly
  | { mode: 'picker'; options: CopyPickerOption[] };               // Multiple blocks — show picker

/**
 * Find the Nth-latest assistant turn (N=1 is the most recent) in a session's
 * timeline and build a copy payload. If the turn has code blocks, returns a
 * picker with "Full response" + each block. Otherwise, a single full-text payload.
 *
 * Called by the /copy dispatcher. Kept as a pure function so it's trivially testable.
 */
export function buildCopyPayload(session: SessionChatState | undefined, n: number): CopyPayload {
  if (!session) return { mode: 'empty' };
  // Walk timeline backwards to find the Nth assistant-turn entry.
  let remaining = Math.max(1, n);
  let matched: TimelineEntry | null = null;
  for (let i = session.timeline.length - 1; i >= 0; i--) {
    const entry = session.timeline[i];
    if (entry.kind === 'assistant-turn') {
      remaining--;
      if (remaining === 0) {
        matched = entry;
        break;
      }
    }
  }
  if (!matched || matched.kind !== 'assistant-turn') return { mode: 'empty' };
  const turn = session.assistantTurns.get(matched.turnId);
  if (!turn) return { mode: 'empty' };

  const fullText = turnFullText(turn);
  if (!fullText.trim()) return { mode: 'empty' };

  const blocks = extractCodeBlocks(fullText);
  if (blocks.length === 0) {
    // No code — just copy the full response directly
    return { mode: 'single', content: fullText, label: 'Response' };
  }

  // Multiple blocks — let user choose
  const options: CopyPickerOption[] = [
    {
      id: 'full',
      label: 'Full response',
      preview: preview(fullText),
      content: fullText,
    },
    ...blocks.map((b, idx) => ({
      id: `block-${idx}`,
      label: `Code block ${idx + 1}${b.language !== 'text' ? ` (${b.language})` : ''}`,
      preview: preview(b.content),
      content: b.content,
    })),
  ];
  return { mode: 'picker', options };
}
