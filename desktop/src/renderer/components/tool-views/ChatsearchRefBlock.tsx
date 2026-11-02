// The reference block: past conversations the assistant names inside its own
// message, drawn where it named them.
//
// Compare surface 'chatsearch-present', Round 8, candidate A ("Boxed group") —
// Destin, 2026-08-27: "A is perfect." Each group is a bordered card sitting
// between the assistant's paragraphs, holding the SAME rows the search results
// card uses (ChatsearchRow, imported rather than re-drawn, so the two can never
// diverge).
//
// This is not a tool. The assistant writes a fenced `conversations` block into
// its message and the renderer swaps it for this — which is why it works on
// both lanes without the app having to hand Claude Code anything.
import { useResolvedConversations } from '../../hooks/useResolvedConversations';
import { useTagLabelIndex } from './chatsearch-tags';
import { ChatsearchRow } from './ChatsearchFindCard';
import { COPY } from '../../../shared/chatsearch-refs';

export default function ChatsearchRefBlock({ shortIds }: { shortIds: string[] }) {
  const { results, loading, unavailable } = useResolvedConversations(shortIds);
  const tagIndex = useTagLabelIndex();

  // Nothing id-shaped in the block, or a device that cannot resolve at all
  // (Android): render nothing and let the surrounding prose stand on its own.
  // The alternative — an empty bordered box — would read as a broken feature.
  if (!shortIds.length || unavailable) return null;
  if (loading) return <div className="my-2 text-xs text-fg-muted">{COPY.lookingUp(shortIds.length)}</div>;

  const rows = results.filter((r) => r.status === 'ok');
  if (!rows.length) return null;

  return (
    // conv-refs: a hook for the buddy's small window, which drops the frame around the rows (buddy.css).
    <div className="conv-refs my-2 rounded-lg border border-edge bg-well overflow-hidden">
      <ul className="flex flex-col gap-1.5 p-2">
        {rows.map((r, i) => <ChatsearchRow key={r.status === 'ok' ? r.id : i} r={r} tagIndex={tagIndex} />)}
      </ul>
    </div>
  );
}
