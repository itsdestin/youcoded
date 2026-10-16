import { useEffect } from 'react';
import { useResolvedConversations } from '../../hooks/useResolvedConversations';
import SessionRefActions, { resumeBlockedReason } from './SessionRefActions';
import { formatRelativeTime } from '../../utils/format-time';
import { COPY } from '../../../shared/chatsearch-refs';
import { useTagLabelIndex, resolveChatsearchTags } from './chatsearch-tags';
import { ChatsearchMetaLine } from './ChatsearchMetaLine';
import type { TagRecord } from '../../../shared/tags';
import type { ResolvedConversation } from '../../../shared/chatsearch-refs';

// The owner-approved row (registry.tsx, compare surface 'chatsearch-results',
// Round 2 candidate `b-closed`): no leading mark, title, then the shared
// metadata line. ToolCard's own header already carries the "N past
// conversations" identity and the open/close chevron — this component is
// ONLY the rows, never its own card chrome (Task 4: two headers would say the
// same sentence twice and draw two chevrons for one control).
export function ChatsearchRow({ r, tagIndex }: { r: ResolvedConversation; tagIndex: Map<string, TagRecord> }) {
  // Destin (2026-08-27 gate, M-states): "should just hide dead." A row naming a
  // conversation this device has never heard of gives the reader nothing to do
  // and nothing to read — the id is not a name. Rendering nothing is honest
  // here BECAUSE the card header still counts what the search returned, so a
  // hidden row cannot silently shrink the total the user was told about.
  if (r.status !== 'ok') return null;
  const blocked = resumeBlockedReason(r);
  return (
    <li className="rounded-md bg-inset/50 px-2.5 py-2 flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs truncate text-fg">
          {r.title || <span className="italic text-fg-muted">{COPY.untitled}</span>}
        </div>
        <ChatsearchMetaLine
          tags={resolveChatsearchTags(r.tags, tagIndex)}
          blocked={blocked}
          project={r.projectName || COPY.noProject}
          date={formatRelativeTime(r.lastActive)}
          className="mt-0.5"
        />
      </div>
      <SessionRefActions conversation={r} />
    </li>
  );
}

/** Ten rows at the row height measured in the workbench (49px) plus the 4px
 *  gaps between them. A round pixel number rather than a computed one: the row
 *  is fixed-height by construction (two lines, one button row), and a measured
 *  container would cost a layout pass per render for a cap nobody tunes. */
const VISIBLE_ROWS = 10;
const ROWS_MAX_H = VISIBLE_ROWS * 49 + (VISIBLE_ROWS - 1) * 4;

export default function ChatsearchFindCard({ shortIds, onUnavailable }: { shortIds: string[]; onUnavailable?: () => void }) {
  const { results, loading, unavailable } = useResolvedConversations(shortIds);
  // One registry load for the whole card — rows share it rather than each
  // mounting their own useTagRegistry() (see chatsearch-tags.tsx).
  const tagIndex = useTagLabelIndex();
  useEffect(() => { if (unavailable) onUnavailable?.(); }, [unavailable, onUnavailable]);
  if (unavailable) return null; // ToolBody swaps to plain Bash
  if (loading) return <div className="px-1 py-2 text-xs text-fg-muted">{COPY.lookingUp(shortIds.length)}</div>;
  // Hidden rows are counted, never silently dropped — the card header says how
  // many the search found, and a list quietly shorter than its own heading is
  // the same defect as a heading promising a list that isn't there.
  const hidden = results.filter((r) => r.status !== 'ok').length;
  // Destin (2026-08-27, dev instance): "should show only 10 conversations at a
  // time and scroll after that." A search can return dozens; without a cap the
  // card pushes the whole conversation off screen. The height is ten rows at
  // the current row height, and the container only appears once there are more
  // than ten — otherwise a short list would carry a scrollbar it never needs.
  const scrolls = results.filter((r) => r.status === 'ok').length > VISIBLE_ROWS;
  return (
    <>
      {/* The height is an inline style, NOT a Tailwind arbitrary value: the
          class scanner only sees literal source text, so `max-h-[${'${n}'}px]`
          built from a constant generates no CSS at all and the cap would
          silently do nothing. */}
      <ul
        className={`space-y-1${scrolls ? ' scroll-mask-y overflow-y-auto pr-1' : ''}`}
        style={scrolls ? { maxHeight: ROWS_MAX_H } : undefined}
      >
        {results.map((r, i) => <ChatsearchRow key={shortIds[i] ?? i} r={r} tagIndex={tagIndex} />)}
      </ul>
      {hidden > 0 && <div className="px-1 pt-1 text-3xs text-fg-muted">{COPY.hiddenNotHere(hidden)}</div>}
    </>
  );
}
