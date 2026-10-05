// The friends panel — the top of the Games list (redesign backlog row 11).
//
// Destin, 2026-09-29: "dont like the warning/sign in banner. it should be at the
// top, and should be replaced by a new friends panel/menu when signed in with
// games below" and, about the lobby, "most of this should be moved out of the
// game menu into the new friends/social panel … no add friend in game panels".
// So everything social lives HERE: who you are and whether friends can see you,
// your friends with their status as pills, requests both ways, and adding a
// friend. A game's lobby keeps only people, scores and Challenge (GameLobby.tsx).
//
// Signed out, the same spot is one card: "Sign in to play with friends and put
// your scores on the board" with a filled Sign in. Solo games below still play.
import { useEffect, useRef, useState } from 'react';
import { useGameState } from '../../state/game-context';
import { useAccount } from '../../state/account-context';
import { statusLabel, type FriendRowData } from './friends-data';
import { useFriends } from './useFriends';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, FieldError, FoldRow, InputGroup, LoadingState, Pill, SectionLabel } from '../ui';
import { workbenchFriendsAdd, workbenchSignInButton } from '../../workbench-mode';

interface Props {
  incognito?: boolean;
  onToggleIncognito?: () => void;
}

export default function FriendsPanel({ incognito, onToggleIncognito }: Props) {
  const { signedIn } = useAccount();
  return (
    // WHY a small label over one card (guide "Spacing" → a label comes first;
    // every card on the page labelled, so "Games" below gets one too): the
    // signed-out card and the friends card sit in the SAME spot under the same
    // label, so signing in swaps the card and nothing else moves.
    <section>
      <SectionLabel className="mb-2">Friends</SectionLabel>
      {signedIn ? <FriendsCard incognito={incognito} onToggleIncognito={onToggleIncognito} /> : <SignInCard />}
    </section>
  );
}

function SignInCard() {
  const { signInPending, signInError, startSignIn } = useAccount();
  // WHY centred by default: Destin's words ("centered filled sign in"). The guide
  // says a lone button is full width — the deck asks which wins (workbench-mode.ts).
  const full = workbenchSignInButton() === 'full';
  return (
    <div className={`${CARD_LEVEL_1} p-3 flex flex-col items-center gap-3 text-center`}>
      {/* Destin's sentence, verbatim — "flappy and 2048 play without an account"
          is gone: the solo tiles below say "Your best" and simply open. */}
      <p className="text-sm text-fg">Sign in to play with friends and put your scores on the board.</p>
      <Button
        variant="primary"
        size="md"
        className={full ? 'w-full' : ''}
        onClick={() => { void startSignIn(); }}
        disabled={signInPending}
      >
        {signInPending ? 'Signing in…' : 'Sign in'}
      </Button>
      {signInError && !signInPending && (
        <FieldError as="p" size="2xs" className="text-center">Sign-in failed: {signInError}. Try again.</FieldError>
      )}
    </div>
  );
}

/** Your own presence, as the card's header row. Plain words in a pill (guide
 *  "Status and notices"), never a glyph. */
function ownStatus(incognito: boolean | undefined, connected: boolean, partyError: string | null): { label: string; tone: 'ok' | 'neutral' } {
  if (incognito) return { label: 'Incognito', tone: 'neutral' };
  if (connected) return { label: 'Online', tone: 'ok' };
  // Not connected: "Offline" once the server has said no (the game tiles below
  // say why), "Connecting…" during the second before the socket opens.
  return { label: partyError ? 'Offline' : 'Connecting…', tone: 'neutral' };
}

function FriendsCard({ incognito, onToggleIncognito }: Props) {
  const state = useGameState();
  const f = useFriends();
  const look = workbenchFriendsAdd();
  const [addOpen, setAddOpen] = useState(false);
  const me = ownStatus(incognito, state.connected, state.partyError);
  const people = f.incoming.length + f.merged.length + f.outgoing.length;

  return (
    // One first-level card for the one idea, "your friends" (guide "Card levels";
    // decisions K-RULE: a card that holds one idea keeps it together). Its header
    // row is you; the people are plain rows in ONE shared nested box (guide "Lists
    // of short names are plain rows inside one shared box"), never a box each.
    <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`} data-friends-card>
      <div className="flex items-center gap-2 min-h-8">
        <span className="text-sm font-medium text-fg truncate min-w-0">{state.username || 'You'}</span>
        <Pill tone={me.tone} dot>{me.label}</Pill>
        <span className="flex-1" />
        {onToggleIncognito && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onToggleIncognito}
            title={incognito ? 'Go online — appear to friends' : 'Go incognito — hide from friends'}
            className="shrink-0"
          >
            {incognito ? 'Go online' : 'Go incognito'}
          </Button>
        )}
      </div>

      {/* "add a friend could be subsumed into friends somehow" — three ways,
          picked on the deck (workbench-mode.ts `?friendsAdd=`). */}
      {look === 'field' && <AddFriend refresh={f.refresh} />}

      {people > 0 ? (
        <ul className={`${CARD_LEVEL_2} p-1 flex flex-col gap-0.5`}>
          {f.incoming.map((req) => (
            <PersonRow
              key={req.id}
              name={req.from.display_name}
              handle={req.from.handle}
              sub="Wants to be your friend"
              error={f.rowError[req.id]}
              right={(
                // Two buttons of one height side by side (shoot's parts-agree check).
                <div className="flex items-center gap-1.5 shrink-0" data-parts-agree="friend request buttons">
                  {/* Accept stays filled (change 47, 2026-07-16) — the one action
                      the row exists for. */}
                  <Button
                    size="sm"
                    onClick={() => f.runMutation(() => window.claude.social.acceptRequest(req.id), req.id, "Couldn't accept — try again")}
                    disabled={f.pendingRows.has(req.id)}
                  >
                    Accept
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => f.runMutation(() => window.claude.social.declineRequest(req.id), req.id, "Couldn't decline — try again")}
                    disabled={f.pendingRows.has(req.id)}
                  >
                    Decline
                  </Button>
                </div>
              )}
            />
          ))}
          {f.merged.map((row) => (
            <PersonRow
              key={row.id}
              name={row.name}
              handle={row.handle}
              // "Last seen 3h ago" is history, not a live state, so it is the
              // row's grey line; the pill carries the live state.
              sub={!row.online && row.lastSeenAt ? statusLabel(row, Date.now()) : undefined}
              error={f.rowError[row.id]}
              right={(
                <>
                  {/* Only while connected: with the presence socket down (server
                      unreachable, or you're incognito) nobody's state is KNOWN, and
                      "Offline" would be a guess (never invent a cause). */}
                  {state.connected && !incognito && <PresencePill row={row} />}
                  <FriendRowMenu
                    pending={f.pendingRows.has(row.id)}
                    onUnfriend={() => f.runMutation(() => window.claude.social.unfriend(row.id), row.id, "Couldn't unfriend — try again")}
                    onBlock={() => f.runMutation(() => window.claude.social.block(row.id), row.id, "Couldn't block — try again")}
                  />
                </>
              )}
            />
          ))}
          {f.outgoing.map((req) => (
            <PersonRow
              key={req.id}
              name={req.to.display_name}
              handle={req.to.handle}
              error={f.rowError[req.id]}
              right={(
                <>
                  <Pill>Request sent</Pill>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => f.runMutation(() => window.claude.social.cancelRequest(req.id), req.id, "Couldn't cancel — try again")}
                    disabled={f.pendingRows.has(req.id)}
                    className="shrink-0"
                  >
                    Cancel
                  </Button>
                </>
              )}
            />
          ))}
        </ul>
      ) : f.loaded ? (
        <p className="text-xs text-fg-muted px-1">No friends yet. Add someone by their handle and they show up here.</p>
      ) : (
        <LoadingState what="your friends" variant="inline" />
      )}

      {look === 'button' && (
        addOpen
          ? <AddFriend refresh={f.refresh} autoFocus onCancel={() => setAddOpen(false)} />
          // Guide "Buttons": a follow-up action under a group is a full-width
          // outlined button (decisions P-3) — not a dashed "add" box (fix batch 1).
          : <Button variant="secondary" className="w-full" onClick={() => setAddOpen(true)}>Add a friend</Button>
      )}
      {look === 'fold' && (
        // Guide "Settings": anything that folds open is a boxed row, arrow on the right.
        <FoldRow title="Add a friend">
          <AddFriend refresh={f.refresh} autoFocus />
        </FoldRow>
      )}
    </div>
  );
}

/** A friend's live state as a pill with its dot (guide "Status and notices":
 *  "A live status … carries its coloured dot inside the pill"; Destin: "online
 *  status should be a status pill probably"). Online and In game are green,
 *  Offline grey (decisions "Status words and provider cards", PL-1…4). */
export function PresencePill({ row }: { row: FriendRowData }) {
  const label = row.online ? (row.online.status === 'in-game' ? 'In game' : 'Online') : 'Offline';
  return <Pill tone={row.online ? 'ok' : 'neutral'} dot>{label}</Pill>;
}

/** One person in a plain list row: name and handle, an optional grey line, and
 *  whatever sits at the right. Shared with the game lobby so a friend reads the
 *  same in both places. */
export function PersonRow({ name, handle, sub, error, right }: {
  name: string;
  handle: string | null;
  sub?: React.ReactNode;
  error?: string;
  right: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-1 px-2 py-1.5">
      <div className="flex items-center gap-2 min-h-7">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-fg truncate">
            {name}
            {handle && <span className="text-fg-muted ml-1">@{handle}</span>}
          </div>
          {sub && <div className="text-2xs text-fg-muted truncate">{sub}</div>}
        </div>
        {right}
      </div>
      {/* WHY FieldError (guide: no red/coloured body text for messages) */}
      {error && <FieldError as="p" size="2xs">{error}</FieldError>}
    </li>
  );
}

/** Add a friend by exact handle — moved here from the lobby (Destin: "no add
 *  friend in game panels"). Behaviour unchanged: lowercase as you type, one
 *  request per press, the Worker's status codes in plain words. */
function AddFriend({ refresh, autoFocus, onCancel }: { refresh: () => Promise<void>; autoFocus?: boolean; onCancel?: () => void }) {
  const [handle, setHandle] = useState('');
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  // True while a sendRequest is in flight — a double-tap must not burn the
  // daily request cap twice.
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const h = handle.trim();
    if (!h || pending) return;
    setPending(true);
    try {
      const res = await window.claude.social.sendRequest(h);
      if (res.ok) {
        setFeedback({ text: res.value.status === 'friends' ? `You're now friends with @${h}` : 'Request sent', ok: true });
        setHandle('');
        await refresh();
        return;
      }
      // 404 = unknown or blocked handle (no enumeration oracle — same message).
      // 429 = daily request cap. 400 = a validation reason the server phrases well.
      const text =
        res.status === 404 ? 'No one has that handle' :
        res.status === 429 ? 'Daily request limit reached — try tomorrow' :
        res.status === 400 ? (res.message || "That request can't be sent") :
        (res.message || 'Could not send the request. Try again.');
      setFeedback({ text, ok: false });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {/* Guide "Buttons": a text box with its own action keeps it inside the
            box, at the right, as a small filled button (decisions P-5, G-8). */}
        <InputGroup size="md" className="flex-1 min-w-0">
          <InputGroup.Field
            type="text"
            aria-label="Friend's handle"
            value={handle}
            autoFocus={autoFocus}
            // Handles are lowercase — normalize as the user types so the exact-match
            // lookup on the Worker doesn't 404 on a stray capital.
            onChange={(e) => setHandle(e.target.value.toLowerCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
              if (e.key === 'Escape' && onCancel) { e.stopPropagation(); onCancel(); }
            }}
            placeholder="Add a friend by their handle"
          />
          <Button size="sm" onClick={() => void submit()} disabled={!handle.trim() || pending} aria-label="Send friend request">
            Add
          </Button>
        </InputGroup>
        {/* Cancel sits OUTSIDE the box (InputGroup sub-rule: only the submit goes inside). */}
        {onCancel && <Button variant="secondary" size="sm" onClick={onCancel} className="shrink-0">Cancel</Button>}
      </div>
      {/* WHY (guide: no red/coloured body text for messages) — success is the
          plain muted line, a failure the shared short error box. */}
      {feedback && (
        feedback.ok
          ? <p className="text-xs text-fg-muted px-1">{feedback.text}</p>
          : <FieldError as="p" size="2xs">{feedback.text}</FieldError>
      )}
    </div>
  );
}

// Per-friend "…" row menu, moved unchanged from the lobby. Manages its own open +
// block-confirm state and closes on outside click (anchored popover pattern from
// MarketplaceAuthChip — no Scrim because it's anchored, not centered). Block is
// consequence-gated: the menu item swaps the popover to a plain-language confirm
// BEFORE acting.
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
        onClick={() => setOpen((o) => !o)}
        title="More"
        aria-label="Friend options"
        // Touch target: p-1.5 gives the ⋯ a ≥32px square hit box on a 320px
        // Android WebView.
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
              {/* Destructive confirm, stacked in a narrow box: red on top (guide "Buttons"). */}
              <div className="flex flex-col gap-2">
                <Button type="button" variant="danger" size="md" onClick={() => { onBlock(); close(); }} disabled={pending} className="w-full">
                  Block
                </Button>
                <Button type="button" variant="secondary" size="md" onClick={() => setConfirmingBlock(false)} className="w-full">
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* py-1.5 keeps menu items ≥32px tall for touch. */}
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
