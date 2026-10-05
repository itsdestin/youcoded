import { useState, useEffect } from 'react';
import { useGameState, useGameDispatch } from '../../state/game-context';
import { useAccount } from '../../state/account-context';
import BrailleSpinner from '../BrailleSpinner';
import { GameConnection } from '../../state/game-types';
import { Button, CARD_LEVEL_1, Callout, FieldError, LoadingState, SectionLabel, SettingRow } from '../ui';
import type { HeadToHead } from '../../state/marketplace-api-client';
import { recordSentence, recordsByOpponent } from './head-to-head';
import { useFriends, type ApiResult } from './useFriends';
import { PresencePill } from './FriendsPanel';
import { workbenchLobbyRows } from '../../workbench-mode';
// WHY (Office fix round 5): the reload button reloads the window, so open Office documents save first.
import { reloadAfterOfficeSave } from '../office/office-store';
// Task 7c, workbench-only auto-play — see the effect below and
// dev/workbench/fake-party.ts. isWorkbenchAutoplay() is false in every
// shipped build (it checks for a global only install-mock.ts ever sets).
import { isWorkbenchAutoplay, JAKE_ID } from '../../dev/workbench/fake-party';

interface Props {
  connection: GameConnection;
  incognito?: boolean;
  onToggleIncognito?: () => void;
  /** WHICH game this lobby is challenging people to. The arcade shell passes
   *  the game the user opened; before the split every challenge was hardcoded
   *  to Connect 4 (§3.1 item 3). */
  gameId: string;
  /** "Add a friend" from an empty lobby: back to the Games list, where adding
   *  friends lives now (backlog row 11). */
  onAddFriend?: () => void;
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

// The lobby (redesign backlog row 11). Destin: "this game panel should just show
// scores for each person and such with challenge. no add friend in game panels."
// Everything social — your own presence, add a friend, requests, unfriend/block —
// moved to the friends panel at the top of the Games list (FriendsPanel.tsx). What
// stays is what you came to a game for: an incoming challenge, and each friend with
// their live state, your record against them AT THIS GAME, and Challenge.
function LobbyScreen({ connection, incognito, onToggleIncognito, gameId, onAddFriend }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const f = useFriends();
  const look = workbenchLobbyRows();
  /** Head-to-head records for THIS game, keyed by opponent (§6.2). Empty until
   *  the fetch lands, and empty forever if it fails — a row simply shows no
   *  number, which is the honest state. */
  const [records, setRecords] = useState<Map<string, HeadToHead>>(new Map());
  useEffect(() => {
    let live = true;
    const arcade = (window.claude as { arcade?: { records?: (g?: string) => Promise<ApiResult<HeadToHead[]>> } }).arcade;
    // Narrowed to this game: winning at Connect 4 says nothing about who is
    // better at chess, so one number per (person, game) and never a total.
    void (arcade?.records?.(gameId) ?? Promise.resolve(null)).then((rec) => {
      if (live && rec?.ok) setRecords(recordsByOpponent(rec.value, gameId));
    });
    return () => { live = false; };
  }, [gameId]);

  return (
    <div className="flex flex-col gap-4 p-3">
      {/* Incoming challenge — challengeFrom is account identity: .id is the
          stable key passed to respondToChallenge, .name the visible tag. Room
          codes still exist INTERNALLY as the capability token for PartyKit rooms
          — accepting joins by the received code below. */}
      {state.challengeFrom && (
        // WHY a Callout (quick-fix batch): the guide's one notice box. Buttons
        // stay under the words, each half-width — the pane can be narrow.
        <Callout>
          <p className="text-sm text-fg mb-2">
            <span className="font-medium text-link">{state.challengeFrom.name}</span>
            {state.challengeFrom.handle && (
              <span className="text-fg-muted text-xs ml-1">@{state.challengeFrom.handle}</span>
            )}
            <span> wants to play!</span>
          </p>
          <div className="flex gap-2" data-parts-agree="challenge buttons">
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                connection.respondToChallenge(state.challengeFrom!.id, true);
                // Join the game you were actually challenged to (§3.1 item 3).
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

      {/* Challenge declined — the same notice box, Dismiss inside it. */}
      {state.challengeDeclinedBy && (
        <Callout actions={<Button variant="secondary" size="sm" onClick={() => dispatch({ type: 'CLEAR_CHALLENGE' })}>Dismiss</Button>}>
          <p className="text-xs text-fg-dim">
            <span className="text-fg-2">{state.challengeDeclinedBy.name}</span> declined your challenge.
          </p>
        </Callout>
      )}

      {/* Incognito: nobody can see or challenge you. The way back is a notice with
          its button inside (guide "Status and notices") — the incognito switch
          itself lives in the friends panel now. */}
      {incognito && onToggleIncognito && (
        <Callout actions={<Button variant="secondary" size="sm" onClick={onToggleIncognito}>Go online</Button>}>
          <p className="text-xs text-fg-2">You're incognito. Friends can't see you or challenge you.</p>
        </Callout>
      )}

      <section>
        <SectionLabel className="mb-2">Friends</SectionLabel>
        {f.merged.length > 0 ? (
          // Two arrangements on deck games-social-2 (Destin, GS-5: "we should rearrange
          // these tiles to match other app ui"). Both put your record at this game as a
          // sentence under the name (GC-3 picked "line": recordSentence, the end-of-game
          // card's own wording).
          look === 'settings' ? (
            // The Settings list: each friend its own boxed row, 8px apart (guide "Lists and
            // menus" → settings-style lists are boxed rows; SettingRow, as in Settings).
            <div className="flex flex-col gap-2">
              {f.merged.map((row) => {
                const rec = records.get(row.id);
                return (
                  <SettingRow
                    key={row.id}
                    variant="nav"
                    title={<>{row.name}{row.handle && <span className="text-fg-muted font-normal ml-1">@{row.handle}</span>}</>}
                    description={rec ? recordSentence(rec, row.name) : 'Not played yet'}
                    accessory={!incognito ? <PresencePill row={row} /> : undefined}
                    control={row.online ? <ChallengeButton onClick={() => connection.challengePlayer(row.id, gameId)} /> : undefined}
                  />
                );
              })}
            </div>
          ) : (
            // The sessions menu (SessionStrip's session rows): plain rows in one card,
            // the status pill right after the name, the detail line under it, the action
            // at the right edge (guide "Lists of short names are plain rows inside one
            // shared box").
            <ul className={`${CARD_LEVEL_1} p-1 flex flex-col gap-0.5`}>
              {f.merged.map((row) => {
                const rec = records.get(row.id);
                return (
                  <li key={row.id} className="flex items-center gap-2 px-2 py-1.5 min-h-11">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm text-fg truncate min-w-0">
                          {row.name}
                          {row.handle && <span className="text-fg-muted ml-1">@{row.handle}</span>}
                        </span>
                        {/* Unknown while incognito (presence is off) — no pill rather than a guessed "Offline". */}
                        {!incognito && <PresencePill row={row} />}
                      </div>
                      <div className="text-2xs text-fg-muted truncate">{rec ? recordSentence(rec, row.name) : 'Not played yet'}</div>
                    </div>
                    {row.online && <ChallengeButton onClick={() => connection.challengePlayer(row.id, gameId)} />}
                  </li>
                );
              })}
            </ul>
          )
        ) : f.loaded ? (
          // Guide "Empty states": first time → a card, a short explanation and one
          // full-width filled button. Adding friends happens on the Games list now,
          // so the button goes there (Destin: "no add friend in game panels").
          <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-3`}>
            <p className="text-sm text-fg">No friends yet. Add a friend on the Games list, then challenge them here.</p>
            <Button variant="primary" className="w-full" onClick={onAddFriend}>Add a friend</Button>
          </div>
        ) : (
          <LoadingState what="your friends" variant="inline" />
        )}
      </section>
    </div>
  );
}

/** Challenge only when the friend has a live presence entry. Outlined, not filled: it
 *  repeats on every online row, and a filled accent button per row reads as a list of
 *  alerts (change 47). */
function ChallengeButton({ onClick }: { onClick: () => void }) {
  return <Button variant="secondary" size="sm" onClick={onClick} className="shrink-0">Challenge</Button>;
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

export default function GameLobby({ connection, incognito, onToggleIncognito, gameId, onAddFriend }: Props) {
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
  return <LobbyScreen connection={connection} incognito={incognito} onToggleIncognito={onToggleIncognito} gameId={gameId} onAddFriend={onAddFriend} />;
}
