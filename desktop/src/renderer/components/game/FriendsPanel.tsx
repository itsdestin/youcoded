// The friends panel — the top of the Games list (redesign backlog row 11).
//
// Destin, 2026-09-29: the sign-in banner "should be at the top, and should be replaced by a
// new friends panel/menu when signed in with games below"; "most of this should be moved out
// of the game menu into the new friends/social panel … no add friend in game panels". So
// everything social lives HERE; a game's page keeps people, records and Challenge.
//
// Round 2 (games-social-1): folded by default; an Appearance-style capped list with a filled
// "Add a friend" inside it; Account's sign-in card. Round 3 (games-social-2): your status is the
// status PILL itself, clickable; rows are name + pill; no internet / server down replace the
// whole card with an error box. Round 4 (games-social-3): Account's profile-row header shipped
// (G3C-1); each friend is a box like the game page's (G3-4); the ⋯ menu is gone — three ways to
// manage a friend are on the deck (G3-3); the error box drops its red title (G3-7).
import { useEffect, useRef, useState } from 'react';
import { useGameState } from '../../state/game-context';
import { useAccount } from '../../state/account-context';
import { statusLabel, type FriendRowData, type SocialState } from './friends-data';
import { useFriends } from './useFriends';
import { useScrollFade } from '../../hooks/useScrollFade';
import { useEscClose } from '../../hooks/use-esc-close';
import { Button, CARD_LEVEL_1, Callout, ChevronDown, Dialog, FieldError, InputGroup, LoadingState, Pill, PillButton, SectionLabel } from '../ui';
import { workbenchFriendManage, workbenchFriendsOpen, workbenchManageOpen, workbenchStatusMenuOpen } from '../../workbench-mode';
import { useScreenOpen } from '../../shoot-mode';

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

/** No internet / game server down: the whole card is the problem (G2-5). The guide's one notice
 *  box with its button inside (guide "Status and notices"). NO title (G3-7: "that red text seems
 *  to be unique styling not used elsewhere"): of the app's 16 red notice boxes, 13 carry no
 *  title and say it in one plain sentence — the 3 with a red title (Marketplace install
 *  failure, integration error, local model failed to load) are the odd ones out, and
 *  `ErrorState`'s title is normal text colour. Words per the error-message standards: "No
 *  internet" only when the computer reports no network at all (useNetworkOnline); otherwise
 *  WHERE it failed, never a guessed why. */
function ConnectionErrorCard({ social, onRetry }: { social: 'offline' | 'server'; onRetry: () => void }) {
  const offline = social === 'offline';
  return (
    <Callout tone={offline ? 'warning' : 'danger'} actions={<Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>}>
      {offline
        ? 'No internet connection. Your friends, Connect 4 and Chess come back when this computer reconnects; Flappy and 2048 still play.'
        : "Can't reach the game server. Your friends, Connect 4 and Chess are unavailable until it answers; Flappy and 2048 still play."}
    </Callout>
  );
}

/** A small menu anchored under its trigger — the old ⋯ row menu's popover (MarketplaceAuthChip's
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
  // Starts folded every time the panel opens (GS-2). Nothing remembered.
  const [open, setOpen] = useState(workbenchFriendsOpen);
  // Your account's display name — the name your friends see.
  const myName = user?.display_name || user?.login || 'You';
  const online = f.merged.filter((r) => r.online);
  const requests = f.incoming.length;
  const requestText = requests ? ` · ${requests} ${requests === 1 ? 'request' : 'requests'}` : '';
  const total = `${f.merged.length} ${f.merged.length === 1 ? 'friend' : 'friends'}`;

  // The grey line under your name. While incognito the presence connection is OFF (that is what
  // incognito is: usePresence disconnects), so nobody's online state reaches this computer —
  // there is no number to show, and inventing one is not allowed (G3-9 asked for the count; the
  // honest answer is that it is hidden while you are hidden).
  const summary = !f.loaded ? 'Loading your friends…'
    : f.merged.length === 0 ? `No friends yet${requestText}`
    : social === 'incognito' ? `${total} · who's online is hidden${requestText}`
    : social === 'connecting' ? `${total} · connecting…${requestText}`
    : `${online.length} of ${total} online${requestText}`;

  return (
    // One first-level card for the one idea, "your friends" (guide "Card levels"). Its header is
    // Settings → Account's profile row (Destin picked it, G3C-1): your name with your clickable
    // status pill, one grey line under it, the arrow at the right.
    <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`} data-friends-card>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-fg truncate min-w-0">{myName}</span>
            <SelfStatus incognito={incognito} connected={state.connected} onToggleIncognito={onToggleIncognito} />
          </div>
          <p className="text-2xs text-fg-muted truncate">{summary}</p>
        </div>
        <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} count={f.merged.length} />
      </div>
      {open && <PeopleList f={f} known={social === 'online'} />}
    </div>
  );
}

/** The box every person sits in — the game page's row look (G3-4: "use cards styled more like
 *  this in the previous menu's scrollable friend list"): the Settings list's boxed row
 *  (SettingRow's surface = CARD_LEVEL_1, which re-levels itself to the nested look inside the
 *  friends card). `onClick` makes the whole box the button (the details variant), with the
 *  setting row's arrow at the right. */
function PersonBox({ name, pill, sub, right, error, onClick, children }: {
  name: string; pill?: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode;
  error?: string; onClick?: () => void; children?: React.ReactNode;
}) {
  const line = (
    <div className="flex items-center gap-2 min-h-8">
      <div className="flex-1 min-w-0 text-left">
        <NameWithPill name={name} pill={pill} />
        {sub && <div className="text-2xs text-fg-muted truncate">{sub}</div>}
      </div>
      {right}
      {onClick && (
        <svg className="w-4 h-4 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      )}
    </div>
  );
  return (
    <li className={`${CARD_LEVEL_1} px-3 py-1.5 flex flex-col gap-1.5`}>
      {onClick
        ? <button type="button" onClick={onClick} className="w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={`${name} — details`}>{line}</button>
        : line}
      {children}
      {/* WHY FieldError (guide: no red/coloured body text for messages) */}
      {error && <FieldError as="p" size="2xs">{error}</FieldError>}
    </li>
  );
}

/** The people: boxes 8px apart that scroll under the see-through fade, with a filled "Add a
 *  friend" inside the scroll area at the bottom — Appearance's themes box (GC-1, GQ-1). */
function PeopleList({ f, known }: { f: ReturnType<typeof useFriends>; known: boolean }) {
  const manage = workbenchFriendManage();
  const [adding, setAdding] = useState(false);
  // Which friend's management is open: the popup (details), the opened box (inline). Edit mode
  // is one switch for the whole list.
  const first = f.merged[0]?.id ?? null;
  const [focus, setFocus] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Practice state: open the chosen management view on the first friend for pictures.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !first || !workbenchManageOpen()) return;
    setSeeded(true);
    if (manage === 'edit') setEditing(true); else setFocus(first);
  }, [first, manage, seeded]);
  // Photo-only build: shoot opens the friend details popup by name.
  useScreenOpen('chat/games/friend', () => { if (first) setFocus(first); });

  const listRef = useRef<HTMLUListElement>(null);
  useScrollFade(listRef);
  const people = f.incoming.length + f.merged.length + f.outgoing.length;
  const focused = f.merged.find((r) => r.id === focus) ?? null;
  const unfriend = (id: string) => f.runMutation(() => window.claude.social.unfriend(id), id, "Couldn't unfriend — try again");
  const block = (id: string) => f.runMutation(() => window.claude.social.block(id), id, "Couldn't block — try again");

  return (
    <div className="relative">
      <ul
        ref={listRef}
        className="scroll-mask max-h-72 overscroll-contain pb-14 flex flex-col gap-2"
        // 52 = the button zone's top edge (8px gap + a ~36px button or box + 8px).
        style={{ ['--scroll-mask-under' as string]: '52px' }}
        aria-label="Your friends"
      >
        {f.incoming.map((req) => (
          <PersonBox
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
        {f.merged.map((row) => {
          const pill = known ? <PresencePill row={row} /> : undefined;
          const lastSeen = !row.online && row.lastSeenAt ? statusLabel(row, Date.now()) : undefined;
          if (manage === 'details') {
            return <PersonBox key={row.id} name={row.name} pill={pill} sub={lastSeen} error={f.rowError[row.id]} onClick={() => setFocus(row.id)} />;
          }
          if (manage === 'inline') {
            const isOpen = focus === row.id;
            return (
              <PersonBox
                key={row.id}
                name={row.name}
                pill={pill}
                sub={lastSeen}
                error={f.rowError[row.id]}
                right={(
                  <Button variant="secondary" size="sm" aria-expanded={isOpen} onClick={() => setFocus(isOpen ? null : row.id)} className="shrink-0">
                    {isOpen ? 'Done' : 'Manage'}
                  </Button>
                )}
              >
                {isOpen && <ManageFriend row={row} pending={f.pendingRows.has(row.id)} onUnfriend={() => unfriend(row.id)} onBlock={() => block(row.id)} />}
              </PersonBox>
            );
          }
          // edit: every friend shows its handle and its two actions while editing.
          return (
            <EditRow
              key={row.id}
              row={row}
              pill={pill}
              sub={editing ? (row.handle ? `@${row.handle}` : 'No handle') : lastSeen}
              editing={editing}
              error={f.rowError[row.id]}
              pending={f.pendingRows.has(row.id)}
              onUnfriend={() => unfriend(row.id)}
              onBlock={() => block(row.id)}
            />
          );
        })}
        {f.outgoing.map((req) => (
          <PersonBox
            key={req.id}
            name={req.to.display_name}
            pill={<Pill>Request sent</Pill>}
            error={f.rowError[req.id]}
            right={<Button variant="secondary" size="sm" onClick={() => f.runMutation(() => window.claude.social.cancelRequest(req.id), req.id, "Couldn't cancel — try again")} disabled={f.pendingRows.has(req.id)} className="shrink-0">Cancel</Button>}
          />
        ))}
        {people === 0 && (
          f.loaded
            ? <li className="px-1 py-1.5 text-xs text-fg-muted">No friends yet. Add someone by their handle and they show up here.</li>
            : <li><LoadingState what="your friends" variant="inline" /></li>
        )}
      </ul>
      <div className="absolute inset-x-0 bottom-0 pt-2">
        {manage === 'edit' && f.merged.length > 0 ? (
          // Settings → Account's Edit account: an Edit button, and Done to leave the mode. Two
          // buttons side by side: the filled one on the right (guide "Buttons").
          editing
            ? <Button className="w-full" onClick={() => setEditing(false)}>Done</Button>
            : adding
              ? <AddFriend refresh={f.refresh} autoFocus onCancel={() => setAdding(false)} />
              : (
                <div className="flex gap-2">
                  <Button variant="secondary" className="flex-1" onClick={() => setEditing(true)}>Edit friends</Button>
                  <Button className="flex-1" onClick={() => setAdding(true)}>Add a friend</Button>
                </div>
              )
        ) : adding
          ? <AddFriend refresh={f.refresh} autoFocus onCancel={() => setAdding(false)} />
          // Filled, full width, inside the list's area — Appearance's "Build new theme".
          : <Button className="w-full" onClick={() => setAdding(true)}>Add a friend</Button>}
      </div>
      {manage === 'details' && (
        <FriendDetails
          row={focused}
          pending={focused ? f.pendingRows.has(focused.id) : false}
          known={known}
          onClose={() => setFocus(null)}
          onUnfriend={() => { if (focused) { void unfriend(focused.id); setFocus(null); } }}
          onBlock={() => { if (focused) { void block(focused.id); setFocus(null); } }}
        />
      )}
    </div>
  );
}

/** Block is consequence-gated in every variant: the first press swaps to a plain-language
 *  confirm, and only the red button inside it acts (Destin's standing rule for hard-to-reverse
 *  actions). */
const BLOCK_WARNING = 'Blocking removes this friend, cancels pending requests, and hides you from each other. You can unblock later in Settings → Account.';

/** The `details` variant: a small popup about one friend — the shared popup titled by kind, the
 *  friend's own card first with no label above it (Session details; the Marketplace detail
 *  pages' "top card"), then Unfriend / Block as outlined and red buttons. */
function FriendDetails({ row, pending, known, onClose, onUnfriend, onBlock }: {
  row: FriendRowData | null; pending: boolean; known: boolean;
  onClose: () => void; onUnfriend: () => void; onBlock: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { setConfirming(false); }, [row?.id]);
  return (
    <Dialog open={!!row} onClose={onClose} title="Friend details" size="prompt" screen="chat/games/friend">
      {row && (
        <div className="flex flex-col gap-4">
          <div className={`${CARD_LEVEL_1} p-3`}>
            <NameWithPill name={row.name} pill={known ? <PresencePill row={row} /> : undefined} />
            <p className="text-2xs text-fg-muted truncate">
              {row.handle ? `@${row.handle}` : 'No handle'}
              {!row.online && row.lastSeenAt ? ` · ${statusLabel(row, Date.now())}` : ''}
            </p>
          </div>
          {confirming ? (
            <Callout tone="danger">
              <p className="mb-2">{BLOCK_WARNING}</p>
              {/* Stacked in a narrow popup: red on top (guide "Buttons" → destructive confirm). */}
              <div className="flex flex-col gap-2">
                <Button variant="danger" className="w-full" onClick={onBlock} disabled={pending}>Block {row.name}</Button>
                <Button variant="secondary" className="w-full" onClick={() => setConfirming(false)}>Cancel</Button>
              </div>
            </Callout>
          ) : (
            // Two follow-up actions under the card: full-width outlined, stacked (guide
            // "Buttons": a follow-up action under a group; narrow popups stack).
            <div className="flex flex-col gap-2">
              <Button variant="secondary" className="w-full" onClick={onUnfriend} disabled={pending}>Unfriend</Button>
              <Button variant="secondary" className="w-full" onClick={() => setConfirming(true)}>Block…</Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** The block confirm every variant shows inside the friend's box: the warning in words, then
 *  Cancel and the red Block side by side, red on the right (guide "Buttons" → destructive
 *  confirm). */
function BlockConfirm({ pending, onBlock, onCancel }: { pending: boolean; onBlock: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-2 pb-1.5">
      <p className="text-xs text-fg-2">{BLOCK_WARNING}</p>
      <div className="flex gap-2 justify-end" data-parts-agree="block confirm buttons">
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="danger" size="sm" onClick={onBlock} disabled={pending}>Block</Button>
      </div>
    </div>
  );
}

/** The `inline` variant: the friend's box opens in place (the Tags card's edit-in-place) to show
 *  the handle and the two actions. */
function ManageFriend({ row, pending, onUnfriend, onBlock }: { row: FriendRowData; pending: boolean; onUnfriend: () => void; onBlock: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col gap-2 pb-1.5">
      <p className="text-2xs text-fg-muted">{row.handle ? `@${row.handle}` : 'No handle'}</p>
      {confirming
        ? <BlockConfirm pending={pending} onBlock={onBlock} onCancel={() => setConfirming(false)} />
        : (
          <div className="flex gap-2 justify-end" data-parts-agree="manage friend buttons">
            <Button variant="secondary" size="sm" onClick={onUnfriend} disabled={pending}>Unfriend</Button>
            <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>Block…</Button>
          </div>
        )}
    </div>
  );
}

/** The `edit` variant's row: in edit mode (Settings → Account's Edit account), the handle shows
 *  under the name and Unfriend / Block… sit at the right; Block asks inside the box first. */
function EditRow({ row, pill, sub, editing, error, pending, onUnfriend, onBlock }: {
  row: FriendRowData; pill?: React.ReactNode; sub?: string; editing: boolean; error?: string;
  pending: boolean; onUnfriend: () => void; onBlock: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (!editing) setConfirming(false); }, [editing]);
  return (
    <PersonBox
      name={row.name}
      pill={pill}
      sub={sub}
      error={error}
      right={editing && !confirming ? (
        <div className="flex items-center gap-1.5 shrink-0" data-parts-agree="edit friend buttons">
          <Button variant="secondary" size="sm" onClick={onUnfriend} disabled={pending}>Unfriend</Button>
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>Block…</Button>
        </div>
      ) : undefined}
    >
      {editing && confirming && <BlockConfirm pending={pending} onBlock={onBlock} onCancel={() => setConfirming(false)} />}
    </PersonBox>
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

