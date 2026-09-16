// The arcade shell (spec §4) — what the games pane shows around a game.
//
// Its whole job is routing plus the states nobody plans for: the picker, one
// game's screen, the back path, and the degraded/empty cases (§6.5, §6.6).
// It owns NO game rules and imports no game logic — the four games reach it
// only through `game-registry.ts`, which is the point of the slot (§3).
//
// The arcade's DATA is not here — `arcade-api.ts` owns the pure mapping from
// what the server said to what a screen renders, so those states can be tested
// without mounting anything. This file only decides which screen is showing.

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useGameState, useGameDispatch } from '../../state/game-context';
import { useAccount } from '../../state/account-context';
import { useTheme } from '../../state/theme-context';
import { GameConnection } from '../../state/game-types';
import { GAMES, type GameDefinition } from './game-registry';
import { readAllBests, recordRun } from './local-best';
import { useMatchReport } from '../../hooks/useMatchReport';
import ArcadePicker from './ArcadePicker';
import Leaderboard, { type LeaderboardRow } from './Leaderboard';
import { arcadeApi, buildStatuses, mergeBests, serverBests, staleNote, toRows } from './arcade-api';
import ChessBoard, { type PieceTreatment } from './ChessBoard';
import GameLobby from './GameLobby';
import ConnectFourBoard from './ConnectFourBoard';
import GameChat from './GameChat';
import GameOverlay from './GameOverlay';
import { Button, LoadingState } from '../ui';

interface Props {
  connection: GameConnection;
  /** Chess brings its OWN PartyKit client and its own room (§3.1) — it reaches
   *  the shell through the same GameConnection interface, so this file is the
   *  only place that has to know there is more than one. */
  chessConnection: GameConnection;
  incognito?: boolean;
  onToggleIncognito?: () => void;
}

/** The arcade's server data: your bests across every solo game, and one game's
 *  friends board. Both come back through `window.claude.arcade`, which main
 *  serves from the account-gated Worker endpoints.
 *
 *  NOTHING HERE CAN FAIL LOUDLY. Signed out, offline, or on a surface with no
 *  arcade bridge at all, every path resolves to "we have nothing to add to what
 *  this computer already knows" — an empty result, never an error screen. That
 *  is §4.2 taken literally: the leaderboard being down must never look like the
 *  game being down. */
function useArcadeData(game: GameDefinition | null, signedIn: boolean) {
  /** Server bests keyed by game id. `null` while we have not answered yet,
   *  which is a DIFFERENT screen from "you have never played". */
  const [server, setServer] = useState<Record<string, number> | null>(null);
  const [board, setBoard] = useState<{ rows: LeaderboardRow[]; staleNote?: string } | null>(null);

  // Re-runs on sign-in: without `signedIn` in the deps, signing in would not
  // pull down the bests you set on another device until the app restarted.
  useEffect(() => {
    let live = true;
    const api = arcadeApi();
    if (!api) { setServer({}); return; }
    void api.status()
      .then((r) => { if (live) setServer(r.ok ? serverBests(r.value) : {}); })
      .catch(() => { if (live) setServer({}); });
    return () => { live = false; };
  }, [signedIn]);

  useEffect(() => {
    if (!game || game.kind !== 'solo') { setBoard(null); return; }
    let live = true;
    const api = arcadeApi();
    if (!api) { setBoard({ rows: [] }); return; }
    setBoard(null);
    void api.leaderboard(game.id)
      .then((r) => {
        if (!live) return;
        // A remembered board arrives labelled with WHEN, never why (§6.6).
        setBoard(r.ok
          ? { rows: toRows(r.value.board, game), staleNote: staleNote(r.value.cachedAt) }
          : { rows: [] });
      })
      .catch(() => { if (live) setBoard({ rows: [] }); });
    return () => { live = false; };
  }, [game, signedIn]);

  return { server, board };
}

export default function ArcadeShell({ connection, chessConnection, incognito, onToggleIncognito }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const { signedIn, startSignIn } = useAccount();
  const [openGame, setOpenGame] = useState<GameDefinition | null>(null);
  /** True while a solo run is actually on screen. Opening a game shows its
   *  board first — you land on "here is where you stand", not mid-run. */
  const [playing, setPlaying] = useState(false);
  /** Your own bests, read from this computer on mount (§4.2). These are what
   *  every screen shows when there is no server board — which is currently
   *  ALWAYS outside the workbench, and is also the signed-out and offline case. */
  const [localBest, setLocalBest] = useState<Record<string, number>>(
    () => readAllBests(GAMES.map((g) => g.id)),
  );
  const { applyGameDefaultWidth } = useTheme();

  const { server, board } = useArcadeData(openGame?.kind === 'solo' ? openGame : null, !!signedIn);

  /** ONE best per game for every screen in this file — the picker tile, the
   *  leaderboard's "your best" line, and the number the game itself shows while
   *  you play. They used to read from different places, which is how a run you
   *  had just finished could appear on one screen and not the next. */
  const bests = useMemo(() => mergeBests(server ?? {}, localBest), [server, localBest]);
  const bestOf = (id: string) => bests[id];

  const endRun = (score: number) => {
    // DELIBERATELY DOES NOT STOP PLAYING. The first version did, and it yanked
    // the game out from under its own end-of-run screen the instant the bird
    // hit a pipe — the player was thrown back to the leaderboard and never saw
    // their score. A run ending is the GAME's moment: it shows the result and
    // offers Play again. Leaving is the player's choice, through `onExit`.
    if (!openGame) return;
    // Written to disk, not just to state: closing the panel used to forget it.
    const best = recordRun(openGame.id, score);
    setLocalBest((b) => ({ ...b, [openGame.id]: best }));
    // Signed out, or the board unreachable, the run still counted locally —
    // §4.2/§6.6: the leaderboard being down never costs you the game. Nothing
    // downstream of this awaits it, and a rejection is swallowed on purpose:
    // the end-of-run screen is already on the player's screen by now.
    void arcadeApi()?.submitScore?.(openGame.id, score)
      .then((r) => {
        // The server may hold a HIGHER best than this computer — you played on
        // your phone. Take it now rather than waiting for the next app start.
        if (!r.ok || typeof r.value.best !== 'number') return;
        const fromServer = r.value.best;
        setLocalBest((b) => {
          const mine = b[openGame.id];
          return mine !== undefined && mine >= fromServer ? b : { ...b, [openGame.id]: fromServer };
        });
      })
      .catch(() => { /* publishing a score is best-effort by design */ });
  };

  // §4.3: a game opens at ITS default width the first time — chess wants 520px
  // where the picker wants 420. This is a no-op once the user has dragged the
  // pane even once, because their width then wins permanently; the "have they
  // resized?" fact is the presence of the stored key, not a value comparison,
  // so dragging to exactly the default still counts as a choice.
  useEffect(() => {
    if (openGame) applyGameDefaultWidth(openGame.defaultPaneWidth);
  }, [openGame, applyGameDefaultWidth]);

  // Leaving a game must end its run, or coming back drops you into a board that
  // has been sitting frozen since you left.
  //
  // ITS OWN EFFECT, KEYED ON openGame ALONE. This used to share the effect
  // above, which also depends on a function from the theme context — so
  // anything that changed that function's identity ended a run in progress.
  // Finishing a drag of the pane's edge did exactly that: the player was 40
  // pipes into Flappy, let go of the mouse, and the game vanished with the run
  // uncounted. Changing games is the ONLY thing that should stop play.
  useEffect(() => {
    setPlaying(false);
  }, [openGame]);

  // A challenge arriving while the picker is open must land on the game it is
  // FOR — otherwise Accept drops the player into the wrong board. Until the
  // reducer carries the game (§3.1 item 3), Connect 4 is the only thing that
  // can be challenged, so route there and leave a marker for Step 2.
  // A challenge arriving while the picker is open lands on the game it is FOR.
  // The reducer now keeps `challengeGame` (§3.1 item 3), so this is the real
  // game rather than the Connect 4 it used to always assume.
  useEffect(() => {
    if (state.challengeFrom && !openGame) {
      const g = GAMES.find((x) => x.id === state.challengeGame);
      setOpenGame(g ?? GAMES.find((x) => x.id === 'connect-four') ?? null);
    }
  }, [state.challengeFrom, state.challengeGame, openGame]);

  const inPlay = state.screen === 'playing' || state.screen === 'game-over';

  // A finished versus match reports itself, once (§6.2). Sited here because
  // this is where the shell knows WHICH game just ended; the hook does nothing
  // at all for a solo game, which has no opponent to have a record with.
  useMatchReport(state, openGame?.kind === 'versus' ? openGame.id : null);

  // Which client is live. Leaving has to reach the RIGHT room — calling Connect
  // 4's leaveGame while a chess game is open would leave the player seated at a
  // board nobody is watching.
  const activeConnection = openGame?.id === 'chess' ? chessConnection : connection;

  /** The picker's per-tile facts. `null` only while the first server answer is
   *  outstanding — after that a tile always has something true to say.
   *
   *  Who is online comes from the LIVE lobby presence in the reducer, not from
   *  an HTTP call: it is a socket fact, and an endpoint's answer would be stale
   *  within seconds. You are filtered out of your own list — "You are online"
   *  is not a reason to start a game. */
  const statuses = useMemo(() => {
    if (server === null) return null;
    return buildStatuses({
      bests,
      onlineNames: state.onlineUsers
        .filter((u) => u.name !== state.username)
        .map((u) => u.name),
      // Only a REPORTED failure marks versus unavailable. Using "not connected
      // yet" would flash "Can't reach the game server" on every launch during
      // the second before the lobby socket opens.
      versusUnavailable: state.partyError ? "Can't reach the game server" : undefined,
    });
  }, [server, bests, state.onlineUsers, state.username, state.partyError]);

  const leave = () => {
    if (state.screen !== 'lobby' && state.screen !== 'setup') {
      activeConnection.leaveGame();
      dispatch({ type: 'RETURN_TO_LOBBY' });
    }
    setOpenGame(null);
    setPlaying(false);
  };

  return (
    // Fills GamePanel's root, which owns the pane surface and (since §4.3) the
    // resize handle. This layer is routing + chrome only.
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <ArcadeHeader
        title={openGame?.name ?? 'Games'}
        // Back only exists once you are inside a game. On the picker the only
        // control is close — a back arrow that goes nowhere is a dead affordance.
        onBack={openGame ? leave : undefined}
        onClose={() => { if (openGame) leave(); dispatch({ type: 'TOGGLE_PANEL' }); }}
      />

      {/* `overflow-y-auto` for the list-shaped screens (picker, leaderboard);
          `overflow-hidden` while a game is open, so the board keeps its size
          and the chat below it can fill the remaining height instead of
          growing into an unbounded scroll container. */}
      {/* a size container: the chess board reads `cqh` off it to stay inside a short pane (ChessBoard.tsx) */}
      <div className={`flex-1 min-h-0 flex flex-col ${openGame?.kind === 'versus' ? 'overflow-hidden' : 'overflow-y-auto'}`} style={{ containerType: 'size' }}>
        {!openGame && (
          statuses === null
            ? <LoadingState what="games" />
            : (
              <ArcadePicker
                statuses={statuses}
                onPick={setOpenGame}
                signedIn={!!signedIn}
                onSignIn={() => { void startSignIn(); }}
              />
            )
        )}

        {openGame?.kind === 'solo' && (
          <div className="flex flex-col flex-1 min-h-0">
            {playing && openGame.Play ? (
              // The playfield takes the whole pane while a run is on. Suspense
              // is required because the game is lazily imported — without it
              // React throws on first open rather than showing anything.
              <Suspense fallback={<LoadingState what={openGame.name} />}>
                <openGame.Play
                  onEnd={endRun}
                  best={bestOf(openGame.id)}
                  onExit={() => setPlaying(false)}
                />
              </Suspense>
            ) : (
              <>
            {/* G-4: one primary per view — Play is it. */}
            <div className="px-3 pt-3">
              <Button
                variant="primary"
                size="md"
                className="w-full"
                disabled={!openGame.Play}
                onClick={() => setPlaying(true)}
              >
                Play
              </Button>
              <p className="text-2xs text-fg-muted leading-relaxed pt-2">{openGame.blurb}</p>
            </div>
            {board === null
              ? <LoadingState what="the board" />
              : (
                <Leaderboard
                  game={openGame}
                  rows={board.rows}
                  staleNote={board.staleNote}
                  // Your own best, whenever the ranked board has no row for you
                  // — signed out, offline, or (today) no backend at all. Without
                  // this the screen showed a column heading and nothing under it.
                  unpublishedBest={
                    board.rows.some((r) => r.isYou)
                      ? undefined
                      : bests[openGame.id] !== undefined
                        ? openGame.scoring?.format(bests[openGame.id]!)
                        : null
                  }
                  onSignIn={signedIn ? undefined : () => { void startSignIn(); }}
                />
              )}
              </>
            )}
          </div>
        )}

        {openGame?.id === 'chess' && (
          inPlay ? (
            <div className="relative flex flex-col flex-1 min-h-0">
              <ChessBoard connection={chessConnection} treatment={chessTreatment()} />
              <GameChat connection={chessConnection} />
              {state.screen === 'game-over' && <GameOverlay connection={chessConnection} />}
            </div>
          ) : (
            <GameLobby
              connection={chessConnection}
              incognito={incognito}
              onToggleIncognito={onToggleIncognito}
              gameId={openGame.id}
            />
          )
        )}

        {openGame?.id === 'connect-four' && (
          inPlay ? (
            <div className="relative flex flex-col flex-1 min-h-0">
              <ConnectFourBoard connection={connection} />
              <GameChat connection={connection} />
              {state.screen === 'game-over' && <GameOverlay connection={connection} />}
            </div>
          ) : (
            <GameLobby connection={connection} incognito={incognito} onToggleIncognito={onToggleIncognito} gameId={openGame.id} />
          )
        )}
      </div>
    </div>
  );
}

/** SETTLED: 'outline' (deck step G-8). `?chess=disc|fill` still renders the two
 *  rejected treatments so a future review can re-open the question against the
 *  same position — it is a workbench switch, never a user setting. */
function chessTreatment(): PieceTreatment {
  if (typeof location === 'undefined') return 'outline';
  const v = new URLSearchParams(location.search).get('chess');
  return v === 'disc' || v === 'fill' ? v : 'outline';
}


function ArcadeHeader({ title, onBack, onClose }: { title: string; onBack?: () => void; onClose: () => void }) {
  return (
    <div className="flex items-center gap-1 px-2 py-2 border-b border-edge shrink-0">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to games"
          className="w-7 h-7 flex items-center justify-center rounded-md text-fg-muted hover:text-fg-2 hover:bg-inset transition-colors"
        >
          {/* Chevron, not a glyph character — a text arrow inherits the theme
              font and lands at a different size in every community pack. */}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <span className={`text-sm font-semibold text-fg flex-1 min-w-0 truncate ${onBack ? '' : 'pl-1'}`}>{title}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close games"
        className="w-7 h-7 flex items-center justify-center rounded-md text-fg-muted hover:text-fg-2 hover:bg-inset transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
