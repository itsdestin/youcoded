// ConversationsTab — flat list of past conversations scoped to one project
// (Task 3.1). The list is fetched ONCE by ProjectView (shared with the hero
// count + cached per project) and passed in as a prop — this tab no longer
// fetches on its own, which removed the duplicate enumeration that ran on every
// project switch / tab toggle.
//
// Each row is drawn like a Resume browser card (Destin, 2026-09-16): the same
// inset surface and border, bold title, tag row and dotted details line
// (SessionCardDetails.tsx, shared with ResumeBrowser.tsx). No first-message
// line: the Resume browser has none (Destin, 2026-09-16). No ●◐○ status glyphs.
import type { PastSession } from '../../../../shared/types';
import { SessionCardTags, SessionCardMeta } from '../../SessionCardDetails';
import { useTagRegistry } from '../../../hooks/useTagRegistry';

// The shared empty-state primitive (design guide G-18): every empty list goes
// through it rather than a bare muted paragraph. No action here on purpose —
// this tab has no "new conversation" callback (ProjectView passes only the
// list and the preview opener; New Conversation lives on the hero above).
import { EmptyState } from '../../ui';

interface ConversationsTabProps {
  // Lifted, cached list from ProjectView. null = still loading for this project.
  conversations: PastSession[] | null;
  onOpenPreview: (session: PastSession) => void;
}

export function ConversationsTab({ conversations, onOpenPreview }: ConversationsTabProps) {
  const loading = conversations === null;
  const rows = conversations ?? [];
  // Loaded once for the whole list; each card only looks tags up in it.
  const registry = useTagRegistry();

  return (
    <div className="flex flex-col h-full overflow-hidden px-2 sm:px-4 pt-1 pb-4 min-w-0 max-sm:h-auto max-sm:overflow-visible">
      {loading ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState message="No conversations in this project yet." />
      ) : (
        <div
          // p-2 -m-2 matches FilesTab's scroll box exactly. Without it the
          // scroll container's edge sat at the parent's full px-4 gutter, so the
          // scrollbar butted right up against the cards — while Files (which has
          // the offset) and Context (which scrolled the padded element itself)
          // each sat at a different distance. Same recipe in all three tabs =
          // one scrollbar position.
          className="flex-1 overflow-auto max-sm:overflow-visible flex flex-col gap-2 content-start p-2 -m-2"
        >
          {rows.map((c) => {
            const title = c.name?.trim() ? c.name : 'Untitled';
            return (
              // The Resume card's surface: bg-inset + border-edge-dim, hover
              // moves the border (ResumeBrowser.tsx explains why not
              // .layer-surface). shrink-0 so the scroll container doesn't
              // compress rows and clip their text.
              <button
                key={c.sessionId}
                type="button"
                className="w-full text-left shrink-0 rounded-lg border border-edge-dim bg-inset px-3 pt-2 pb-3 transition-colors hover:border-edge focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onClick={() => onOpenPreview(c)}
                title={title}
              >
                <span className="block py-1 text-sm-tight font-semibold text-fg truncate">{title}</span>
                <SessionCardTags session={c} tagsById={registry.byId} />
                {/* No project in the trail: this whole page is one project. */}
                <SessionCardMeta session={c} showProject={false} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
