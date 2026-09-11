// ConversationsTab — flat list of past conversations scoped to one project
// (Task 3.1). The list is fetched ONCE by ProjectView (shared with the hero
// count + cached per project) and passed in as a prop — this tab no longer
// fetches on its own, which removed the duplicate enumeration that ran on every
// project switch / tab toggle. Each row matches the prototype's convRow: an icon
// avatar + title/time + a one-line preview. Rows use
// `bg-panel border border-edge-dim rounded-lg` (NOT .layer-surface — its
// overflow:hidden + flex compression clips the text). No ●◐○ status glyphs.
import type { PastSession } from '../../../../shared/types';
// Relative-time formatter for the per-row time hint (shared util).
import { formatRelativeTime } from '../../../utils/format-time';

// Enriched session shape returned by project:list-conversations.
interface ConversationSummary extends PastSession {
  preview?: string;
}

// Chat glyph for the row avatar — shared with the segmented control (../icons).
import { ChatIcon } from '../icons';
// The shared empty-state primitive (design guide G-18): every empty list goes
// through it rather than a bare muted paragraph. No action here on purpose —
// this tab has no "new conversation" callback (ProjectView passes only the
// list and the preview opener; New Conversation lives on the hero above).
import { EmptyState } from '../../ui';

interface ConversationsTabProps {
  // Lifted, cached list from ProjectView. null = still loading for this project.
  conversations: ConversationSummary[] | null;
  onOpenPreview: (session: PastSession) => void;
}

export function ConversationsTab({ conversations, onOpenPreview }: ConversationsTabProps) {
  const loading = conversations === null;
  const rows = conversations ?? [];

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
              // bg-panel + border + rounded-lg (NOT layer-surface). shrink-0 so
              // the scroll container doesn't compress rows and clip their text.
              <button
                key={c.sessionId}
                type="button"
                className="w-full text-left flex items-start gap-3 bg-panel border border-edge-dim rounded-lg p-3 shrink-0 hover:bg-inset hover:border-edge transition-colors"
                onClick={() => onOpenPreview(c)}
                title={title}
              >
                <span className="w-9 h-9 rounded-md shrink-0 inline-flex items-center justify-center bg-inset text-fg-dim mt-0.5">
                  <ChatIcon size={17} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2 justify-between">
                    <span className="text-[13.5px] font-medium text-fg truncate">{title}</span>
                    <span className="text-2xs text-fg-muted shrink-0">
                      {formatRelativeTime(c.lastModified)}
                    </span>
                  </span>
                  {c.preview ? (
                    <span className="block text-xs text-fg-2 truncate mt-0.5">{c.preview}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
