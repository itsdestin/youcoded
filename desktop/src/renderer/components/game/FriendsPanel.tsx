// The friends panel — the top of the Games list (redesign backlog row 11).
//
// Destin, 2026-09-29: the sign-in banner "should be at the top, and should be replaced by a
// new friends panel/menu when signed in with games below"; "most of this should be moved out
// of the game menu into the new friends/social panel … no add friend in game panels". So
// everything social lives HERE; a game's page keeps people, records and Challenge.
//
// Round 2 (games-social-1): folded by default; an Appearance-style capped list with a filled
// "Add a friend" inside it; Account's sign-in card. Round 3 (games-social-2): your status is
// the status PILL itself, clickable (G2-2); rows are name + pill, handle only in the ⋯ menu
// (G2-3/G2-7); no internet / server down replace the whole card with the error card (G2-5);
// three ways to show your status beside your friends' are on the deck (G2C-1).
import { useEffect, useRef, useState } from 'react';
import { useGameState } from '../../state/game-context';
import { useAccount } from '../../state/account-context';
import { statusLabel, type FriendRowData, type SocialState } from './friends-data';
import { useFriends } from './useFriends';
import { useScrollFade } from '../../hooks/useScrollFade';
import { useEscClose } from '../../hooks/use-esc-close';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, Callout, ChevronDown, FieldError, InputGroup, LoadingState, Pill, PillButton, SectionLabel } from '../ui';
import { workbenchFriendsOpen, workbenchStatusLook, workbenchStatusMenuOpen } from '../../workbench-mode';

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
    // WHY a small label over one card (guide "Spacing" → a label comes first): the signed-out
    // card, the error card and the friends card all sit in the SAME spot under the same label.
    <section>
      <SectionLabel className="mb-2">Friends</SectionLabel>
      {!signedIn ? <SignInCard />
        : props.social === 'offline' || props.social === 'server' ? <ConnectionErrorCard social={props.social} onRetry={props.onRetry} />
        : <FriendsCard {...props} />}
    </section>
  );
}

function SignInCard() {
  const { signInPending, signInError, startSignIn } = useAccount();
  return (
    // WHY the Account popup's signed-out card (Settings → Account `SignedOutBody`; GS-1, GC-2).
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

/** No internet / game server down: the whole card is the problem (Destin, G2-5: "could
 *  probably just replace the whole card with the error state?"). The guide's one notice box
 *  with its button inside (guide "Status and notices"). Words per the error-message
 *  standards: "No internet" only when the computer reports no network at all
 *  (useNetworkOnline); otherwise WHERE it failed, never a guessed why. */
function ConnectionErrorCard({ social, onRetry }: { social: 'offline' | 'server'; onRetry: () => void }) {
  const offline = social === 'offline';
  return (
    <Callout
      tone={offline ? 'warning' : 'danger'}
      title={offline ? 'No internet connection' : "Can't reach the game server"}
      actions={<Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>}
    >
      {offline
        ? 'This computer is offline. Your friends, Connect 4 and Chess come back when it reconnects. Flappy and 2048 still play.'
        : 'Your friends, Connect 4 and Chess are unavailable until it answers. Flappy and 2048 still play.'}
    </Callout>
  );
}

/** A small menu anchored under its trigger — the ⋯ row menu's popover (MarketplaceAuthChip's
 *  pattern: no scrim, closes on an outside click and on Esc). */
function useAnchoredMenu(initial = false) {
  const [open, setOpen] = useState(initial);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  useEscClose(open, () => setOpen(false));
  return { open, setOpen, wrapRef };
}

const MENU = 'layer-surface absolute top-full mt-1 rounded-md p-1.5 text-xs shadow-md';
const MENU_ITEM = 'w-full text-left px-2 py-1.5 rounded text-fg-2 hover:text-fg hover:bg-inset disabled:opacity-40 transition-colors';

/** Your own status: the status pill itself, clickable, opening Online / Incognito (G2-2:
 *  "keep the styling of the online pill, but make it clickable"). */
function SelfStatus({ incognito, connected, onToggleIncognito }: { incognito?: boolean; connected: boolean; onToggleIncognito?: () => void }) {
  const m = useAnchoredMenu(workbenchStatusMenuOpen());
  const label = incognito ? 'Incognito' : connected ? 'Online' : 'Connecting…';
  const tone = !incognito && connected ? 'ok' : 'neutral';
  if (!onToggleIncognito) return <Pill tone={tone} dot>{label}</Pill>;
  const pick = (hide: boolean) => { if (hide !== !!incognito) onToggleIncognito(); m.setOpen(false); };
  return (
    <div ref={m.wrapRef} className="relative shrink-0 flex">
      <PillButton tone={tone} dot open={m.open} onClick={() => m.setOpen((o) => !o)} aria-label={`Your status: ${label}`}>
        {label}
      </PillButton>
      {m.open && (
        // z-index 62 = one above L2 popup content (61), as the row menu.
        <div role="menu" className={`${MENU} left-0 min-w-60`} style={{ zIndex: 62 }}>
          <button type="button" role="menuitemradio" aria-checked={!incognito} onClick={() => pick(false)} className={MENU_ITEM}>
            <span className="block text-fg">Online</span>
            <span className="block text-2xs text-fg-muted">Friends see you and can challenge you</span>
          </button>
          <button type="button" role="menuitemradio" aria-checked={!!incognito} onClick={() => pick(true)} className={MENU_ITEM}>
            <span className="block text-fg">Incognito</span>
            <span className="block text-2xs text-fg-muted">Hidden from friends; no challenges</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** The open/close arrow — the fold-out's right-hand arrow (guide "Settings": one fold-out
 *  style) as its own button, so it never wraps the clickable status pill. */
function FoldToggle({ open, onToggle, count }: { open: boolean; onToggle: () => void; count: number }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? 'Hide friends' : `Show all ${count} friends`}
      className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-fg-muted hover:text-fg-2 hover:bg-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={2.5} />
    </button>
  );
}

function FriendsCard({ incognito, onToggleIncognito, social }: Props) {
  const state = useGameState();
  const { user } = useAccount();
  const f = useFriends();
  const look = workbenchStatusLook();
  // Your account's display name — the name your friends see (the arcade's own `username` can
  // be a placeholder before presence connects).
  const myName = user?.display_name || user?.login || 'You';
  // Starts folded every time the panel opens (GS-2). Nothing remembered.
  const [open, setOpen] = useState(workbenchFriendsOpen);
  // Friends' live states are KNOWN only while connected — otherwise no pill, never a guess.
  const known = social === 'online';
  const online = f.merged.filter((r) => r.online);
  const requests = f.incoming.length;
  const requestText = requests ? ` · ${requests} ${requests === 1 ? 'request' : 'requests'}` : '';
  const self = <SelfStatus incognito={incognito} connected={state.connected} onToggleIncognito={onToggleIncognito} />;
  const toggle = <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} count={f.merged.length} />;

  const summary = !f.loaded ? 'Loading your friends…'
    : f.merged.length === 0 ? `No friends yet${requestText}`
    : social === 'incognito' ? `Friends can't see you · ${f.merged.length} friends${requestText}`
    : `${online.length} of ${f.merged.length} friends online${requestText}`;

  return (
    // One first-level card for the one idea, "your friends" (guide "Card levels").
    <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`} data-friends-card data-status-look={look}>
      {look === 'account' && (
        // Settings → Account's profile row: your name with your status beside it, one grey
        // line under it, the control at the right — here, the count of friends online.
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium text-fg truncate min-w-0">{myName}</span>
              {self}
            </div>
            <p className="text-2xs text-fg-muted truncate">{summary}</p>
          </div>
          {toggle}
        </div>
      )}
      {look === 'strip' && (
        // One line: your pill, then who is online as pills in the same look — a status strip,
        // like a detail page's one-line chip row; anyone past three folds into "+N".
        <div className="flex items-center gap-2 min-w-0">
          {self}
          <span className="w-px h-4 bg-edge-dim shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden">
            {!f.loaded ? <span className="text-2xs text-fg-muted">Loading…</span>
              : social === 'incognito' ? <span className="text-2xs text-fg-muted truncate">Friends can't see you</span>
              : online.length === 0 ? <span className="text-2xs text-fg-muted truncate">{f.merged.length ? 'Nobody online' : 'No friends yet'}</span>
              : online.slice(0, 3).map((r) => <Pill key={r.id} tone="ok" dot>{r.name}</Pill>)}
            {known && online.length > 3 && <Pill>+{online.length - 3}</Pill>}
            {requests > 0 && <Pill tone="info">{requests} {requests === 1 ? 'request' : 'requests'}</Pill>}
          </div>
          {toggle}
        </div>
      )}
      {look === 'roster' ? (
        // The sessions menu: a list of people with their status pills, YOU first. Folded, only
        // the ones you could play now (and any request waiting); open, everyone.
        <PeopleList f={f} known={known} rows={open ? 'all' : 'online'} you={self} youName={myName}
          footer={<FoldRowButton open={open} onToggle={() => setOpen((o) => !o)} count={f.merged.length} />} />
      ) : open && <PeopleList f={f} known={known} rows="all" />}
    </div>
  );
}

/** The roster's "show everyone" row at the foot of its list — a plain row like a menu's last
 *  row ("Manage models…"), arrow on the right. */
function FoldRowButton({ open, onToggle, count }: { open: boolean; onToggle: () => void; count: number }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open}
      className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-xs text-fg-2 hover:text-fg hover:bg-inset transition-colors">
      {/* A count beside a label is the word then a smaller, fainter number (guide "Text and numbers"). */}
      <span>{open ? 'Show online only' : <>All friends <span className="text-2xs text-fg-muted">{count}</span></>}</span>
      <ChevronDown className={`w-3 h-3 shrink-0 text-fg-muted transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={2.5} />
    </button>
  );
}

/** The people, as plain rows in one nested box that scrolls under the see-through fade with a
 *  filled "Add a friend" inside it at the bottom — Appearance's themes box (GC-1, GQ-1). */
function PeopleList({ f, known, rows, you, youName, footer }: {
  f: ReturnType<typeof useFriends>;
  known: boolean;
  rows: 'all' | 'online';
  you?: React.ReactNode;
  youName?: string;
  footer?: React.ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  useScrollFade(listRef);
  const friends = rows === 'all' ? f.merged : f.merged.filter((r) => r.online);
  const showAdd = rows === 'all';
  const people = f.incoming.length + f.merged.length + f.outgoing.length;
  return (
    <div className={`relative ${CARD_LEVEL_2} overflow-hidden`}>
      <ul
        ref={listRef}
        className={`scroll-mask max-h-64 overscroll-contain p-1 ${showAdd ? 'pb-14' : ''} flex flex-col gap-0.5`}
        // 52 = the button zone's top edge (8px padding + a ~36px button or box + 8px).
        style={showAdd ? { ['--scroll-mask-under' as string]: '52px' } : undefined}
        aria-label="Your friends"
      >
        {you && <PersonRow name={!youName || youName === 'You' ? 'You' : `${youName} (you)`} pill={you} />}
        {f.incoming.map((req) => (
          <PersonRow
            key={req.id}
            name={req.from.display_name}
            sub="Wants to be your friend"
            error={f.rowError[req.id]}
            right={(
              // Filled Accept on the RIGHT, Decline left of it (GS-3; guide "Buttons").
              <div className="flex items-center gap-1.5 shrink-0" data-parts-agree="friend request buttons">
                <Button variant="secondary" size="sm" onClick={() => f.runMutation(() => window.claude.social.declineRequest(req.id), req.id, "Couldn't decline — try again")} disabled={f.pendingRows.has(req.id)}>Decline</Button>
                <Button size="sm" onClick={() => f.runMutation(() => window.claude.social.acceptRequest(req.id), req.id, "Couldn't accept — try again")} disabled={f.pendingRows.has(req.id)}>Accept</Button>
              </div>
            )}
          />
        ))}
        {friends.map((row) => (
          <PersonRow
            key={row.id}
            name={row.name}
            pill={known ? <PresencePill row={row} /> : undefined}
            // "Last seen 3h ago" is history, not a live state: the row's grey line.
            sub={!row.online && row.lastSeenAt ? statusLabel(row, Date.now()) : undefined}
            error={f.rowError[row.id]}
            right={(
              <FriendRowMenu
                name={row.name}
                handle={row.handle}
                pending={f.pendingRows.has(row.id)}
                onUnfriend={() => f.runMutation(() => window.claude.social.unfriend(row.id), row.id, "Couldn't unfriend — try again")}
                onBlock={() => f.runMutation(() => window.claude.social.block(row.id), row.id, "Couldn't block — try again")}
              />
            )}
          />
        ))}
        {rows === 'all' && f.outgoing.map((req) => (
          <PersonRow
            key={req.id}
            name={req.to.display_name}
            pill={<Pill>Request sent</Pill>}
            error={f.rowError[req.id]}
            right={<Button variant="secondary" size="sm" onClick={() => f.runMutation(() => window.claude.social.cancelRequest(req.id), req.id, "Couldn't cancel — try again")} disabled={f.pendingRows.has(req.id)} className="shrink-0">Cancel</Button>}
          />
        ))}
        {rows === 'online' && friends.length === 0 && f.loaded && f.merged.length > 0 && (
          <li className="px-2 py-1.5 text-xs text-fg-muted">Nobody online right now.</li>
        )}
        {people === 0 && (
          f.loaded
            ? <li className="px-2 py-1.5 text-xs text-fg-muted">No friends yet. Add someone by their handle and they show up here.</li>
            : <li><LoadingState what="your friends" variant="inline" /></li>
        )}
        {footer && <li>{footer}</li>}
      </ul>
      {showAdd && (
        <div className="absolute inset-x-0 bottom-0 p-2">
          {adding
            ? <AddFriend refresh={f.refresh} autoFocus onCancel={() => setAdding(false)} />
            // Filled, full width, inside the box — Appearance's "Build new theme".
            : <Button className="w-full" onClick={() => setAdding(true)}>Add a friend</Button>}
        </div>
      )}
    </div>
  );
}

/** A friend's live state as a pill with its dot (guide "Status and notices"). Online and In
 *  game green, Offline grey (decisions PL-1…4). */
export function PresencePill({ row }: { row: FriendRowData }) {
  const label = row.online ? (row.online.status === 'in-game' ? 'In game' : 'Online') : 'Offline';
  return <Pill tone={row.online ? 'ok' : 'neutral'} dot>{label}</Pill>;
}

/** The friend's name with its status pill directly right of it, centred on the name's line
 *  (Destin, G2-7: "hide the @ tag in favor of the name … i like the online chip right next to
 *  the name. vertical alignment is a bit off"). Exported for the game page's rows.
 *  WHY `h-5` on both: the name's line box and the pill share one 20px row and are centred in
 *  it, so the pill can't sit on the text's baseline (round 2 let the pill ride the baseline of a
 *  24px-leading name — a pixel or two low at 1.5×). */
export function NameWithPill({ name, pill }: { name: string; pill?: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2 min-w-0 h-5" data-name-pill>
      <span className="text-sm leading-5 text-fg truncate min-w-0">{name}</span>
      {pill && <span className="flex items-center h-5 shrink-0">{pill}</span>}
    </span>
  );
}

/** One person: name + pill, an optional grey line under it, and the row's action at the right
 *  edge, centred on the row (guide "Actions live on the right"; the setting row's control slot). */
function PersonRow({ name, pill, sub, error, right }: {
  name: string;
  pill?: React.ReactNode;
  sub?: React.ReactNode;
  error?: string;
  right?: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-1 px-2 py-1.5">
      <div className="flex items-center gap-2 min-h-7">
        <div className="flex-1 min-w-0">
          <NameWithPill name={name} pill={pill} />
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

// Per-friend "…" row menu. The friend's @handle lives HERE now and nowhere else (G2-7: "only
// show @ tags in the manage friend/3 dot menu"), as the menu's own header. Block is
// consequence-gated: it swaps the menu to a plain-language confirm BEFORE acting.
function FriendRowMenu({ name, handle, onUnfriend, onBlock, pending }: { name: string; handle: string | null; onUnfriend: () => void; onBlock: () => void; pending?: boolean }) {
  const m = useAnchoredMenu();
  const [confirmingBlock, setConfirmingBlock] = useState(false);
  const close = () => { m.setOpen(false); setConfirmingBlock(false); };
  return (
    <div ref={m.wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => { m.setOpen((o) => !o); setConfirmingBlock(false); }}
        title="Manage friend"
        aria-label="Friend options"
        aria-haspopup="menu"
        aria-expanded={m.open}
        // Same 28px square as the header's ✕ and the fold arrow, centred on the row.
        className="w-7 h-7 flex items-center justify-center rounded-md text-fg-muted hover:text-fg-2 hover:bg-inset coarse-hit transition-colors"
      >
        ⋯
      </button>
      {m.open && (
        <div role="menu" className={`${MENU} right-0 min-w-56`} style={{ zIndex: 62 }}>
          <div className="px-2 pt-1 pb-1.5">
            <div className="text-xs font-medium text-fg truncate">{name}</div>
            {handle && <div className="text-2xs text-fg-muted truncate">@{handle}</div>}
          </div>
          {confirmingBlock ? (
            <div className="flex flex-col gap-2 p-1">
              <p className="text-fg-2 leading-snug">
                Blocking removes this friend, cancels pending requests, and hides you
                from each other. You can unblock later in Settings → Account.
              </p>
              {/* Destructive confirm, stacked in a narrow box: red on top (guide "Buttons"). */}
              <div className="flex flex-col gap-2">
                <Button type="button" variant="danger" size="md" onClick={() => { onBlock(); close(); }} disabled={pending} className="w-full">Block</Button>
                <Button type="button" variant="secondary" size="md" onClick={() => setConfirmingBlock(false)} className="w-full">Cancel</Button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => { onUnfriend(); close(); }} disabled={pending} className={MENU_ITEM}>Unfriend</button>
              <button type="button" role="menuitem" onClick={() => setConfirmingBlock(true)} className="w-full text-left px-2 py-1.5 rounded text-destructive-fg hover:bg-inset transition-colors">Block</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
