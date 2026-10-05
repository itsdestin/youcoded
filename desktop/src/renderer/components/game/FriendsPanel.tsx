// The friends panel — the top of the Games list (redesign backlog row 11).
//
// Destin, 2026-09-29: "dont like the warning/sign in banner. it should be at the
// top, and should be replaced by a new friends panel/menu when signed in with
// games below" and, about the lobby, "most of this should be moved out of the
// game menu into the new friends/social panel … no add friend in game panels".
// So everything social lives HERE: whether friends can see you, your friends with
// their status as pills, requests both ways, and adding a friend. A game's lobby
// keeps only people, scores and Challenge (GameLobby.tsx).
//
// Round 2 (deck games-social-1 answers): the card starts FOLDED to one summary line
// with your status as a dropdown at its right (GS-2); it opens to a height-capped
// list that scrolls like Appearance's themes box, with a filled "Add a friend"
// inside it (GC-1, GQ-1). Signed out, the same spot is the Account popup's sign-in
// card (GS-1, GC-2).
import { useEffect, useRef, useState } from 'react';
import { useGameState } from '../../state/game-context';
import { useAccount } from '../../state/account-context';
import { SOCIAL_STATE_COPY, statusLabel, type FriendRowData, type SocialState } from './friends-data';
import { useFriends } from './useFriends';
import { useScrollFade } from '../../hooks/useScrollFade';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, Callout, ChevronDown, FieldError, InputGroup, LoadingState, Pill, SectionLabel, Select } from '../ui';
import { workbenchFriendsOpen, workbenchFriendsSummary } from '../../workbench-mode';

interface Props {
  incognito?: boolean;
  onToggleIncognito?: () => void;
  /** Which connection state is showing (friends-data.ts `socialState`) — computed by the
   *  shell so this card and the game tiles below always agree. */
  social: SocialState;
  /** Bounce the presence connection (the old lobby error screen's Retry). */
  onRetry: () => void;
}

export default function FriendsPanel(props: Props) {
  const { signedIn } = useAccount();
  return (
    // WHY a small label over one card (guide "Spacing" → a label comes first;
    // every card on the page labelled, so "Games" below gets one too): the
    // signed-out card and the friends card sit in the SAME spot under the same
    // label, so signing in swaps the card and nothing else moves.
    <section>
      <SectionLabel className="mb-2">Friends</SectionLabel>
      {signedIn ? <FriendsCard {...props} /> : <SignInCard />}
    </section>
  );
}

function SignInCard() {
  const { signInPending, signInError, startSignIn } = useAccount();
  return (
    // WHY the Account popup's signed-out card (Settings → Account, AccountSection.tsx
    // `SignedOutBody`; decisions "Card levels — landed": "Account sign-in = text +
    // full-width button in one card"). Destin, GS-1: the round-1 card "doesn't match app
    // styling" — it was a centred hero with 14px text; GC-2 picked the full-width button.
    // Same card, same left-aligned 12px line, same full-width filled button.
    <div className={`${CARD_LEVEL_1} p-3 space-y-2.5`}>
      <p className="text-xs text-fg-2">Sign in to play with friends and put your scores on the board.</p>
      <Button onClick={() => { void startSignIn(); }} disabled={signInPending} className="w-full">
        {signInPending ? 'Signing in…' : 'Sign in'}
      </Button>
      {signInError && !signInPending && (
        <FieldError as="p">Sign-in failed: {signInError}. Try again.</FieldError>
      )}
    </div>
  );
}

const STATUS_OPTIONS = [
  { value: 'online', label: 'Online' },
  { value: 'incognito', label: 'Incognito' },
] as const;

function FriendsCard({ incognito, onToggleIncognito, social, onRetry }: Props) {
  const state = useGameState();
  const f = useFriends();
  const look = workbenchFriendsSummary();
  // Starts folded every time the panel opens (Destin, GS-2: "the signed-in state should
  // start collapsed … a one line summary card"). Nothing remembered.
  const [open, setOpen] = useState(workbenchFriendsOpen);
  const [adding, setAdding] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  useScrollFade(listRef);

  const people = f.incoming.length + f.merged.length + f.outgoing.length;
  const online = f.merged.filter((r) => r.online);
  // A friend's live state is only KNOWN while connected; otherwise no pill at all
  // rather than a guessed "Offline" (never present a guess as knowledge).
  const known = social === 'online';
  const requests = f.incoming.length;
  const requestText = requests ? ` · ${requests} ${requests === 1 ? 'request' : 'requests'}` : '';

  // The ONE line the folded card shows (Destin, GS-2: "a one line summary card with number
  // of friends online and such"). No "Friends" title in it: the label above the card already
  // says it. A state other than online says which, in the same words the game tiles use
  // (friends-data.ts SOCIAL_STATE_COPY), so offline, incognito and an unreachable server read
  // differently (GS-12).
  let line: string;
  let pill: React.ReactNode = null;
  if (!f.loaded) line = 'Loading your friends…';
  else if (social !== 'online') line = SOCIAL_STATE_COPY[social].line + requestText;
  else if (f.merged.length === 0) line = `No friends yet${requestText}`;
  else if (look === 'names') {
    pill = online.length > 0 ? <Pill tone="ok" dot>{online.length} online</Pill> : null;
    const names = online.slice(0, 2).map((r) => r.name).join(', ');
    line = (online.length === 0 ? 'Nobody online right now'
      : online.length > 2 ? `${names} and ${online.length - 2} more` : names) + requestText;
  } else {
    line = `${online.length} of ${f.merged.length} online${requestText}`;
  }

  return (
    // One first-level card for the one idea, "your friends" (guide "Card levels").
    <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`} data-friends-card>
      <div className="flex items-center gap-2">
        {/* The summary line opens and closes the card: the setting row's shape (title,
            one line, arrow on the right — guide "Settings": one fold-out style). */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          // The label above says "Friends"; a screen reader on this button hears both.
          aria-label={`Friends — ${line}`}
          className="flex-1 min-w-0 flex items-center gap-2 text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="flex-1 min-w-0 flex items-center gap-2">
            {pill}
            <span className="text-sm text-fg truncate min-w-0">{line}</span>
          </span>
          <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-fg-muted transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={2.5} />
        </button>
        {/* Your own status as ONE dropdown at the right (Destin, GS-2: "'online' should be
            a dropdown on the right, instead of having separate online/go incognito
            things"). The app's one dropdown (ui/Select), as in Settings → Providers. It is
            your CHOICE (seen or hidden); whether you are connected is the line at the left. */}
        {onToggleIncognito && (
          // A fixed-width box: the dropdown fills whatever holds it.
          <div className="w-32 shrink-0">
          <Select
            size="sm"
            aria-label="Your status"
            options={STATUS_OPTIONS}
            value={incognito ? 'incognito' : 'online'}
            onChange={(v) => { if ((v === 'incognito') !== !!incognito) onToggleIncognito(); }}
          />
          </div>
        )}
      </div>

      {/* A connection problem is a notice inside the card it is about, its button inside
          it (guide "Status and notices"). Shown folded or open. Incognito needs none: the
          dropdown and the line already say it, and it is not a problem. */}
      {social === 'offline' && (
        <Callout tone="warning" compact actions={<Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>}>
          This computer is offline. Friends, Connect 4 and Chess come back when it reconnects.
        </Callout>
      )}
      {social === 'server' && (
        <Callout tone="danger" compact actions={<Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>}>
          Can't reach the game server. Flappy and 2048 still play.
        </Callout>
      )}

      {open && (
        // Appearance's themes box (ThemeScreen.tsx; GC-1: "we can make this dark and it can
        // sit inside the container, kinda like what we do for the appearance panel"; GQ-1:
        // "just make it scrollable, like resume browser or other long lists"): a capped box
        // whose list scrolls under the see-through fade (.scroll-mask), with its main button
        // INSIDE at the bottom and the rows passing under it. Online friends first.
        <div className={`relative ${CARD_LEVEL_2} overflow-hidden`}>
          <ul
            ref={listRef}
            className="scroll-mask max-h-64 overscroll-contain p-1 pb-14 flex flex-col gap-0.5"
            // 52 = the button zone's top edge (8px padding + a ~36px button or box + 8px).
            style={{ ['--scroll-mask-under' as string]: '52px' }}
            aria-label="Your friends"
          >
            {f.incoming.map((req) => (
              <PersonRow
                key={req.id}
                name={req.from.display_name}
                handle={req.from.handle}
                sub="Wants to be your friend"
                error={f.rowError[req.id]}
                right={(
                  // Filled Accept on the RIGHT, outlined Decline directly left of it
                  // (Destin, GS-3: "accept should be on the right"; guide "Buttons" →
                  // two side by side: the filled one on the right). Round 1 had it
                  // backwards. One height (shoot's parts-agree check).
                  <div className="flex items-center gap-1.5 shrink-0" data-parts-agree="friend request buttons">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => f.runMutation(() => window.claude.social.declineRequest(req.id), req.id, "Couldn't decline — try again")}
                      disabled={f.pendingRows.has(req.id)}
                    >
                      Decline
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => f.runMutation(() => window.claude.social.acceptRequest(req.id), req.id, "Couldn't accept — try again")}
                      disabled={f.pendingRows.has(req.id)}
                    >
                      Accept
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
                // "Last seen 3h ago" is history, not a live state: the row's grey line.
                sub={!row.online && row.lastSeenAt ? statusLabel(row, Date.now()) : undefined}
                error={f.rowError[row.id]}
                right={(
                  <>
                    {known && <PresencePill row={row} />}
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
            {people === 0 && (
              f.loaded
                ? <li className="px-2 py-1.5 text-xs text-fg-muted">No friends yet. Add someone by their handle and they show up here.</li>
                : <li><LoadingState what="your friends" variant="inline" /></li>
            )}
          </ul>
          <div className="absolute inset-x-0 bottom-0 p-2">
            {adding
              ? <AddFriend refresh={f.refresh} autoFocus onCancel={() => setAdding(false)} />
              // Filled, full width, inside the box — Appearance's "Build new theme".
              : <Button className="w-full" onClick={() => setAdding(true)}>Add a friend</Button>}
          </div>
        </div>
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
