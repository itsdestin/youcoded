// CommentList — the thread of comments under a marketplace item. Grew out of
// ReviewList (avatar · login · text · date · report) when the overhaul
// (2026-08-27, decision #4) replaced star reviews with one-tap thumbs plus
// an open comment thread: same row, no stars — and NO report control.
//
// There is deliberately no Report button here (spec §5). It is not merely that
// the backend is missing: the inherited ReportReviewButton files a report keyed
// to (rating_user_id, rating_plugin_id), so "report this comment" would file a
// complaint against that person's STAR RATING, and an admin resolving it
// (DELETE /admin/ratings/...) would hide their rating while the comment stayed
// up. A mis-aimed button, not a dead one. Takedown in v1 is the admin route
// DELETE /admin/comments/:id; a real reporting flow needs a reports schema that
// can key to a comment id (ROADMAP).
//
//   - Fetches via apiClient.listComments() on mount and whenever refreshKey changes
//   - LoadingState / EmptyState / error, populated list
//   - React auto-escapes text content so comment text is XSS-safe as written
//   - AbortController cancels the in-flight fetch on unmount or refreshKey change

import React, { useEffect, useMemo, useState } from 'react';
import {
  createMarketplaceApiClient,
  MARKETPLACE_API_HOST,
  type CommentEntry,
} from '../../state/marketplace-api-client';
import { CARD_LEVEL_2, LoadingState, EmptyState, FieldError } from '../ui';

// Unauthenticated client — listComments is a public endpoint
const apiClient = createMarketplaceApiClient({
  host: MARKETPLACE_API_HOST,
  getToken: () => null,
});

/** "3 days ago" / "2 weeks ago" — comments are conversation, so relative
 *  time reads better than a full date; the exact date sits in the title. */
function relativeDate(unixSec: number): { text: string; title: string } {
  const d = new Date(unixSec * 1000);
  const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  const text = days === 0 ? 'today' : days === 1 ? 'yesterday' : days < 14 ? `${days} days ago` : days < 60 ? `${Math.floor(days / 7)} weeks ago` : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return { text, title: d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) };
}

function CommentRow({ c, pluginId, held = false }: { c: CommentEntry; pluginId: string; held?: boolean }) {
  const [avatarFailed, setAvatarFailed] = React.useState(false);
  const when = relativeDate(c.created_at);
  return (
    // WHY each comment its own nested box, not rows split by full-width lines: a line never
    // crosses a card (guide "Card levels"; decisions "Card levels (the Settings rule)"), and
    // everything boxed inside a first-level card takes the one nested look (CARD_LEVEL_2).
    <div className={`${CARD_LEVEL_2} flex flex-col gap-1 p-3${held ? ' opacity-80' : ''}`} data-comment data-held={held || undefined}>
      <div className="flex items-center gap-2">
        {c.user_avatar_url && !avatarFailed ? (
          <img src={c.user_avatar_url} alt={c.user_login} onError={() => setAvatarFailed(true)} className="w-6 h-6 rounded-full shrink-0 object-cover" />
        ) : (
          <span className="w-6 h-6 rounded-full bg-accent/20 shrink-0 flex items-center justify-center text-2xs font-bold text-accent">
            {c.user_login.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="text-xs font-medium text-fg">{c.user_login}</span>
        {/* The author's own held comment. Said in the row, not only in the
            post-time toast, because the toast is gone the moment the page is
            reopened — and a comment that silently vanished reads as "deleted". */}
        {held && <span className="text-2xs text-fg-muted">Held for review · only you can see it</span>}
        <span className="ml-auto text-2xs text-fg-muted shrink-0" title={when.title}>{when.text}</span>
      </div>
      <p className="text-sm text-fg-2 leading-relaxed whitespace-pre-wrap pl-8">{c.text}</p>
    </div>
  );
}

interface CommentListProps {
  pluginId: string;
  /** Bump to re-fetch (e.g. after the user posts). */
  refreshKey?: number;
  /** The caller's OWN comments the Worker is holding for review — never in the
   *  public list, so they are drawn from this device's record instead
   *  (state/held-comments.ts). Rendered first, marked as held. */
  held?: CommentEntry[];
  /** Fired with the ids of held comments that the public list now contains —
   *  the caller forgets them so they are not shown twice. */
  onHeldListed?: (ids: string[]) => void;
}

type FetchState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'loaded'; comments: CommentEntry[]; total?: number }
  | { status: 'error' };

export default function CommentList({ pluginId, refreshKey = 0, held = [], onHeldListed }: CommentListProps) {
  const [state, setState] = useState<FetchState>({ status: 'loading' });

  // A held comment that the public list now carries (approved, or never held
  // on the server's side) is shown ONCE, from the list. The caller is told so
  // it can drop its local copy.
  const listedIds = useMemo(
    () => new Set(state.status === 'loaded' ? state.comments.map((c) => c.id) : []),
    [state],
  );
  const heldToShow = held.filter((c) => !listedIds.has(c.id));
  useEffect(() => {
    if (!onHeldListed) return;
    const dup = held.filter((c) => listedIds.has(c.id)).map((c) => c.id);
    if (dup.length > 0) onHeldListed(dup);
  }, [held, listedIds, onHeldListed]);
  const heldRows = heldToShow.map((c) => <CommentRow key={c.id} c={c} pluginId={pluginId} held />);

  useEffect(() => {
    setState({ status: 'loading' });
    const controller = new AbortController();
    let cancelled = false;
    apiClient.listComments(pluginId, controller.signal)
      .then(({ comments, total }) => {
        if (cancelled) return;
        setState(comments.length === 0 ? { status: 'empty' } : { status: 'loaded', comments, total });
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof Error && err.name === 'AbortError')) return;
        setState({ status: 'error' });
      });
    return () => { cancelled = true; controller.abort(); };
  }, [pluginId, refreshKey]);

  return (
    <div>
      {state.status === 'loading' && <LoadingState variant="inline" what="comments" />}
      {/* "No comments yet" would be a lie above the author's own held comment. */}
      {state.status === 'empty' && heldRows.length === 0 && <EmptyState variant="inline" message="No comments yet — ask a question or say how it went." />}
      {state.status === 'empty' && heldRows.length > 0 && <div className="flex flex-col gap-2">{heldRows}</div>}
      {/* WHY FieldError (guide: no red/coloured body text for messages) */}
      {state.status === 'error' && <FieldError as="p">Couldn't load comments.</FieldError>}
      {state.status === 'loaded' && (
        // 8px between neighbouring boxes (decisions "Popup spacing", SP-5).
        <div className="flex flex-col gap-2">
          {heldRows}
          {state.comments.map((c) => <CommentRow key={c.id} c={c} pluginId={pluginId} />)}
          {/* The Worker caps the list at the 50 most recent and, since 2026-09-01,
              sends the full count beside it. Before that a busy thread simply
              stopped at 50 with nothing marking the cut, so a reader could not
              tell "50 comments" from "more than I can see". Only rendered when
              the count is actually larger — an older Worker sends no `total`,
              and a thread that fits needs no caption. */}
          {typeof state.total === 'number' && state.total > state.comments.length && (
            <p className="pt-1 text-xs text-fg-muted" data-comments-cut>
              Showing the {state.comments.length} most recent of {state.total.toLocaleString()} comments.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
