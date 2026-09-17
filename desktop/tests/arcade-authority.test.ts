// desktop/tests/arcade-authority.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { stripComments, readStripped, RENDERER } from './helpers/guard-scope';
import { GAMES, gameById } from '../src/renderer/components/game/game-registry';

// Source-text guards for the games arcade (spec §3, §5.5, §7). These read the
// tree at runtime, so `vitest related` can never reach them — hence the
// `*-authority` name, which verify.sh always runs.

const GAME_DIR = join(RENDERER, 'components', 'game');

function gameFiles(): string[] {
  const files = readdirSync(GAME_DIR)
    .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    .filter((f) => !f.endsWith('.test.tsx') && !f.endsWith('.test.ts'))
    .map((f) => join(GAME_DIR, f));
  // A guard that silently scans nothing is worse than no guard — it reads green
  // while proving nothing (see guard-scope.ts's own history).
  expect(files.length).toBeGreaterThanOrEqual(8);
  return files;
}

describe('the game slot (§3)', () => {
  it('every registered game satisfies the definition', () => {
    expect(GAMES.length).toBe(4);
    for (const g of GAMES) {
      expect(g.id, 'id').toMatch(/^[a-z0-9-]+$/);
      expect(g.name.length, `${g.id} name`).toBeGreaterThan(0);
      expect(g.blurb.length, `${g.id} blurb`).toBeGreaterThan(0);
      expect(typeof g.Tile, `${g.id} Tile`).toBe('function');
      expect(g.defaultPaneWidth, `${g.id} width`).toBeGreaterThanOrEqual(320);

      // The kind decides which half of the definition is required. Getting this
      // wrong is how a solo game ends up asking for a PartyKit party.
      if (g.kind === 'solo') {
        expect(g.scoring, `${g.id} needs scoring`).toBeTruthy();
        expect(g.party, `${g.id} must not name a party`).toBeUndefined();
      } else {
        expect(g.party, `${g.id} needs a party`).toBeTruthy();
        expect(g.scoring, `${g.id} must not carry scoring`).toBeUndefined();
      }
    }
  });

  it('ids are unique and resolvable', () => {
    expect(new Set(GAMES.map((g) => g.id)).size).toBe(GAMES.length);
    for (const g of GAMES) expect(gameById(g.id)).toBe(g);
    expect(gameById('nope')).toBeUndefined();
  });

  it("keeps Connect 4's wire id and party name distinct", () => {
    // The shipped wire value is 'connect-four' (usePartyGame.ts) while the
    // PartyKit party is spelled 'connectfour' (partykit.json). Collapsing these
    // into one field silently breaks every existing client.
    const c4 = gameById('connect-four')!;
    expect(c4.party).toBe('connectfour');
    expect(c4.party).not.toBe(c4.id);
  });

  it('leads with the games playable when nobody is online', () => {
    // §4.1: the picker must not open on two tiles that both say "no friends
    // online". Solo games therefore come first in registration order.
    expect(GAMES[0]!.kind).toBe('solo');
    expect(GAMES[1]!.kind).toBe('solo');
  });
});

describe('the state split (§3.1)', () => {
  // `state.play` is the open game's OWN state, opaque to the shell. Exactly one
  // file may narrow it: the game whose state it is. If a shell file starts
  // reaching in, the split has quietly collapsed back into the one shared pot
  // it took the largest piece of work in the project to get out of.
  const MAY_READ_PLAY = new Set(['ConnectFourBoard.tsx', 'ChessBoard.tsx']);

  it('only a game\'s own board narrows state.play', () => {
    const offenders = gameFiles()
      .filter((f) => /\bstate\.play\b/.test(readStripped(f)))
      // basename(), not split('/'): join() emits BACKSLASHES on Windows, so
      // splitting on '/' handed back the whole path and neither allowed file
      // ever matched MAY_READ_PLAY. The guard then failed on Windows CI naming
      // the two files it exists to permit — green on Linux, red on Windows,
      // and wrong in the direction that hides a real offender behind noise.
      .map((f) => basename(f))
      .filter((n) => !MAY_READ_PLAY.has(n));
    expect(offenders).toEqual([]);
  });

  it('Connect 4\'s vocabulary is gone from the shared state', () => {
    // `myColor`, `turn`, `winner`, `winLine` and `board` all lived on the shell
    // state and made chess and 2048 read Connect 4's language to render at all.
    const shared = readStripped(join(RENDERER, 'state', 'game-types.ts'))
      + readStripped(join(RENDERER, 'state', 'game-reducer.ts'));
    for (const gone of ['myColor', 'PlayerColor', 'winLine:', 'lastMove:']) {
      expect(shared, `${gone} is back on the shared state`).not.toContain(gone);
    }
    // And the replacements are actually there, so this cannot pass by the
    // whole file having been deleted.
    for (const want of ['seat', 'turnSeat', 'outcome', 'play']) {
      expect(shared).toContain(want);
    }
  });

  it('the challenge carries which game, end to end', () => {
    // The wire always sent `gameType`; the reducer dropped it, so Accept could
    // only ever open Connect 4. All four links must stay connected.
    expect(readStripped(join(RENDERER, 'hooks', 'usePresence.ts'))).toContain('gameType');
    expect(readStripped(join(RENDERER, 'state', 'game-reducer.ts'))).toContain('challengeGame');
    expect(readStripped(join(RENDERER, 'components', 'game', 'GameLobby.tsx'))).toContain('challengeGame');
    // And nobody hardcodes the game on the way out any more.
    expect(readStripped(join(RENDERER, 'hooks', 'usePartyGame.ts')))
      .not.toContain("lobbyChallenge(target, 'connect-four'");
  });
});

// The assistant-finishing rule (§7) — DECIDED BY DESTIN, 2026-08-30: when the
// assistant finishes, NOTHING happens beyond the existing ready chime and the
// header status light. No game pauses, no overlay, no focus change, no extra
// badge. Moved to ast-grep (Plan B, 2026-09-16): rules
// arcade-no-forbidden-attention-apis + its -ts twin ban the same five symbols
// (playSound, useAnyAttentionNeeded, onAttentionSummary, isThinking,
// sessionAttention) across every game file, scoped and ignored exactly as
// gameFiles() was.

describe('a focused game owns its keys', () => {
  // Found by building 2048: the chat scrolls the transcript on Up/Down from a
  // `window` capture listener that yields only for text fields. A game board is
  // not a text field, so the chat scrolled BEHIND the player while they played.
  // The game cannot win that race from its own side — the listener registers
  // first and capture runs outermost-first — so the yield lives in ChatView.
  it('ChatView yields arrow keys to a focused game board', () => {
    const chat = readStripped(join(RENDERER, 'components', 'ChatView.tsx'));
    expect(chat).toContain('[data-game-keys]');
  });

  it('a game that claims the arrow keys marks itself', () => {
    // The other half of the contract: the marker has to be ON something, or
    // ChatView's yield is dead code that reads as protection.
    const claimers = gameFiles().filter((f) => readStripped(f).includes('data-game-keys'));
    expect(claimers.length).toBeGreaterThanOrEqual(1);
  });
});

describe('theming (§5.5)', () => {
  // The app DOES sanction four Tailwind palette names — the status colours,
  // which are theme-independent by standing rule (desktop/CLAUDE.md). Rather
  // than hardcode them here (where they would drift the moment globals.css
  // changes), read them back out of the stylesheet that defines them.
  function sanctionedStatusColours(): Set<string> {
    const css = readFileSync(join(RENDERER, 'styles', 'globals.css'), 'utf8');
    const names = new Set<string>();
    for (const m of css.matchAll(/--color-([a-z]+-\d{2,3}):/g)) names.add(m[1]!);
    // If this ever reads empty the guard below would pass on anything.
    expect(names.size).toBeGreaterThanOrEqual(4);
    return names;
  }

  const PALETTE = /\b(?:bg|text|border|ring|from|to|via|fill|stroke)-((?:red|yellow|blue|green|orange|amber|purple|pink|indigo|teal|cyan|lime|violet|fuchsia|rose|sky|emerald)-\d{2,3})\b/g;

  it('no game file names an unsanctioned Tailwind palette colour', () => {
    // G-2: tokens paint everything. The retheme (§5.4) removed the hardcoded
    // red/yellow/blue discs, the blue board, the red disconnect box and the
    // amber "Reload app" link; this keeps them out.
    const allowed = sanctionedStatusColours();
    const offenders: string[] = [];
    for (const f of gameFiles()) {
      for (const m of stripComments(readStripped(f)).matchAll(PALETTE)) {
        if (!allowed.has(m[1]!)) offenders.push(`${basename(f)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the score boundary (§6.1)', () => {
  // Scores cross every boundary as raw NUMBERS. "31 pipes" and "12,480" are a
  // particular GAME's words and live in game-registry.ts. If main or the wire
  // ever learned them, adding a game would mean touching the main process, the
  // five IPC surfaces and the Worker — which is the coupling this whole design
  // exists to avoid.
  const MAIN = join(RENDERER, '..', 'main');
  const GAME_WORDS = [...GAMES.map((g) => g.id), 'pipes', 'toLocaleString'];

  it('no main-process file speaks a game\'s vocabulary', () => {
    const files = readdirSync(MAIN)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => join(MAIN, f));
    expect(files.length).toBeGreaterThanOrEqual(20);
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'));
      for (const w of GAME_WORDS) {
        if (src.includes(w)) offenders.push(`${basename(f)}: ${w}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the arcade handler formats nothing and decides no ranking', () => {
    const src = readStripped(join(MAIN, 'arcade-handlers.ts'));
    // Ranking is the Worker's, once, so every player sees one board; sorting
    // here would give each client its own opinion of who is winning.
    for (const banned of ['.sort(', 'rank', 'format(']) {
      expect(src.includes(banned), `arcade-handlers.ts must not ${banned}`).toBe(false);
    }
  });
});

// ── Stopping play is keyed on the OPEN GAME and nothing else ────────────────
//
// The bug: `setPlaying(false)` shared an effect with the one that applies a
// game's default pane width, so that effect's dep list included a function from
// the theme context. Committing a drag of the pane's edge changed that
// function's identity, re-ran the effect, and ended the run — the player was 40
// pipes into Flappy, dragged the pane wider, let go, and the game vanished with
// the run uncounted.
//
// This is a fact about how the effect is WRITTEN, not about what it computes,
// so no amount of rendering can pin it — hence a source-text guard. The
// root-cause half (the callback's identity is now stable) is pinned by
// tests/game-pane-width.test.tsx.
describe('a resize cannot end a run (§4.3)', () => {
  const shell = () => readStripped(join(GAME_DIR, 'ArcadeShell.tsx'));

  it('setPlaying(false) lives in an effect that depends on openGame alone', () => {
    const src = shell();
    // Every `useEffect(..., [deps])` whose body stops play, with its dep list.
    const effects = [...src.matchAll(/useEffect\(\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\[([^\]]*)\]\s*\)/g)];
    expect(effects.length, 'no effects found — the regex has drifted').toBeGreaterThan(1);

    const stoppers = effects.filter(([, body]) => /setPlaying\(\s*false\s*\)/.test(body));
    expect(stoppers.length, 'exactly one effect may stop play').toBe(1);

    const deps = stoppers[0][2].split(',').map((d) => d.trim()).filter(Boolean);
    expect(deps).toEqual(['openGame']);
  });

  it('the width helper is not in that effect', () => {
    // Stated separately from the dep-list equality above so a regression names
    // the actual culprit rather than just "deps changed".
    const src = shell();
    const stopper = /useEffect\(\s*\(\)\s*=>\s*\{[^}]*setPlaying\(\s*false\s*\)[^}]*\}\s*,\s*\[([^\]]*)\]\s*\)/.exec(src);
    expect(stopper, 'the stop-playing effect moved — re-point this guard').toBeTruthy();
    expect(stopper![1]).not.toContain('applyGameDefaultWidth');
  });
});
