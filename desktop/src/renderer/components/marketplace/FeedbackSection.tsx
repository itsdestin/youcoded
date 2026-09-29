// Feedback — the section that replaced "Reviews" on the detail page
// (design 2026-08-27, decision #4): one-tap 👍/👎 plus an open comment
// thread. Thumbs still require install + sign-in (the server enforces the
// same rule ratings had, so strangers can't game the number); comments
// require sign-in only. The star widget and the review modal are gone.
//
// Copy rule (G-19): "Helpful 92%" then a muted "402 votes" — never "92% (402)".
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount } from '../../state/account-context';
import { useMarketplaceStats } from '../../state/marketplace-stats-context';
import { forgetHeldComments, readHeldComments, rememberHeldComment, type HeldComment } from '../../state/held-comments';
import type { CommentEntry } from '../../state/marketplace-api-client';
import { Button, SectionLabel, Textarea } from '../ui';
import CommentList from './CommentList';
import SignInPromptModal from './SignInPromptModal';

/** This device's localStorage, or null where it is unavailable (some WebView
 *  privacy modes throw on the accessor itself). Without it a held comment is
 *  remembered for this mount only — the old behaviour, never a broken page. */
function heldStorage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

function ThumbIcon({ down = false }: { down?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={down ? { transform: 'scaleY(-1)' } : undefined} aria-hidden>
      <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" />
      <path d="M7 10l4-7a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1.2 7a2 2 0 0 1-2 1.7H7" />
    </svg>
  );
}

/** The one-line summary used on cards and in the section header. Returns
 *  null when there are no votes yet, so nothing renders instead of "0%". */
export function thumbsSummary(up?: number, down?: number): { pct: number; total: number; up: number } | null {
  const u = up ?? 0; const d = down ?? 0;
  const total = u + d;
  if (total === 0) return null;
  return { pct: Math.round((u / total) * 100), total, up: u };
}

/** Below this many votes a percentage is theatre: one up-vote is not "100%",
 *  and "1 votes" is not English. */
export const MIN_VOTES_FOR_PCT = 5;

/** Cards show only the percentage (the vote count sat between the % and the
 *  install count and read as one run of digits); the detail page shows both.
 *
 *  EXCEPT below MIN_VOTES_FOR_PCT, where a percentage is a lie the card cannot
 *  qualify: one like rendered "100%", which reads as "everyone loved this"
 *  rather than "one person clicked". Under the threshold the card shows the raw
 *  count instead — "1" next to a thumb is honest and unmistakably not a
 *  percentage. */
export function ThumbsSummary({ up, down, size = 'sm', showTotal = false }: { up?: number; down?: number; size?: 'sm' | 'md'; showTotal?: boolean }) {
  const s = thumbsSummary(up, down);
  if (!s) return null;
  const cls = size === 'md' ? 'text-sm' : 'text-xs';
  const low = s.total < MIN_VOTES_FOR_PCT;
  const title = low
    ? `${s.up} of ${s.total} ${s.total === 1 ? 'person' : 'people'} who installed this found it helpful`
    : `${s.pct}% of ${s.total.toLocaleString()} people who installed this found it helpful`;
  return (
    <span className={`inline-flex items-center gap-1 ${cls} text-fg-dim whitespace-nowrap`} title={title} data-thumbs>
      <span className="inline-flex text-fg-dim"><ThumbIcon /></span>
      <span className="text-fg-2">{low ? s.up : `${s.pct}%`}</span>
      {showTotal && !low && <span className="text-fg-muted ml-1">{s.total.toLocaleString()}</span>}
    </span>
  );
}

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** The LOW-COUNT summary only. At or above MIN_VOTES_FOR_PCT this returns null
 *  and the caller renders the approved G-19 markup instead ("Helpful 92%" then a
 *  muted "402 votes") — this helper never competes with it. null also when there
 *  are no votes at all, so nothing renders rather than "0%". */
export function thumbsLabel(up?: number, down?: number): string | null {
  const u = up ?? 0, d = down ?? 0, total = u + d;
  if (total === 0 || total >= MIN_VOTES_FOR_PCT) return null;
  return d === 0 ? `${people(u)} found this helpful` : `${u} of ${people(total)} found this helpful`;
}

export default function FeedbackSection({ pluginId, installed }: { pluginId: string; installed: boolean }) {
  const stats = useMarketplaceStats();
  const auth = useAccount();

  const [vote, setVote] = useState<'up' | 'down' | null>(null);
  const [saving, setSaving] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);
  // Totals from the last write. POST /thumbs returns them, so the number moves
  // the instant the vote lands. Falls back to /stats until you vote.
  const [localTotals, setLocalTotals] = useState<{ up: number; down: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [commentNote, setCommentNote] = useState<{ kind: 'held' | 'error'; text: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [signIn, setSignIn] = useState<null | 'vote' | 'comment'>(null);
  // The account's own comments the Worker is holding for review, for THIS
  // plugin. The public list never returns them, so they come from this
  // device's record (state/held-comments.ts) and are shown in the thread
  // marked as held — otherwise the "held for review" toast is the last the
  // author ever sees of what they wrote.
  const [held, setHeld] = useState<HeldComment[]>([]);
  const userId = auth.signedIn ? auth.user?.id ?? null : null;

  const s = stats.plugins[pluginId];
  const up = localTotals?.up ?? s?.thumbs_up ?? 0;
  const down = localTotals?.down ?? s?.thumbs_down ?? 0;
  const summary = thumbsSummary(up, down);
  const lowCountLabel = thumbsLabel(up, down);

  // Load the vote this account already cast. Without it the buttons forget you:
  // vote, leave, come back, and neither thumb is lit — which reads as "it didn't
  // save" and gets you voting a second time. Skipped when not installed, because
  // then no vote can exist and the round-trip would be pure waste on every open.
  useEffect(() => {
    if (!auth.signedIn || !installed) { setVote(null); return; }
    let live = true;
    void window.claude.marketplaceApi
      .myThumb(pluginId)
      .then((r) => {
        if (!live || !r.ok) return;
        setVote(r.value.vote);
        // Cards read plugins[id] from the stats context, so push it there too —
        // otherwise the card behind this page keeps its app-start number.
        stats.applyThumbs(pluginId, r.value.thumbs_up, r.value.thumbs_down);
        // Take the TOTALS from this read too. Seeding only the vote is what
        // produced a lit thumb beside "No votes yet" on reopen: the vote was
        // fresh from the server while the count still came from the /stats
        // snapshot taken at app start, which predates the vote. /stats is
        // max-age=300, so it cannot be refreshed into agreeing.
        setLocalTotals({ up: r.value.thumbs_up, down: r.value.thumbs_down });
      })
      .catch(() => undefined);   // a failed read just leaves the buttons unlit
    return () => { live = false; };
  }, [pluginId, auth.signedIn, installed]);

  // Reset per-plugin UI state when the page switches plugins.
  useEffect(() => { setLocalTotals(null); setVoteError(null); setCommentNote(null); }, [pluginId]);

  // Held comments belong to (account, plugin): signing out or switching pages
  // swaps the list, and a signed-out reader never sees anyone's held comments.
  useEffect(() => {
    const storage = heldStorage();
    setHeld(userId && storage ? readHeldComments(storage, userId, pluginId) : []);
  }, [userId, pluginId]);

  // Rows for CommentList: the author is this account, so its name and avatar
  // are ours to fill in — the Worker never returned the row at all.
  const heldRows = useMemo<CommentEntry[]>(() => held.map((c) => ({
    id: c.id,
    user_id: userId ?? '',
    user_login: auth.user?.display_name || auth.user?.login || 'You',
    user_avatar_url: auth.user?.avatar_url ?? '',
    text: c.text,
    created_at: c.created_at,
  })), [held, userId, auth.user]);

  // The public list now carries one of these ids (approved since) — drop the
  // local copy so it is not shown twice.
  const onHeldListed = useCallback((ids: string[]) => {
    const storage = heldStorage();
    setHeld((prev) => userId && storage ? forgetHeldComments(storage, userId, pluginId, ids) : prev.filter((c) => !ids.includes(c.id)));
  }, [userId, pluginId]);

  // Through window.claude.marketplaceApi because the sign-in token lives in the
  // MAIN process (same path as theme likes). A renderer-side HTTP client cannot
  // authenticate — the old one was built with `getToken: () => null`, so every
  // vote 401'd and the error was swallowed while the thumb stayed lit.
  //
  // `saving` is a real guard, not politeness: without it rapid clicks fire
  // overlapping writes and the last RESPONSE wins rather than the last click.
  const castVote = (v: 'up' | 'down') => {
    if (saving) return;
    if (!auth.signedIn) { setSignIn('vote'); return; }
    const previous = vote;
    const next = vote === v ? null : v;
    setVote(next); setSaving(true); setVoteError(null);
    const failed = (msg: string) => { setVote(previous); setVoteError(msg); };
    window.claude.marketplaceApi
      .thumb({ plugin_id: pluginId, value: next })
      .then((r) => {
        if (r.ok) {
          // Move the number from THIS response. Deliberately no stats.refresh():
          // /stats is served Cache-Control max-age=300 and refresh() only bypasses
          // the app's own in-memory cache, so the count would not budge for five
          // minutes — plus it raises a global loading flag every card reads and
          // re-downloads the whole marketplace's totals on every click.
          setLocalTotals({ up: r.value.thumbs_up, down: r.value.thumbs_down });
          // …and into the shared stats, so the CARD you just voted on changes
          // too. Without this the detail page and its own card disagree: the
          // header says 0% while the card still says 100%. refresh() cannot fix
          // it — /stats is Cache-Control max-age=300.
          stats.applyThumbs(pluginId, r.value.thumbs_up, r.value.thumbs_down);
          return;
        }
        // Never swallow: a vote that did not save must not look like it did.
        failed(r.status === 403
          ? 'Install it first — only people who have used it can vote.'
          : "Couldn't save your vote. Try again.");
      })
      .catch(() => failed("Couldn't save your vote. Try again."))
      .finally(() => setSaving(false));
  };

  const post = () => {
    const text = draft.trim();
    if (!text) return;
    if (!auth.signedIn) { setSignIn('comment'); return; }
    setPosting(true);
    setCommentNote(null);
    window.claude.marketplaceApi
      .comment({ plugin_id: pluginId, text })
      .then((r) => {
        if (!r.ok) {
          // Keep the draft — the difference between "try again" and "retype it".
          setCommentNote({ kind: 'error', text: "Couldn't post your comment. Try again." });
          return;
        }
        setDraft('');
        setRefresh((n) => n + 1);
        // A held comment is never returned by the public list, so without saying
        // so the user posts, the box clears, and nothing appears — which is
        // indistinguishable from a bug.
        if (r.value.hidden) {
          setCommentNote({ kind: 'held', text: "Posted. It's held for review." });
          // …and keep it in the thread, marked as held, so reopening the page
          // still shows what was written. The POST response carries no
          // timestamp, so the moment it returned stands in for one.
          const entry: HeldComment = { id: r.value.id, text, created_at: Math.floor(Date.now() / 1000) };
          const storage = heldStorage();
          setHeld((prev) => userId && storage
            ? rememberHeldComment(storage, userId, pluginId, entry)
            : [entry, ...prev.filter((c) => c.id !== entry.id)]);
        }
      })
      .catch(() => setCommentNote({ kind: 'error', text: "Couldn't post your comment. Try again." }))
      .finally(() => setPosting(false));
  };

  const voteReason = !installed
    ? 'Install it first — only people who have used it can vote'
    : !auth.signedIn ? 'Sign in to vote' : undefined;

  return (
    <section data-feedback>
      <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-3">
          {/* WHY SectionLabel, not the old spaced-caps eyebrow (labels batch,
              guide: no spaced capitals — decisions H-3/L-1…L-4). */}
          <SectionLabel>Feedback</SectionLabel>
          {/* Under MIN_VOTES_FOR_PCT a percentage lies ("Helpful 100%" off one
              vote) and the count reads "1 votes" — so say it in words instead.
              At or above it the approved G-19 markup stands unchanged. */}
          {lowCountLabel
            ? <span className="text-sm text-fg-2">{lowCountLabel}</span>
            : summary
              ? <span className="text-sm text-fg-2">Helpful <span className="text-fg">{summary.pct}%</span> <span className="text-fg-muted">{summary.total.toLocaleString()} votes</span></span>
              : <span className="text-sm text-fg-dim">No votes yet</span>}
        </div>
        {/* Both `secondary sm` — the page's one primary is Install (G-4). */}
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1.5" role="group" aria-label="Was this helpful?">
            <Button variant="secondary" size="sm" onClick={() => castVote('up')} disabled={!installed || saving} title={voteReason ?? 'Helpful'} aria-pressed={vote === 'up'} className={vote === 'up' ? 'ring-1 ring-accent' : ''}>
              <ThumbIcon /> Helpful
            </Button>
            <Button variant="secondary" size="sm" onClick={() => castVote('down')} disabled={!installed || saving} title={voteReason ?? 'Not for me'} aria-pressed={vote === 'down'} className={vote === 'down' ? 'ring-1 ring-accent' : ''}>
              <ThumbIcon down /> Not for me
            </Button>
          </div>
          {/* Visible, not a `title`: Android runs this same bundle and has no
              hover, and several engines suppress title on a disabled button
              entirely — so the tooltip was the only explanation and nobody
              could reach it. */}
          {(voteError || voteReason) && (
            <p className={`text-xs ${voteError ? 'text-danger' : 'text-fg-muted'}`} role={voteError ? 'status' : undefined}>
              {voteError ?? voteReason}
            </p>
          )}
        </div>
      </div>

      <CommentList pluginId={pluginId} refreshKey={refresh} held={heldRows} onHeldListed={onHeldListed} />

      {/* Composer — anyone signed in can ask a question or report how it went;
          you do NOT need to have installed it to ask. */}
      <div className="mt-3 flex flex-col gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder={auth.signedIn ? 'Ask a question or say how it went…' : 'Sign in to comment'}
          aria-label="Write a comment"
        />
        <div className="flex items-center justify-end gap-2">
          {commentNote && (
            <p className={`text-xs ${commentNote.kind === 'error' ? 'text-danger' : 'text-fg-muted'}`} role="status">
              {commentNote.text}
            </p>
          )}
          <Button variant="secondary" size="sm" onClick={post} disabled={posting || draft.trim().length === 0} title={!auth.signedIn ? 'Sign in to comment' : undefined}>
            {posting ? 'Posting…' : 'Post comment'}
          </Button>
        </div>
      </div>

      <SignInPromptModal
        open={signIn !== null}
        onClose={() => setSignIn(null)}
        title={signIn === 'vote' ? 'Sign in to vote' : 'Sign in to comment'}
        message={signIn === 'vote' ? 'Votes are tied to your account so each person counts once.' : 'Comments show your marketplace handle.'}
      />
    </section>
  );
}
