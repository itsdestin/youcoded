// game.ts — game favourites, presence incognito and the arcade's scores (favorites:*, game:*, arcade:*), one body for
// both doors.
//
// WHY (2026-10-01 one-core R3-8): favorites/incognito were four ipcMain handlers in main.ts plus four phone `case`s that
// called the same prefs-service functions; the arcade was four handlers in arcade-handlers.ts plus one grouped phone
// `case`. Both already ran the same functions, so the move changes nothing a person sees. The one wire difference: the
// computer sends the bare list / flag (`favorites:set`, `game:setIncognito`) while a phone wraps the list as
// `{ favorites }`; the entry reads both, exactly as the phone's case did.
import { IPC } from '../../shared/backend-contract';
import { getFavorites, setFavorites, getIncognito, setIncognito } from '../prefs-service';
import { getArcadeOps } from '../arcade-handlers';
import { defineChannel, type MainChannelDef } from './channel-def';

/** The arcade's operations are built when main registers the games (a minimal boot or a test has none). General and
 *  non-committal: we do not guess a cause we have not verified. */
const UNAVAILABLE = { ok: false as const, status: 0, message: 'Game scores are unavailable on this host.' };

export const gameChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.FAVORITES_GET, kind: 'handle', handler: () => getFavorites() }),
  defineChannel({
    name: IPC.FAVORITES_SET, kind: 'handle',
    // A phone wraps the list as { favorites }; a window sends the bare list.
    handler: (payload) => setFavorites((payload as { favorites?: unknown[] })?.favorites ?? payload),
  }),
  defineChannel({ name: IPC.GAME_GET_INCOGNITO, kind: 'handle', handler: () => getIncognito() }),
  defineChannel({ name: IPC.GAME_SET_INCOGNITO, kind: 'handle', handler: (incognito) => setIncognito(incognito) }),

  // The SAME operations on both doors, including the shared stale-board cache: a remote browser must never see a
  // different leaderboard from the desktop window beside it.
  defineChannel({ name: IPC.ARCADE_STATUS, kind: 'handle', handler: () => getArcadeOps()?.status() ?? UNAVAILABLE }),
  defineChannel({ name: IPC.ARCADE_LEADERBOARD, kind: 'handle', handler: (p) => getArcadeOps()?.leaderboard(p?.game) ?? UNAVAILABLE }),
  defineChannel({ name: IPC.ARCADE_SUBMIT_SCORE, kind: 'handle', handler: (p) => getArcadeOps()?.submitScore(p?.game, p?.score) ?? UNAVAILABLE }),
  // An absent game means EVERY game: passing undefined through is the whole filter, so it is not coerced to '' (that
  // would ask the Worker for the game literally named "", i.e. always nothing).
  defineChannel({ name: IPC.ARCADE_RECORDS, kind: 'handle', handler: (p) => getArcadeOps()?.records(p?.game ?? undefined) ?? UNAVAILABLE }),
];
