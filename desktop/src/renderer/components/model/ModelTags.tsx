// desktop/src/renderer/components/model/ModelTags.tsx
//
// The tags on a model-list row: value (or how the model is paid for),
// intelligence, and — for models on this computer — speed.
//
// WHY (Destin, 2026-09-06, "the cost/intelligence tags i want to eventually build
// in the model selector"; decided on the questions decks of 2026-09-11 in
// docs/active/design/2026-09-11-model-picker-tags/): choosing a model meant
// knowing the names. Every rule for WHAT a tag says lives in `tagsFor`, a plain
// function, so the words can be tested without drawing anything; the component
// only draws them.
import React, { createContext, useContext } from 'react';
import { Tooltip } from '../ui/Tooltip';
import {
  VALUE_BAND, intelligenceBand, speedBand,
  type Band, type ModelFacts, type ModelFactsSnapshot,
} from '../../../shared/model-facts';

/** The three round-1 layouts under review. A context rather than a prop, so none
 *  of the eleven places the list opens from changes while a design is chosen —
 *  the same shape as the voice button's VoiceStyleContext. Once one wins, the
 *  losers and this context are deleted.
 *    'tinted'  — words on a second line, each on a softly coloured chip
 *    'dot'     — words on a second line, each behind a coloured dot
 *    'compact' — short forms on the SAME line as the name, at the right */
export type ModelTagStyle = 'tinted' | 'dot' | 'compact';
export const ModelTagStyleContext = createContext<ModelTagStyle>('tinted');

/** `neutral` says something without judging it (a plan, a price level);
 *  `dim` is the absence of a score (Q-6: "Not rated"). */
type Tone = Band | 'neutral' | 'dim';

export interface TagSpec {
  kind: 'cost' | 'intelligence' | 'speed';
  tone: Tone;
  /** The full words, for the second-line layouts. */
  label: string;
  /** The short form, for the same-line layout. */
  short: string;
  /** The exact figures behind the tag, where they came from and how old (S-3). */
  hint: string;
  /** A figure the app worked out rather than measured (an estimated speed). Drawn
   *  with a dashed edge; the hint says it is an estimate. */
  estimated?: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-11" -> "11 Sep 2026". Spelled out by hand rather than through
 *  toLocaleDateString, whose month names differ between machines. */
function niceDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : iso;
}

/** $0.27 · $1.25 · $15 — cents only when there are some. */
function dollars(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** The listed price, in and out (Destin, F-1 note: "hovering should show the real
 *  full listed in/out price"). WHY these words (UX tester U13): "$3 in · $15 out, per
 *  million" left a student asking per million WHAT, and what in and out are. Prices
 *  are listed per token; about 750,000 English words make a million tokens. */
function priceLines(p: { in: number; out: number }): string {
  return `${dollars(p.in)} for what you send · ${dollars(p.out)} for what it writes\nper million tokens (about 750,000 words)`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

// WHY comparisons instead of "Poor value among models scoring 50 to 79" (UX tester
// U14: it needed a second read). Value is judged against models at the same
// intelligence level, cheapest third great, priciest third poor (F-1), so "most
// models this smart" is exactly what the level means.
const VALUE_LINE = {
  great: 'Cheaper than most models this smart',
  fair: 'Priced like most models this smart',
  poor: 'Costs more than most models this smart',
} as const;

// A price level is thirds of every priced model, with no score to judge value (F-3).
const PRICE_LINE = {
  low: 'Cheaper than most models',
  mid: 'Priced like most models',
  high: 'Costs more than most models',
} as const;

const SPEED_WORD: Record<Band, string> = { good: 'Fast', middling: 'Medium', poor: 'Slow' };

/**
 * What a row's tags say.
 *
 * `snapshot` null means the facts never loaded: then the row carries NO tags,
 * rather than a wall of "Not rated" that would blame every model for a download
 * that failed. A loaded snapshot with nothing for this model is a real "no score"
 * and says so.
 */
export function tagsFor(
  facts: ModelFacts | undefined,
  snapshot: Pick<ModelFactsSnapshot, 'topModel' | 'asOf'> | null,
  planName: string,
): TagSpec[] {
  if (!snapshot) return [];
  const f = facts ?? {};
  const out: TagSpec[] = [];

  // ── Cost ──────────────────────────────────────────────────────────────────
  if (f.billing === 'subscription') {
    out.push({ kind: 'cost', tone: 'neutral', label: 'SUBSCRIPTION PLAN', short: 'Plan', hint: `Included in your ${planName} plan, no charge per use` });
  } else if (f.billing === 'local') {
    out.push({ kind: 'cost', tone: 'good', label: 'FREE - LOCAL', short: 'Free', hint: 'Runs on this computer, no charge per use' });
  } else if (f.price && f.value && f.intelligence) {
    const word = { great: 'Great', fair: 'Fair', poor: 'Poor' }[f.value];
    out.push({
      kind: 'cost', tone: VALUE_BAND[f.value], label: `${word} value`, short: word,
      hint: `${VALUE_LINE[f.value]}\n${priceLines(f.price)}`,
    });
  } else if (f.price && f.priceLevel) {
    const word = { low: 'Low', mid: 'Mid', high: 'High' }[f.priceLevel];
    out.push({
      kind: 'cost', tone: 'neutral', label: `${word} price`, short: `${word} price`,
      hint: `${PRICE_LINE[f.priceLevel]}; no intelligence score to judge value\n${priceLines(f.price)}`,
    });
  }
  // No price found and no billing: nothing. Never "Free" (S-1).

  // ── Intelligence ──────────────────────────────────────────────────────────
  if (f.intelligence) {
    const { score, scoredAs, borrowed, benchmarks: b } = f.intelligence;
    // WHY these lines (UX tester U11, U12): "100 is GPT-6 Astra" named a model that
    // is not in the list, the bare percentages did not say percent of what, and a
    // plan alias ("Sonnet") scored as a different name read as a second model.
    const lines = [`Intelligence ${score} out of 100`, `100 is today's best model, ${snapshot.topModel}`];
    if (scoredAs) {
      lines.push(borrowed
        ? `Score of the original ${scoredAs}; this downloaded copy may do a little worse`
        : `Scores for ${scoredAs}, the model it runs today`);
    }
    const results = [
      b?.coding != null ? `coding ${pct(b.coding)}` : null,
      b?.science != null ? `science ${pct(b.science)}` : null,
      b?.facts != null ? `facts ${pct(b.facts)}` : null,
    ].filter(Boolean);
    if (results.length) lines.push(`Tests passed: ${results.join(' · ')}`);
    if (b?.instructions) lines.push(`${ordinal(b.instructions.rank)} of ${b.instructions.of} at following instructions`);
    // The sources are named on purpose: both licences require credit (CC BY 4.0).
    lines.push(`Sources: Epoch AI${b?.instructions ? ', LMArena' : ''} · ${niceDate(snapshot.asOf)}`);
    out.push({ kind: 'intelligence', tone: intelligenceBand(score), label: `Intelligence ${score}`, short: String(score), hint: lines.join('\n') });
  } else {
    out.push({ kind: 'intelligence', tone: 'dim', label: 'Not rated', short: 'Not rated', hint: 'No public intelligence score for this model yet' });
  }

  // ── Speed (this computer only, Q-9) ───────────────────────────────────────
  if (f.speed) {
    const word = SPEED_WORD[speedBand(f.speed.wordsPerSecond)];
    // WHY no "~" (UX tester U15: "the tilde means nothing to most people"): an
    // estimate is drawn with a dashed edge, and its hint says so in words.
    out.push({
      kind: 'speed', tone: speedBand(f.speed.wordsPerSecond), label: word, short: word,
      estimated: f.speed.estimated,
      hint: f.speed.estimated
        ? `About ${f.speed.wordsPerSecond} words a second on this computer\nAn estimate until its first reply`
        : `${f.speed.wordsPerSecond} words a second on this computer, measured`,
    });
  }
  return out;
}

// The status palette, reused as the StatusPill (G-26) uses it: a tint at 15% with
// a 30% edge, and the WORD in the theme's own text colour. Coloured words failed
// contrast on the pale themes; a tint behind neutral words does not.
const TINT: Record<Tone, string> = {
  good: 'bg-green-400/15 border-green-400/30',
  middling: 'bg-amber-400/15 border-amber-400/30',
  poor: 'bg-red-400/15 border-red-400/30',
  neutral: 'bg-inset border-edge-dim',
  dim: 'border-edge-dim border-dashed',
};

const DOT: Record<Band, string> = { good: 'bg-green-400', middling: 'bg-amber-400', poor: 'bg-red-400' };

function Dot({ tone }: { tone: Tone }) {
  if (tone === 'dim') return <span aria-hidden className="w-1.5 h-1.5 rounded-full border border-edge shrink-0" />;
  if (tone === 'neutral') return <span aria-hidden className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--fg-muted)' }} />;
  return <span aria-hidden className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[tone]}`} />;
}

export function ModelTags({ tags, selected = false, className = '' }: {
  tags: TagSpec[];
  /** The row is the current model, drawn on the theme's accent fill. */
  selected?: boolean;
  className?: string;
}) {
  const style = useContext(ModelTagStyleContext);
  if (!tags.length) return null;
  return (
    // Spacing is set so three tags ("FREE - LOCAL", "Intelligence 24", "Medium")
    // fit on one line at the list's usual width; a narrower host still wraps
    // rather than cutting a tag off.
    <span className={`flex items-center ${style === 'dot' ? 'gap-x-1.5 gap-y-1' : 'gap-1'} ${style === 'compact' ? 'shrink-0' : 'flex-wrap'} ${className}`}>
      {tags.map((t) => (
        // placement bottom (UX tester U6): above, the hint covered the row's own
        // model name, so you could no longer see which model it described.
        <Tooltip key={t.kind} text={t.hint} placement="bottom">
          {style === 'dot' ? (
            <span className={`inline-flex items-center gap-[3px] text-2xs leading-none whitespace-nowrap ${selected ? '' : 'text-fg-2'}`}>
              <Dot tone={t.tone} />
              {t.label}
            </span>
          ) : (
            // WHY a panel backing on the current row (UX tester U20): the chips used
            // to drop their colour there, so the highest-scoring model's tag turned
            // plain grey beside a lower green one. A tint over the theme's accent
            // cannot promise readable text; a tint over `panel` is the same chip every
            // other row draws, so its contrast is already known.
            <span className={`inline-flex rounded-sm ${selected ? 'bg-panel' : ''}`}>
              <span
                className={`inline-flex items-center px-1 py-[2px] rounded-sm border text-2xs leading-none whitespace-nowrap text-fg-2 font-normal ${TINT[t.tone]} ${t.estimated ? 'border-dashed' : ''}`}
              >
                {style === 'compact' ? t.short : t.label}
              </span>
            </span>
          )}
        </Tooltip>
      ))}
    </span>
  );
}
