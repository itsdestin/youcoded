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
import React, { useRef } from 'react';
import type { PastSession } from '../../../../shared/types';
import type { TagRecord } from '../../../../shared/tags';
import { SessionCardTags, SessionCardMeta, SessionCardTitle, SESSION_CARD_SURFACE } from '../../SessionCardDetails';
import { useTagRegistry } from '../../../hooks/useTagRegistry';
import { useChunkedReveal } from '../../../hooks/use-chunked-reveal';
import { useNarrowViewport } from '../../../hooks/use-narrow-viewport';

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

// WHY (render-cost consolidation 2026-09-18): this tab drew every conversation
// on every visit — 838 cards for youcoded-dev — then drew them all again when
// the tag list arrived. It now draws REVEAL_CHUNK at a time (the Resume
// browser's measured approach) and each card only when something it shows changes.
const ConversationRow = React.memo(function ConversationRow({ session: c, tagsById, onOpenPreview }: {
  session: PastSession;
  tagsById: ReadonlyMap<string, TagRecord>;
  onOpenPreview: (s: PastSession) => void;
}) {
  const title = c.name?.trim() ? c.name : 'Untitled';
  return (
    // The Resume card's surface (SessionCardDetails.tsx; ResumeBrowser.tsx
    // explains why not .layer-surface). shrink-0 so the scroll container
    // doesn't compress rows and clip their text.
    <button
      type="button"
      title={title}
      onClick={() => onOpenPreview(c)}
      className={`w-full text-left shrink-0 ${SESSION_CARD_SURFACE} px-3 pt-2 pb-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
    >
      <SessionCardTitle title={title} />
      <SessionCardTags session={c} tagsById={tagsById} />
      {/* No project in the trail: this whole page is one project. */}
      <SessionCardMeta session={c} showProject={false} />
    </button>
  );
}, (a, b) => a.session === b.session && a.onOpenPreview === b.onOpenPreview
  // Only the tags THIS row shows matter; a registry change for other tags
  // (or a fresh, equal Map when the list first arrives) must not redraw 50 cards.
  && (a.session.tags ?? []).every((id) => a.tagsById.get(id) === b.tagsById.get(id)));

function ConversationsTabImpl({ conversations, onOpenPreview }: ConversationsTabProps) {
  const loading = conversations === null;
  const rows = conversations ?? [];
  // Loaded once for the whole list (one shared store); each card only looks
  // tags up in it.
  const registry = useTagRegistry();

  // WHY two roots: at 640px and up this tab's own box scrolls, so the reveal
  // watches it. Below 640px the page's <main> scrolls instead
  // (ProjectView.tsx, `max-sm:overflow-y-auto`) and this box is overflow-visible,
  // so the reveal watches the viewport (a ref pointing at nothing = viewport).
  // Trade-off: the viewport's 400px margin does not reach through <main>'s own
  // scroll clip, so on a phone the next chunk arrives when the sentinel is
  // actually visible rather than 400px early. It still always arrives. <main>
  // carries no ref today; threading one down for that head start is not worth
  // a new prop — revisit only if Destin notices it.
  const scrollRef = useRef<HTMLDivElement>(null);
  const noRoot = useRef<HTMLElement | null>(null);
  const narrow = useNarrowViewport();
  // resetKey is constant: there is no search here, and a project switch
  // remounts this tab (ProjectView keys it by project), which starts a fresh
  // window at the top.
  const { visible, hasMore, sentinelRef } = useChunkedReveal(rows, {
    resetKey: '',
    rootRef: narrow ? noRoot : scrollRef,
  });

  return (
    <div className="flex flex-col h-full overflow-hidden px-2 sm:px-4 pt-1 pb-4 min-w-0 max-sm:h-auto max-sm:overflow-visible">
      {loading ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState message="No conversations in this project yet." />
      ) : (
        <div
          ref={scrollRef}
          // p-2 -m-2 matches FilesTab's scroll box exactly. Without it the
          // scroll container's edge sat at the parent's full px-4 gutter, so the
          // scrollbar butted right up against the cards — while Files (which has
          // the offset) and Context (which scrolled the padded element itself)
          // each sat at a different distance. Same recipe in all three tabs =
          // one scrollbar position.
          className="flex-1 overflow-auto max-sm:overflow-visible flex flex-col gap-2 content-start p-2 -m-2"
        >
          {visible.map((c) => (
            <ConversationRow key={c.sessionId} session={c} tagsById={registry.byId} onOpenPreview={onOpenPreview} />
          ))}
          {/* Reaching this (or 400px before it) draws the next chunk. */}
          {hasMore && <div ref={sentinelRef} aria-hidden className="h-px shrink-0" />}
        </div>
      )}
    </div>
  );
}

// WHY memo: ProjectView re-renders on every file-state change (it reads
// useArtifact()), and both props are already stable — `conversations` is
// state, `onOpenPreview` is the raw setPreviewSession setter — so this tab now
// skips those renders entirely.
export const ConversationsTab = React.memo(ConversationsTabImpl);
