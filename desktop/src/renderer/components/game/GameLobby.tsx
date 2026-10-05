import { useState, useEffect, useRef, useCallback } from 'react';
import { useGameState, useGameDispatch } from '../../state/game-context';
import { useAccount } from '../../state/account-context';
import BrailleSpinner from '../BrailleSpinner';
import { GameConnection } from '../../state/game-types';
import { mergeFriends, statusLabel } from './friends-data';
import { Badge, Button, CARD_LEVEL_1, CARD_LEVEL_2, Callout, Pill, FieldError, InputGroup, SectionLabel } from '../ui';
import type { FriendRow, HeadToHead, RequestsPayload } from '../../state/marketplace-api-client';
import { recordAria, recordLabel, recordsByOpponent } from './head-to-head';
// WHY (Office fix round 5): the reload button reloads the window, so open Office documents save first.
import { reloadAfterOfficeSave } from '../office/office-store';
// Task 7c, workbench-only auto-play — see the effect below and
// dev/workbench/fake-party.ts. isWorkbenchAutoplay() is false in every
// shipped build (it checks for a global only install-mock.ts ever sets).
import { isWorkbenchAutoplay, JAKE_ID } from '../../dev/workbench/fake-party';

// Local mirror of the renderer/main ApiResult shape (useIpc.ts declares it but
// doesn't export it — keeping a copy avoids importing across that boundary).
type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };

interface Props {
  connection: GameConnection;
  incognito?: boolean;
  onToggleIncognito?: () => void;
  /** WHICH game this lobby is challenging people to. The arcade shell passes
   *  the game the user opened; before the split every challenge was hardcoded
   *  to Connect 4 (§3.1 item 3). */
  gameId: string;
}

// Classify the lobby error so the hint matches the actual cause.
// Tone rules for this screen (Destin's direction):
//  - no jargon, no "error codes" in the user-facing hint
//  - don't catastrophize — most of these resolve themselves in seconds
//  - tell the user what *they* can do, not what the code is doing
// The raw code stays in the headline string (from the reducer) for
// debugging, but the hint below it is always plain language.
function classifyPartyError(msg: string | null): { hint: string } {
  // Note: the not-signed-in case is no longer an error — it's handled by the
  // SignInScreen gate in GameLobby (identity comes from the marketplace sign-in,
  // not the gh CLI), so there's no "sign in from a terminal" branch here anymore.
  const text = (msg ?? '').toLowerCase();
  if (text.includes('code 1011') || text.includes('code 500') || text.includes('code 1012') || text.includes('code 1013')) {
    return { hint: 'The game server is taking a breather. This usually fixes itself in a minute.' };
  }
  if (text.includes('code 1006') || text.includes('code 1015') || text.includes('lost the connection') || text.includes('lost connection')) {
    return { hint: "Looks like the internet hiccuped. We'll keep trying — you can also hit Retry." };
  }
  if (text.includes('code 4000')) {
    return { hint: 'Something got mixed up signing in. Try reloading the app.' };
  }
  return { hint: "Hang tight — we'll keep trying in the background." };
}

function ErrorScreen({ connection }: { connection: GameConnection }) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const { hint } = classifyPartyError(state.partyError);
  // Track retries so we can offer a harder reload after repeated failures —
  // partysocket reconnect can fail forever if e.g. the host name is bad or the
  // user is rate-limited. After 2 manual retries we surface "Reload app" too.
  const [retryCount, setRetryCount] = useState(0);
  const [retrying, setRetrying] = useState(false);

  const handleRetry = () => {
    setRetryCount(n => n + 1);
    setRetrying(true);
    connection.reconnectLobby();
    // Re-arm after a short window so the spinner clears whether or not we
    // reconnect. PARTY_CONNECTED will swap the screen out from under us.
    setTimeout(() => setRetrying(false), 4000);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 py-8">
      {/* G-2 (§5.5): was `bg-red-900/30`, a raw Tailwind colour identical in
          every theme. `--destructive` is the token for exactly this, and it is
          derived per theme so the disc stays legible on light packs too.
          Design rule 6 also says errors are not red BOXES — this is a mark, and
          it stays a mark. */}
      <div className="w-16 h-16 rounded-full bg-destructive/20 flex items-center justify-center">
        <span className="text-2xl text-destructive-fg" aria-hidden="true">!</span>
      </div>
      {/* WHY FieldError, not a hand-rolled text-destructive-fg line (guide:
          "no red/coloured body text for messages"): the box above already
          carries the failure mark, so the line itself is the shared
          component, not a second red signal. */}
      <FieldError as="p" size="2xs" className="text-center">{state.partyError}</FieldError>
      <p className="text-xs text-fg-muted text-center max-w-xs">{hint}</p>
      {/* WHY outlined (guide: secondary actions are outlined, never bare text):
          all three were hand-rolled text-link/text-fg-2/text-fg-muted buttons. */}
      <div className="flex gap-2 mt-1 items-center">
        <Button variant="secondary" size="sm" onClick={handleRetry} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
        {retryCount >= 2 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => reloadAfterOfficeSave()}
            title="Hard reload the renderer — drops all in-memory state"
          >
            Reload app
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={() => dispatch({ type: 'CLEAR_CHALLENGE' })}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

// Per-friend "…" row menu. Manages its own open + block-confirm state and
// closes on outside click (anchored popover pattern from MarketplaceAuthChip —
// no Scrim because it's anchored, not centered). Block is consequence-gated:
// the menu item swaps the popover to a plain-language confirm BEFORE acting
// (Destin's standing rule for destructive/hard-to-reverse actions).
function FriendRowMenu({ onUnfriend, onBlock, pending }: { onUnfriend: () => void; onBlock: () => void; pending?: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirmingBlock, setConfirmingBlock] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmingBlock(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const close = () => { setOpen(false); setConfirmingBlock(false); };

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="More"
        aria-label="Friend options"
        // Touch target: p-1.5 gives the ⋯ a ≥32px square hit box — this panel
        // ships to a 320px Android WebView, so bare 10px text (~14px box) is
        // untappable. Keep the padding even if the visual density changes.
        className="text-fg-muted hover:text-fg-2 p-1.5 transition-colors"
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="layer-surface absolute right-0 top-full mt-1 min-w-[220px] rounded-md p-1.5 text-xs shadow-md"
          // z-index 62 = one above L2 popup content (61), same as the
          // MarketplaceAuthChip popover — clears any L1 drawer overlap.
          style={{ zIndex: 62 }}
        >
          {confirmingBlock ? (
            <div className="flex flex-col gap-2 p-1">
              <p className="text-fg-2 leading-snug">
                Blocking removes this friend, cancels pending requests, and hides you
                from each other. You can unblock later in Settings → Account.
              </p>
              <div className="flex gap-2">
                {/* The raw `bg-red-600`/`text-white` was a stock Tailwind red that didn't
                    match the app's own destructive colour and ignored themes. The shared
                    `danger` variant uses the theme's destructive token and derives a
                    readable label colour per theme.
                    The `md` size already supplies py-1.5, which keeps these ≥32px tall
                    for touch (see the ⋯ trigger note). */}
                <Button
                  type="button"
                  variant="danger"
                  size="md"
                  onClick={() => { onBlock(); close(); }}
                  disabled={pending}
                  className="flex-1"
                >
                  Block
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  onClick={() => setConfirmingBlock(false)}
                  className="flex-1"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* py-1.5 keeps menu items ≥32px tall for touch (see the ⋯ trigger note). */}
              <button
                type="button"
                role="menuitem"
                onClick={() => { onUnfriend(); close(); }}
                disabled={pending}
                className="w-full text-left px-2 py-1.5 rounded text-fg-2 hover:text-fg hover:bg-inset disabled:opacity-40 transition-colors"
              >
                Unfriend
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => setConfirmingBlock(true)}
                className="w-full text-left px-2 py-1.5 rounded text-destructive-fg hover:bg-inset transition-colors"
              >
                Block
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// The lobby is the friends list now (spec §6): add-by-handle, incoming/outgoing
// requests, and challenge buttons gated to online friends. Presence relays only
// ONLINE FRIENDS, so onlineUsers is merged onto the server friends list to light
// up "Online" / "In game" and the Challenge button.
function FriendsScreen({ connection, incognito, onToggleIncognito, gameId }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  // Review fix: self-exclusion keys on the ACCOUNT ID (ids-not-names principle) —
  // display names aren't unique, so tag-comparison would miss a friend who
  // shares your name and fire spurious refreshes on null display_name edges.
  const { user } = useAccount();
  const myId = user?.id ?? null;

  const [friends, setFriends] = useState<FriendRow[] | null>(null);
  const [requests, setRequests] = useState<RequestsPayload | null>(null);
  /** Head-to-head records for THIS game, keyed by opponent (§6.2). Empty until
   *  the fetch lands, and empty forever if it fails — a row simply shows no
   *  number, which is the honest state. A record is a fact about another
   *  person, so it is better absent than approximate. */
  const [records, setRecords] = useState<Map<string, HeadToHead>>(new Map());
  const [addHandle, setAddHandle] = useState('');
  // Add-friend inline feedback: plain sentence + tone (ok=green, else red).
  const [addFeedback, setAddFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  // True while a sendRequest is in flight — disables the Send button so a
  // double-tap can't fire two requests (and burn the daily cap twice).
  const [addPending, setAddPending] = useState(false);
  // Per-row error strings keyed by request/friend id (rendered under the row).
  const [rowError, setRowError] = useState<Record<string, string>>({});
  // Ids with a mutation in flight — their row buttons are disabled. The ref is
  // the synchronous double-fire guard (state alone can lag a fast double-tap);
  // the state copy drives the disabled rendering.
  const pendingRowsRef = useRef<Set<string>>(new Set());
  const [pendingRows, setPendingRows] = useState<Set<string>>(new Set());

  // Fetch both lists in parallel; called on mount and after every mutation.
  const refresh = useCallback(async () => {
    const arcade = (window.claude as { arcade?: { records?: (g?: string) => Promise<ApiResult<HeadToHead[]>> } }).arcade;
    const [fr, rq, rec] = await Promise.all([
      window.claude.social.listFriends(),
      window.claude.social.listRequests(),
      // Narrowed to this game: winning at Connect 4 says nothing about who is
      // better at chess, so one number per (person, game) and never a total.
      // Optional-chained because a surface with no arcade bridge still has a
      // perfectly good lobby — it just shows no records.
      arcade?.records?.(gameId) ?? Promise.resolve(null),
    ]);
    if (fr.ok) setFriends(fr.value);
    if (rq.ok) setRequests(rq.value);
    if (rec?.ok) setRecords(recordsByOpponent(rec.value, gameId));
  }, [gameId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Refresh when presence shows an online user who ISN'T a known friend yet — a
  // request I sent was just accepted (the server pokes visibility ahead of my
  // list refetch). friendIdsRef avoids re-running purely on the friends array
  // reference changing, so this can't tight-loop; it settles once the new friend
  // lands in the list. Self can appear in onlineUsers, so exclude it by ACCOUNT
  // ID (review fix — names aren't unique keys).
  const friendIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    friendIdsRef.current = new Set((friends ?? []).map(f => f.id));
  }, [friends]);
  useEffect(() => {
    const hasUnknownOnline = state.onlineUsers.some(
      u => u.id !== myId && !friendIdsRef.current.has(u.id),
    );
    if (hasUnknownOnline) void refresh();
  }, [state.onlineUsers, myId, refresh]);

  // Shared mutation runner for accept/decline/cancel/unfriend/block: on failure
  // stash a plain sentence under the row; on success clear it and refresh.
  // Review fix: a per-key in-flight guard so a double-tap can't fire the same
  // mutation twice — the ref check is synchronous (state updates would lag a
  // fast second tap), and pendingRows state disables the row's buttons.
  const runMutation = useCallback(async (
    fn: () => Promise<ApiResult<unknown>>,
    key: string,
    fallback = 'Something went wrong. Try again.',
  ) => {
    if (pendingRowsRef.current.has(key)) return;
    pendingRowsRef.current.add(key);
    setPendingRows(prev => new Set(prev).add(key));
    try {
      const res = await fn();
      if (!res.ok) {
        setRowError(prev => ({ ...prev, [key]: res.message || fallback }));
        return;
      }
      // Success: drop any stale error for this row so entries can't accumulate.
      setRowError(prev => { const next = { ...prev }; delete next[key]; return next; });
      await refresh();
    } finally {
      pendingRowsRef.current.delete(key);
      setPendingRows(prev => { const next = new Set(prev); next.delete(key); return next; });
    }
  }, [refresh]);

  // Add a friend by exact handle. Maps the Worker's status codes to human copy.
  const submitAddFriend = useCallback(async () => {
    const handle = addHandle.trim();
    // addPending guard (review fix): Enter + click (or a double-tap) must not
    // send the request twice — a duplicate burns the daily request cap.
    if (!handle || addPending) return;
    setAddPending(true);
    try {
      const res = await window.claude.social.sendRequest(handle);
      if (res.ok) {
        setAddFeedback({
          text: res.value.status === 'friends' ? `You're now friends with @${handle}` : 'Request sent',
          ok: true,
        });
        setAddHandle('');
        await refresh();
        return;
      }
      // 404 = unknown or blocked handle (no enumeration oracle — same message).
      // 429 = daily request cap. 400 = a validation reason the server phrases well
      // ("that's you"). Anything else falls back to the server message.
      const text =
        res.status === 404 ? 'No one has that handle' :
        res.status === 429 ? 'Daily request limit reached — try tomorrow' :
        res.status === 400 ? (res.message || "That request can't be sent") :
        (res.message || 'Could not send the request. Try again.');
      setAddFeedback({ text, ok: false });
    } finally {
      setAddPending(false);
    }
  }, [addHandle, addPending, refresh]);

  const merged = mergeFriends(friends ?? [], state.onlineUsers);
  const incoming = requests?.incoming ?? [];
  const outgoing = requests?.outgoing ?? [];
  const loaded = friends !== null;
  const isEmpty = loaded && merged.length === 0 && incoming.length === 0 && outgoing.length === 0;

  return (
    // WHY labelled cards, not full-width ruled strips (quick-fix batch,
    // 2026-09-29; ui-labels-batch#LB-16: "this needs the card styling and such
    // established earlier for other similar menus. not the fulll horizontal
    // lines"): the Settings recipe — a small label over each card, 16px
    // between groups, people as nested (level-2) rows 8px apart inside it.
    <div className="flex flex-col gap-4 p-3">
      {/* Player info */}
      <div>
      <SectionLabel className="mb-2">Your profile</SectionLabel>
      <div className={`${CARD_LEVEL_1} px-3 py-2 flex items-center justify-between`}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-fg truncate">{state.username}</span>
          {/* Plain-word status, never a glyph (Destin's standing rule — the old
              green/faint dot was removed 2026-07-09). This screen only renders
              when connected or incognito (the parent gates the rest), so the
              two reachable states are exactly these words. */}
          {/* WHY a pill (status pills trial, 2026-09-29; guide: "a status label
              is a small tinted pill … normal case"): still the word, never a
              glyph — the colour is a quiet tint behind it. */}
          <Pill tone={incognito ? 'neutral' : 'ok'}>{incognito ? 'Incognito' : 'Online'}</Pill>
        </div>
        {onToggleIncognito && (
          // WHY outlined (guide: secondary actions are outlined, never bare
          // text; "Go incognito" is named explicitly): was a hand-rolled
          // text button whose only "state" cue was a background tint.
          <Button
            variant="secondary"
            size="sm"
            onClick={onToggleIncognito}
            title={incognito ? 'Go online — appear to friends' : 'Go incognito — hide from friends'}
          >
            {incognito ? 'Go online' : 'Go incognito'}
          </Button>
        )}
      </div>
      </div>

      {/* Incoming challenge — challengeFrom is account identity: .id is the
          stable key passed to respondToChallenge, .name the visible tag, and
          .handle is now carried so we can render @handle alongside.
          Room codes still exist INTERNALLY as the capability token for PartyKit
          rooms — accepting a challenge joins by the received code below. The
          manual Create Game / enter-a-room-code UI was removed 2026-07-09
          (Destin: friends/handles cover the real use case); challenges are the
          only way into a game now. */}
      {state.challengeFrom && (
        // WHY a Callout, not a tinted full-width strip (quick-fix batch): the
        // guide's one notice box. Buttons stay stacked under the words, each
        // half-width — the pane can be narrow.
        <Callout>
          <p className="text-sm text-fg mb-2">
            <span className="font-medium text-link">{state.challengeFrom.name}</span>
            {state.challengeFrom.handle && (
              <span className="text-fg-muted text-xs ml-1">@{state.challengeFrom.handle}</span>
            )}
            <span> wants to play!</span>
          </p>
          <div className="flex gap-2">
            {/* WHY green → `primary`: accepting a game invite is not a safety decision.
                The green was borrowed from the permission prompt, where green/red really
                does mean allow/deny. Here it just meant "the main action", which is what
                `primary` is for — and it also removes the last hardcoded `text-white`
                from the games screens, so this button now follows the user's theme. */}
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                connection.respondToChallenge(state.challengeFrom!.id, true);
                // Join the game you were actually challenged to. The reducer
                // now keeps it; it used to be dropped, so Accept always opened
                // Connect 4 whatever the challenge said (§3.1 item 3).
                connection.joinGame(state.challengeCode!, state.challengeGame ?? gameId);
                dispatch({ type: 'CLEAR_CHALLENGE' });
              }}
              className="flex-1"
            >
              Accept
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => { connection.respondToChallenge(state.challengeFrom!.id, false); dispatch({ type: 'CLEAR_CHALLENGE' }); }}
              className="flex-1"
            >
              Decline
            </Button>
          </div>
        </Callout>
      )}

      {/* Challenge declined notification — the same notice box. WHY the
          `actions` prop, not an inline text-link button (guide: secondary
          actions are outlined, never bare text; a notice's own buttons go
          inside it, at the right): Dismiss used to be a link stitched into
          the sentence. */}
      {state.challengeDeclinedBy && (
        <Callout actions={<Button variant="secondary" size="sm" onClick={() => dispatch({ type: 'CLEAR_CHALLENGE' })}>Dismiss</Button>}>
          <p className="text-xs text-fg-dim">
            <span className="text-fg-2">{state.challengeDeclinedBy.name}</span> declined your challenge.
          </p>
        </Callout>
      )}

      {/* Incoming friend requests */}
      {incoming.length > 0 && (
        <div>
          {/* WHY SectionLabel, not the old spaced-caps eyebrow (labels batch,
              guide: no spaced capitals — decisions H-3/L-1…L-4). The arcade
              lobby is NOT exempt from the guide (only game boards are). */}
          <SectionLabel className="mb-2">Friend requests</SectionLabel>
          <ul className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`}>
            {incoming.map((req) => (
              <li key={req.id} className={`${CARD_LEVEL_2} px-3 py-2 flex flex-col gap-1`}>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-fg-2 truncate flex-1 min-w-0">
                    {req.from.display_name}
                    {req.from.handle && <span className="text-fg-muted ml-1">@{req.from.handle}</span>}
                  </span>
                  {/* Touch target: px-1.5 py-1.5 keeps these row actions ≥32px
                      tall on the Android WebView — the 10px text alone is a
                      ~14px hit box. Applies to every row button in this screen. */}
                  {/* Change 47, DECIDED 2026-07-16 as option A: Accept is the
                      primary action, NOT semantic green. `text-green-400` here
                      meant "yes" by colour alone, which is exactly the pairing
                      rule 5 retires — and it read as a status, not a button, on
                      a row whose other action was grey text. Button's `sm` size
                      carries `coarse-hit`, so the ≥32px touch box the old
                      px-1.5/py-1.5 was hand-building is now the primitive's job. */}
                  <Button
                    size="sm"
                    onClick={() => runMutation(() => window.claude.social.acceptRequest(req.id), req.id, "Couldn't accept — try again")}
                    disabled={pendingRows.has(req.id)}
                    className="shrink-0"
                  >
                    Accept
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => runMutation(() => window.claude.social.declineRequest(req.id), req.id, "Couldn't decline — try again")}
                    disabled={pendingRows.has(req.id)}
                    className="shrink-0"
                  >
                    Decline
                  </Button>
                </div>
                {/* WHY FieldError (guide: no red/coloured body text for messages) */}
                {rowError[req.id] && <FieldError as="p" size="2xs">{rowError[req.id]}</FieldError>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Add a friend by handle */}
      <div>
        <SectionLabel className="mb-2">Add a friend</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`}>
        {/* Change 77: "Send request" moves INSIDE the field. It was left
            `variant="secondary" size="lg"` purely so it would height-match the
            input sitting beside it — inside the field there is nothing to
            height-match, so it goes back to the primary it always semantically
            was (this is the submit for the field it lives in).
            Change 20 also applies to the field itself: bg-well and the gray
            focus (`focus:border-fg-dim`) are both retired by the shared surface. */}
        <InputGroup size="md">
          <InputGroup.Field
            type="text"
            aria-label="Friend's handle"
            value={addHandle}
            // Handles are lowercase — normalize as the user types so the exact-match
            // lookup on the Worker doesn't 404 on a stray capital.
            onChange={(e) => setAddHandle(e.target.value.toLowerCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitAddFriend(); }}
            placeholder="friend's handle"
          />
          <Button
            size="sm"
            onClick={() => void submitAddFriend()}
            disabled={!addHandle.trim() || addPending}
          >
            Send request
          </Button>
        </InputGroup>
        {/* WHY (guide: no red/coloured body text for messages) — the success
            line drops its green for the plain muted text every other success
            line uses; the failure line goes through FieldError. */}
        {addFeedback && (
          addFeedback.ok
            ? <p className="text-xs text-fg-muted">{addFeedback.text}</p>
            : <FieldError as="p" size="2xs">{addFeedback.text}</FieldError>
        )}
        </div>
      </div>

      {/* Friends list */}
      {merged.length > 0 && (
        <div>
          <SectionLabel className="mb-2">Friends ({merged.length})</SectionLabel>
          <ul className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`}>
            {merged.map((row) => (
              <li key={row.id} className={`${CARD_LEVEL_2} px-3 py-2 flex flex-col gap-0.5`}>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-fg-2 truncate flex-1 min-w-0">
                    {row.name}
                    {row.handle && <span className="text-fg-muted ml-1">@{row.handle}</span>}
                  </span>
                  {/* Live state as a pill beside the name (same rule as Your
                      profile above); "Last seen …" stays a line below. */}
                  {(row.online || !row.lastSeenAt) && (
                    <Pill tone={row.online ? 'ok' : 'neutral'}>{statusLabel(row, Date.now())}</Pill>
                  )}
                  {/* Your record against this person AT THIS GAME — the fact
                      that decides who you want to play next. Absent for anyone
                      you have never finished a game against, which is most
                      people most of the time, so it must not leave a gap. */}
                  {records.has(row.id) && (
                    <Badge label={recordAria(records.get(row.id)!)}>
                      {recordLabel(records.get(row.id)!)}
                    </Badge>
                  )}
                  {/* Challenge only when the friend is actually online (has a live
                      presence entry). row.id is the account id challengePlayer wants. */}
                  {row.online && (
                    // Change 47: this is an ACTION, not a link. Recolouring it to
                    // the link tokens (the first pass) left the lobby arguing with
                    // itself — the friend-request row right above has real Buttons
                    // for Accept/Decline while this row styled its only action as
                    // text. `secondary` rather than `primary`: Challenge appears on
                    // every online friend, and a filled accent button per row would
                    // read as a list of alerts. Button's `sm` carries `coarse-hit`,
                    // which replaces the hand-rolled px/py-1.5 touch padding.
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => connection.challengePlayer(row.id, gameId)}
                      className="shrink-0"
                    >
                      Challenge
                    </Button>
                  )}
                  <FriendRowMenu
                    pending={pendingRows.has(row.id)}
                    onUnfriend={() => runMutation(() => window.claude.social.unfriend(row.id), row.id, "Couldn't unfriend — try again")}
                    onBlock={() => runMutation(() => window.claude.social.block(row.id), row.id, "Couldn't block — try again")}
                  />
                </div>
                {/* Plain-word status — never glyphs (workspace rule). Only the
                    "Last seen …" sentence lives here now; a live state is the
                    pill beside the name. */}
                {!row.online && row.lastSeenAt && <span className="text-3xs text-fg-muted">{statusLabel(row, Date.now())}</span>}
                {/* WHY FieldError (guide: no red/coloured body text for messages) */}
                {rowError[row.id] && <FieldError as="p" size="2xs">{rowError[row.id]}</FieldError>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Sent (outgoing) requests — dim, collapsed-feeling */}
      {outgoing.length > 0 && (
        <div>
          <SectionLabel className="mb-2">Sent requests</SectionLabel>
          <ul className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`}>
            {outgoing.map((req) => (
              <li key={req.id} className={`${CARD_LEVEL_2} px-3 py-2 flex flex-col gap-1`}>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-fg-dim truncate flex-1 min-w-0">
                    @{req.to.handle ?? req.to.display_name}
                  </span>
                  {/* WHY outlined (guide: secondary actions are outlined,
                      never bare text — "Cancel" is named explicitly): was a
                      hand-rolled text-fg-muted button. */}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => runMutation(() => window.claude.social.cancelRequest(req.id), req.id, "Couldn't cancel — try again")}
                    disabled={pendingRows.has(req.id)}
                    className="shrink-0"
                  >
                    Cancel
                  </Button>
                </div>
                {/* WHY FieldError (guide: no red/coloured body text for messages) */}
                {rowError[req.id] && <FieldError as="p" size="2xs">{rowError[req.id]}</FieldError>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Empty state — no friends and no requests in either direction */}
      {isEmpty && (
        <div className="py-3">
          <p className="text-xs text-fg-muted text-center leading-relaxed">
            No friends yet. Ask a friend for their handle and add them above.
          </p>
        </div>
      )}
    </div>
  );
}

function JoiningScreen({ connection }: { connection: GameConnection }) {
  const dispatch = useGameDispatch();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 120_000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (timedOut) {
      connection.leaveGame();
      dispatch({ type: 'RETURN_TO_LOBBY' });
    }
  }, [timedOut, connection, dispatch]);

  // The only way here is accepting a friend's challenge, so the room code
  // (still the internal PartyKit capability token) means nothing to the user —
  // don't display it. Removed with the manual create/join UI, 2026-07-09.
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 px-4 py-8">
      <div className="flex flex-col items-center gap-2">
        <BrailleSpinner size="lg" />
        <p className="text-sm text-fg-dim">Joining the game…</p>
      </div>

      <button
        onClick={() => { connection.leaveGame(); dispatch({ type: 'RETURN_TO_LOBBY' }); }}
        className="text-sm text-fg-muted hover:text-fg-2 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

function WaitingScreen({ connection }: { connection: GameConnection }) {
  const dispatch = useGameDispatch();

  // The only way here is challenging a friend, so the old share-this-room-code
  // display (code boxes + Copy Code) came out with the manual create/join UI
  // (2026-07-09). The room code still exists internally as the PartyKit
  // capability token — the challenge message already delivered it to the friend.
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 px-4 py-8">
      <div className="flex flex-col items-center gap-2">
        <BrailleSpinner size="lg" />
        <p className="text-sm text-fg-dim">Waiting for your friend to accept…</p>
      </div>

      <button
        onClick={() => { connection.leaveGame(); dispatch({ type: 'RETURN_TO_LOBBY' }); }}
        className="text-sm text-fg-muted hover:text-fg-2 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

// Shown when the user isn't signed in to the marketplace. Games use the
// marketplace GitHub identity as the player tag, so there's nothing to connect
// with until they sign in — a clean gate, not an error. The button launches the
// in-app browser sign-in (no terminal / gh CLI needed); the lobby hook reacts to
// the sign-in flipping and connects automatically once it completes.
function SignInScreen() {
  const { signInPending, signInError, startSignIn } = useAccount();

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 py-8">
      <div className="w-16 h-16 rounded-full bg-inset flex items-center justify-center">
        <span className="text-2xl">🎮</span>
      </div>
      <p className="text-sm text-fg text-center">Sign in to play</p>
      <p className="text-xs text-fg-muted text-center max-w-xs">
        Your YouCoded account name is your player tag.
      </p>
      {/* The old classes had `hover:bg-accent` on top of a `bg-accent` base, so
          hovering changed nothing. The shared `primary` fades the fill on hover,
          so this button now visibly responds to the cursor. */}
      <Button
        variant="primary"
        size="lg"
        onClick={() => { void startSignIn(); }}
        disabled={signInPending}
      >
        {signInPending ? 'Signing in…' : 'Sign in to YouCoded'}
      </Button>
      {/* knowledge-debt #6: surface a failed sign-in instead of silently
          swallowing it. WHY FieldError (guide: no red/coloured body text
          for messages). */}
      {signInError && !signInPending && (
        <FieldError as="p" size="2xs" className="text-center max-w-xs">Sign-in failed: {signInError}. Try again.</FieldError>
      )}
    </div>
  );
}

export default function GameLobby({ connection, incognito, onToggleIncognito, gameId }: Props) {
  const state = useGameState();
  const { signedIn } = useAccount();

  // WORKBENCH ONLY (Task 7c): the landing-page film needs a live board within
  // ~1s of opening the panel, with no add-friend / Challenge / Accept
  // click-through against a bot who can't actually click Accept. The instant
  // the fake presence layer reports connected, challenge "Jake" ourselves —
  // exactly what a real Accept button does (connection.challengePlayer),
  // just without the human step. isWorkbenchAutoplay() is only true when
  // dev/workbench/install-mock.ts has run AND `?signedIn=1` is set, so this
  // can never fire in the shipped app or a signed-out workbench.
  useEffect(() => {
    if (incognito || !isWorkbenchAutoplay()) return;
    if (state.connected && state.screen === 'lobby') {
      connection.challengePlayer(JAKE_ID, gameId);
    }
  }, [state.connected, state.screen, incognito, connection]);

  // Sign-in gate comes BEFORE the error/spinner branches — not being signed in
  // isn't a failure or a slow connection, it's a prerequisite. Incognito keeps
  // its own UI (you don't need to sign in to stay intentionally disconnected).
  if (!incognito && !signedIn) return <SignInScreen />;
  if (state.partyError && !incognito) return <ErrorScreen connection={connection} />;
  if (state.screen === 'joining') return <JoiningScreen connection={connection} />;
  if (state.screen === 'waiting') return <WaitingScreen connection={connection} />;
  // Show connecting spinner while the platform layer opens the presence socket
  // (setup screen, not incognito). The slow-connect hint that used to live here
  // was tied to the retired PartyKit client's HTTP probe — removed with it
  // (Task 7). A real socket failure surfaces via PARTY_ERROR → ErrorScreen above.
  if (!state.connected && !incognito) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 py-8">
        <BrailleSpinner size="lg" />
        <p className="text-sm text-fg-dim">Connecting…</p>
      </div>
    );
  }
  return <FriendsScreen connection={connection} incognito={incognito} onToggleIncognito={onToggleIncognito} gameId={gameId} />;
}
