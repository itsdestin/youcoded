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
 *  `dim` is the absence of a score (Q-6: a dim "Not rated"). */
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

/** Destin's wording on the deck (F-1 note): "hovering should show the real full
 *  listed in/out price". */
function priceLine(p: { in: number; out: number }): string {
  return `${dollars(p.in)} in · ${dollars(p.out)} out, per million`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Which intelligence level a value judgement was made within (F-1 "same-level"). */
function levelWords(score: number): string {
  return score >= 80 ? 'scoring 80 and up' : score >= 50 ? 'scoring 50 to 79' : 'scoring under 50';
}

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
    out.push({ kind: 'cost', tone: 'neutral', label: 'SUBSCRIPTION PLAN', short: 'Plan', hint: `Included in your ${planName} plan: no per-use price` });
  } else if (f.billing === 'local') {
    out.push({ kind: 'cost', tone: 'good', label: 'FREE - LOCAL', short: 'Free', hint: 'Runs on this computer: no per-use price' });
  } else if (f.price && f.value && f.intelligence) {
    const word = cap(f.value);
    out.push({
      kind: 'cost', tone: VALUE_BAND[f.value], label: `${word} value`, short: word,
      hint: `${word} value among models ${levelWords(f.intelligence.score)}\n${priceLine(f.price)}`,
    });
  } else if (f.price && f.priceLevel) {
    const word = { low: 'Low', mid: 'Mid', high: 'High' }[f.priceLevel];
    out.push({
      kind: 'cost', tone: 'neutral', label: `${word} price`, short: `${word} price`,
      hint: `${word} price. No intelligence score, so value can't be judged\n${priceLine(f.price)}`,
    });
  }
  // No price found and no billing: nothing. Never "Free" (S-1).

  // ── Intelligence ──────────────────────────────────────────────────────────
  if (f.intelligence) {
    const { score, scoredAs, borrowed, benchmarks: b } = f.intelligence;
    const lines = [`Intelligence ${score} of 100 (100 is ${snapshot.topModel})`];
    if (scoredAs) {
      lines.push(borrowed
        ? `Score of the original, ${scoredAs}; this downloaded copy may do somewhat worse`
        : `Scores for ${scoredAs}`);
    }
    const results = [
      b?.coding != null ? `Coding ${pct(b.coding)}` : null,
      b?.science != null ? `Science ${pct(b.science)}` : null,
      b?.facts != null ? `Facts ${pct(b.facts)}` : null,
    ].filter(Boolean);
    if (results.length) lines.push(results.join(' · '));
    if (b?.instructions) lines.push(`Following instructions: #${b.instructions.rank} of ${b.instructions.of}`);
    lines.push(`Epoch AI${b?.instructions ? ', LMArena' : ''} · ${niceDate(snapshot.asOf)}`);
    out.push({ kind: 'intelligence', tone: intelligenceBand(score), label: `Intelligence ${score}`, short: String(score), hint: lines.join('\n') });
  } else {
    out.push({ kind: 'intelligence', tone: 'dim', label: 'Not rated', short: 'Not rated', hint: 'No public intelligence score for this model yet' });
  }

  // ── Speed (this computer only, Q-9) ───────────────────────────────────────
  if (f.speed) {
    const word = SPEED_WORD[speedBand(f.speed.wordsPerSecond)];
    const shown = f.speed.estimated ? `~${word}` : word;
    out.push({
      kind: 'speed', tone: speedBand(f.speed.wordsPerSecond), label: shown, short: shown,
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
  /** On the selected row's accent fill a tint could fail contrast, because the
   *  accent is theme-authored; the tags follow the row's own text colour there. */
  selected?: boolean;
  className?: string;
}) {
  const style = useContext(ModelTagStyleContext);
  if (!tags.length) return null;
  const onAccent = { borderColor: 'color-mix(in srgb, currentColor 40%, transparent)' };
  return (
    // Spacing is set so three tags ("FREE - LOCAL", "Intelligence 24", "~Medium")
    // fit on one line at the list's usual width; a narrower host still wraps
    // rather than cutting a tag off.
    <span className={`flex items-center ${style === 'dot' ? 'gap-x-1.5 gap-y-1' : 'gap-1'} ${style === 'compact' ? 'shrink-0' : 'flex-wrap'} ${className}`}>
      {tags.map((t) => (
        <Tooltip key={t.kind} text={t.hint}>
          {style === 'dot' ? (
            <span className={`inline-flex items-center gap-[3px] text-2xs leading-none whitespace-nowrap ${selected ? '' : t.tone === 'dim' ? 'text-fg-muted' : 'text-fg-2'}`}>
              <Dot tone={t.tone} />
              {t.label}
            </span>
          ) : (
            <span
              className={`inline-flex items-center px-1 py-[2px] rounded-sm border text-2xs leading-none whitespace-nowrap ${
                selected ? '' : `${TINT[t.tone]} ${t.tone === 'dim' ? 'text-fg-muted' : 'text-fg-2'}`
              }`}
              style={selected ? onAccent : undefined}
            >
              {style === 'compact' ? t.short : t.label}
            </span>
          )}
        </Tooltip>
      ))}
    </span>
  );
}
