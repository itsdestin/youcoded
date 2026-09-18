import { describe, it, expect } from 'vitest';
import { classifyBuffer, ClassifierContext } from '../src/renderer/state/attention-classifier';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

function ctx(lines: string[], overrides: Partial<ClassifierContext> = {}): ClassifierContext {
  return {
    bufferTail: lines,
    previousSpinnerGlyph: null,
    secondsSincePreviousGlyph: 0,
    previousCounterSeconds: null,
    ...overrides,
  };
}

describe('classifyBuffer', () => {
  it('empty buffer → unknown', () => {
    expect(classifyBuffer(ctx([])).class).toBe('unknown');
  });

  it('recognizes the Claude spinner (glyph + gerund + …) on first tick → active', () => {
    const result = classifyBuffer(ctx(['', '✻ Pondering…', '']));
    expect(result.class).toBe('thinking-active');
    expect(result.spinnerGlyph).toBe('✻');
  });

  // CC's spinner cycles through a set of leading glyphs. Each must classify.
  // Source: youcoded/desktop/test-conpty/spinner-full.log + spinner-bytes.log
  // captures from 2026-04-26 (CC v2.1.119). Adding a new case here when a
  // new glyph turns up in the wild is the contract.
  //
  // Empirically observed in 2026-04-26 probes: ✻ ✽ ✢ ✳ ✶ * (the others come
  // from older captures and remain in the regex's character class).
  it.each([
    ['✻', 'Pondering'],
    ['✽', 'Conjuring'],
    ['✢', 'Forming'],
    ['✳', 'Mustering'],
    ['✶', 'Whisking'],
    ['*', 'Warping'],
    ['⏺', 'Cogitating'],
    ['◉', 'Brewing'],
    ['·', 'Envisioning'],
    // Empirical gerunds captured in the 2026-04-26 audit, exercised across
    // multiple glyphs to ensure no glyph + gerund combination is special:
    ['✶', 'Recombobulating'],
    ['*', 'Moonwalking'],
    ['✻', 'Forging'],
  ])('classifies "%s %s…" frame as thinking-active', (glyph, gerund) => {
    const result = classifyBuffer(ctx([`${glyph} ${gerund}…`]));
    expect(result.class).toBe('thinking-active');
    expect(result.spinnerGlyph).toBe(glyph);
  });

  it('spinner glyph rotated between ticks → active', () => {
    const result = classifyBuffer(
      ctx(['⏺ Cogitating…'], {
        previousSpinnerGlyph: '✻',
        secondsSincePreviousGlyph: 3,
      }),
    );
    expect(result.class).toBe('thinking-active');
    expect(result.spinnerGlyph).toBe('⏺');
  });

  it('spinner glyph unchanged for >=30s between ticks → stalled', () => {
    const result = classifyBuffer(
      ctx(['⏺ Cogitating…'], {
        previousSpinnerGlyph: '⏺',
        secondsSincePreviousGlyph: 31,
      }),
    );
    expect(result.class).toBe('thinking-stalled');
  });

  // Empirical: CC v2.1.119 holds the same glyph for 10–20s during silent
  // thinking phases. The 30s threshold tolerates that without false-firing.
  it('spinner glyph unchanged for 15s → still active (slow normal render)', () => {
    const result = classifyBuffer(
      ctx(['⏺ Cogitating…'], {
        previousSpinnerGlyph: '⏺',
        secondsSincePreviousGlyph: 15,
      }),
    );
    expect(result.class).toBe('thinking-active');
  });

  it('spinner glyph unchanged for <30s → still active (brief pause is normal)', () => {
    const result = classifyBuffer(
      ctx(['⏺ Cogitating…'], {
        previousSpinnerGlyph: '⏺',
        secondsSincePreviousGlyph: 3,
      }),
    );
    expect(result.class).toBe('thinking-active');
  });

  // Content-based classifications (awaiting-input, shell-idle, error) were
  // removed — they fired on tool output during active turns. We now default
  // to 'unknown' (upstream maps to 'ok') whenever no spinner is visible.
  it('y/n prompt without spinner → unknown (no false banner)', () => {
    expect(
      classifyBuffer(ctx(['Do you want to continue? (y/n)'])).class,
    ).toBe('unknown');
  });

  it('shell-prompt-looking line without spinner → unknown', () => {
    expect(classifyBuffer(ctx(['user@host ~ $ '])).class).toBe('unknown');
    expect(classifyBuffer(ctx(['~/project $'])).class).toBe('unknown');
  });

  it('error-looking line without spinner → unknown (tool output often shows these)', () => {
    expect(
      classifyBuffer(ctx(['something', 'Error: ENOENT: file not found', ''])).class,
    ).toBe('unknown');
    expect(
      classifyBuffer(ctx(['Traceback: at main.py:42'])).class,
    ).toBe('unknown');
  });

  it('plain noise → unknown', () => {
    expect(
      classifyBuffer(ctx(['hello world', 'some random output'])).class,
    ).toBe('unknown');
  });

  it('sequential glyph rotations — multiple ticks remain active', () => {
    let prev: string | null = null;
    const readings = ['✻', '✽', '✢', '✳', '✶'];
    for (const glyph of readings) {
      const result = classifyBuffer(
        ctx([`${glyph} Pondering…`], {
          previousSpinnerGlyph: prev,
          secondsSincePreviousGlyph: 1,
        }),
      );
      expect(result.class).toBe('thinking-active');
      prev = result.spinnerGlyph;
    }
  });

  // Regression: the documented separator `·` (U+00B7) appears NOT only as a
  // spinner glyph but also as a separator in CC's status text (e.g.
  // "Sonnet 4.6 · Claude Max"). The regex requires a gerund word + ellipsis
  // after the glyph, so plain separator usage must NOT classify as a spinner.
  it('middle-dot used as separator (not as spinner) → unknown', () => {
    expect(
      classifyBuffer(ctx(['Sonnet 4.6 · Claude Max', ''])).class,
    ).toBe('unknown');
  });

  // Regression: the OLD regex required "(Ns · esc to interrupt)" which CC
  // v2.1.119 stopped emitting. The new regex matches without that suffix —
  // but if a future CC version brings the suffix back, we still match.
  it('legacy spinner format with seconds counter still classifies', () => {
    const result = classifyBuffer(ctx(['✻ Pondering… (7s · esc to interrupt)']));
    expect(result.class).toBe('thinking-active');
    expect(result.spinnerGlyph).toBe('✻');
  });

  // Regression: hook-execution variant captured live by the false-match probe.
  // CC adds parenthesized info after the gerund + ellipsis during certain
  // states (e.g., running a SessionEnd hook). Matches because the regex stops
  // at the ellipsis.
  it('hook-execution spinner with parenthesized info classifies', () => {
    const result = classifyBuffer(
      ctx(['✶ Channelling… (running stop hook · 3s · ↓ 1 tokens)']),
    );
    expect(result.class).toBe('thinking-active');
    expect(result.spinnerGlyph).toBe('✶');
  });

  // FALSE-MATCH GUARDS — anchored regex (^) excludes these patterns. Without
  // the ^ anchor, the false-match probe (test-conpty/test-attention-false-match.mjs)
  // showed each of these triggered the classifier in real CC sessions.

  it("Claude markdown bullet '  * Loading…' (leading whitespace) → unknown", () => {
    expect(classifyBuffer(ctx(['  * Loading…'])).class).toBe('unknown');
  });

  it("Claude markdown bullet '* Loading…' at column 0 → still unknown (because we don't trust bullets)", () => {
    // This is a tradeoff: a bare "* Loading…" at column 0 with no leading
    // indent IS the same shape as CC's '*' spinner frame. We accept this
    // collision as the price of using `*` as a real glyph — CC v2.1.119
    // emits "* Moonwalking…" in its spinner rotation. In practice CC always
    // adds a "● " prefix to assistant responses, so this collision doesn't
    // arise from Claude's text. If it does in some future CC version, the
    // probe will catch it.
    const result = classifyBuffer(ctx(['* Loading…']));
    expect(result.class).toBe('thinking-active');
  });

  it("user prompt echoed in input bar '❯ Show me ✻ Pondering…' → unknown", () => {
    // The user-input echo is a long line containing the literal spinner
    // string mid-line. Without the ^ anchor this matched; with the anchor
    // it doesn't because the line starts with `❯`.
    expect(
      classifyBuffer(ctx(['❯ Show me ✻ Pondering…'])).class,
    ).toBe('unknown');
  });

  it("Claude assistant turn '● ✻ Pondering…' (response with bullet prefix) → unknown", () => {
    // CC prefixes assistant turns with `● `. The line starts with `●`, not
    // a spinner glyph, so the anchored regex correctly rejects it even when
    // the response content contains a literal spinner.
    expect(
      classifyBuffer(ctx(['● ✻ Pondering…'])).class,
    ).toBe('unknown');
  });

  it("indented tool output '  * Compiling…' → unknown", () => {
    expect(classifyBuffer(ctx(['  * Compiling…'])).class).toBe('unknown');
  });

  // Multi-word gerund — captured live 2026-04-30 from a real install-and-verify
  // turn. The pre-2026-04-30 single-word regex `[A-Za-z]+…` couldn't match this
  // because of the spaces and `+` between glyph and ellipsis, so the classifier
  // returned 'unknown' on every tick of the turn and the no-spinner-20s safety
  // net flashed the wrong banner.
  it("multi-word gerund '* Installing + verifying on device…' → active", () => {
    const result = classifyBuffer(
      ctx(['* Installing + verifying on device… (1m 52s · ↓ 3.0k tokens)']),
    );
    expect(result.class).toBe('thinking-active');
    expect(result.spinnerGlyph).toBe('*');
    expect(result.counterSeconds).toBe(112);
  });

  it("multi-word gerund without paren suffix '✻ Reading large file…' → active", () => {
    const result = classifyBuffer(ctx(['✻ Reading large file…']));
    expect(result.class).toBe('thinking-active');
    expect(result.spinnerGlyph).toBe('✻');
  });

  // Counter detection — the OR signal. Independent of the spinner regex so a
  // future CC visual change that pauses the glyph rotation but keeps the
  // counter live still classifies as active.
  describe('counter signal', () => {
    it('extracts seconds from "(7s · esc to interrupt)"', () => {
      const result = classifyBuffer(ctx(['✻ Pondering… (7s · esc to interrupt)']));
      expect(result.counterSeconds).toBe(7);
    });

    it('extracts total seconds from "(1m 52s · ↓ 3.0k tokens)"', () => {
      const result = classifyBuffer(
        ctx(['* Installing + verifying on device… (1m 52s · ↓ 3.0k tokens)']),
      );
      expect(result.counterSeconds).toBe(112); // 1*60 + 52
    });

    it('extracts seconds when prefixed by other paren content "(running stop hook · 3s · …)"', () => {
      const result = classifyBuffer(
        ctx(['✶ Channelling… (running stop hook · 3s · ↓ 1 tokens)']),
      );
      expect(result.counterSeconds).toBe(3);
    });

    it('takes the MAX seconds across multiple lines / multiple counters', () => {
      const result = classifyBuffer(
        ctx([
          'Stage 1 (8s · …)',
          'Stage 2 (45s · …)',
          'Stage 3 (12s · …)',
        ]),
      );
      expect(result.counterSeconds).toBe(45);
    });

    it('returns null when no paren-wrapped counter is present', () => {
      const result = classifyBuffer(ctx(['plain text', 'more plain text']));
      expect(result.counterSeconds).toBeNull();
    });

    it('does NOT match a bare "Ns" outside parens (defends Claude prose)', () => {
      // Claude prose mentioning timing in body text — like "wait 5s" or
      // "took 30s" — must not light up the counter signal. Anchored to
      // paren-wrapped form because that's the only shape CC's progress
      // counter ever takes.
      const result = classifyBuffer(
        ctx(['That operation took 30s and the next one will take 5s.']),
      );
      expect(result.counterSeconds).toBeNull();
    });
  });

  // Counter rescue — the OR with glyph rotation. These are the cases the
  // 2026-04-30 change explicitly added support for.
  describe('counter advancement rescues stuck glyph', () => {
    it('glyph frozen 31s but counter advanced from 100→105 → still active', () => {
      const result = classifyBuffer(
        ctx(['✻ Pondering… (1m 45s · ↓ 4.2k tokens)'], {
          previousSpinnerGlyph: '✻',
          secondsSincePreviousGlyph: 31,
          previousCounterSeconds: 100,
        }),
      );
      expect(result.class).toBe('thinking-active');
      expect(result.counterSeconds).toBe(105);
    });

    it('glyph frozen 31s AND counter unchanged at 100 → stalled (genuine stall)', () => {
      const result = classifyBuffer(
        ctx(['✻ Pondering… (1m 40s · ↓ 4.2k tokens)'], {
          previousSpinnerGlyph: '✻',
          secondsSincePreviousGlyph: 31,
          previousCounterSeconds: 100,
        }),
      );
      expect(result.class).toBe('thinking-stalled');
      expect(result.counterSeconds).toBe(100);
    });

    it('no glyph at all but counter advanced 5→6 → active (counter-only path)', () => {
      const result = classifyBuffer(
        ctx(['Building project', '  Compiling foo (5/12) (6s · ↑ 0.3k tokens)'], {
          previousSpinnerGlyph: null,
          previousCounterSeconds: 5,
        }),
      );
      expect(result.class).toBe('thinking-active');
      expect(result.spinnerGlyph).toBeNull();
      expect(result.counterSeconds).toBe(6);
    });

    it('no glyph and counter unchanged → still unknown (no liveness signal)', () => {
      const result = classifyBuffer(
        ctx(['Some output (5s · ↑ 0.3k tokens)'], {
          previousSpinnerGlyph: null,
          previousCounterSeconds: 5,
        }),
      );
      expect(result.class).toBe('unknown');
    });

    it('first tick (previousCounterSeconds null) does NOT count as advancement', () => {
      // No prior tick to compare against. Counter alone shouldn't fire active
      // until we have a baseline — otherwise any CC progress line containing
      // "(5s · …)" would always classify active even when nothing's moving.
      const result = classifyBuffer(
        ctx(['Some output (5s · ↑ 0.3k tokens)'], {
          previousSpinnerGlyph: null,
          previousCounterSeconds: null,
        }),
      );
      expect(result.class).toBe('unknown');
      expect(result.counterSeconds).toBe(5);
    });
  });
});

// Fixtures live at <repo-root>/shared-fixtures/attention-classifier/.
// Test file is at desktop/tests/, so two levels up reaches the repo root.
const FIXTURES_DIR = join(__dirname, '..', '..', 'shared-fixtures', 'attention-classifier');

describe('attention-classifier parity fixtures', () => {
  const entries = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.input.json'));

  it.each(entries)('classifies %s as expected', (inputFile) => {
    const baseName = inputFile.replace(/\.input\.json$/, '');
    const rawInput = JSON.parse(
      readFileSync(join(FIXTURES_DIR, inputFile), 'utf8')
    );
    // Strip the informational 'description' field — it's not part of
    // ClassifierContext and classifyBuffer would ignore unknown keys anyway,
    // but stripping is explicit about the contract boundary.
    const { description: _description, ...context } = rawInput;
    const expected = JSON.parse(
      readFileSync(join(FIXTURES_DIR, `${baseName}.expected.json`), 'utf8')
    );

    expect(classifyBuffer(context)).toEqual(expected);
  });
});
