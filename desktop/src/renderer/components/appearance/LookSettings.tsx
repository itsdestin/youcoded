// The "Look" parts of Settings → Appearance: the user's own choices laid over every
// theme (themes/look-overrides.ts). Every control's first option is "Auto" — the
// theme's own choice — which is also what everything starts on. Decisions:
// appearance-panel-questions (2026-09-24) AP-1 one layout picker, AP-2 glass presets
// with Fine-tune on request, AP-4 bubble shape / roundness, AP-S1
// nobody's look changes until they change a setting; appearance-panel-review-3 —
// pictures for every choice, painted in the theme's real colours, and the Look
// settings behind one "Additional Customizations" row (under Layout — review-5 AR5-2); review-4 — no Message box setting (it now
// rides on the layout, look-overrides.ts), and the opened settings live inside that row's box.
//
// What must last is the FUNCTIONALITY — `lookOverrides` / `setLookOverrides` on
// useTheme(), the rules in themes/look-overrides.ts, and "absent field = Auto".

import { useState, type ReactNode } from 'react';
import { useTheme } from '../../state/theme-context';
import type { BubbleStyle, ChromeStyle, LoadedTheme } from '../../themes/theme-types';
import {
  GLASS_DEFAULTS, GLASS_PRESETS, hasAnyOverride, hasSeeThroughBackground, themeRoundness,
  type GlassField, type GlassPreset, type GlassValues, type LookOverrides,
} from '../../themes/look-overrides';
import { TERMINAL_WALLPAPER_OPACITY_FLOOR } from '../../themes/theme-engine';
import { Button, RadioGroup, SegmentedTabs, SettingRow, FOCUS_RING } from '../ui';

export const SECTION_LABEL = 'text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2';

// "Auto" = the absent field = the theme's own choice (AP-S1). Named "Auto" at Destin's
// request (appearance-panel-review-3, AR3-1): "Auto (Theme)" in place of "Theme's".
const THEME = 'theme';
const AUTO = 'Auto';

const CHROME_LABEL: Record<ChromeStyle, string> = {
  default: 'Framed',
  floating: 'Floating bars',
  float: 'Minimalist',
};
const BUBBLE_CHOICES = ['default', 'pill', 'flat', 'bordered'] as const;
const BUBBLE_LABEL: Record<BubbleStyle, string> = {
  default: 'Standard', pill: 'Pill', flat: 'Flat', bordered: 'Outlined',
};
// ── Pictures ─────────────────────────────────────────────────────────────────
// WHY real-colour miniatures (Destin, review-3 AR3-1: "more effort into building better
// renders/images"): the first round drew grey outlines, and Standard and Outlined looked
// alike. Each picture is now a tiny chat window painted with the ACTIVE theme's own
// colours (canvas, panel, inset, accent, edge) and shaped like the setting it stands
// for. Plain divs with theme classes: nothing to load, and they follow every theme and
// every Look change live.

/** The miniature's window: the theme's canvas with a hairline edge. */
function Mini({ children }: { children: ReactNode }) {
  return <div className="relative w-full h-11 rounded-md overflow-hidden bg-canvas border border-edge-dim" aria-hidden="true">{children}</div>;
}

/** Two chat bubbles — yours (accent) and the reply (inset) — in a bubble style.
 *  Mirrors the bubble-style rules in globals.css. */
function MiniBubbles({ style }: { style: BubbleStyle }) {
  const shape = (side: 'user' | 'reply') => {
    if (style === 'pill') return 'rounded-full';
    if (style === 'flat') return 'rounded-none border-l-2 border-edge';
    if (style === 'bordered') return 'rounded-sm border border-edge';
    return side === 'user' ? 'rounded-md rounded-br-none' : 'rounded-md rounded-bl-none';
  };
  return (
    <Mini>
      <div className="absolute inset-x-1.5 top-1.5 flex flex-col gap-1">
        <div className={`self-end w-3/5 h-3.5 bg-accent ${shape('user')}`} />
        <div className={`self-start w-3/4 h-4 bg-inset ${shape('reply')}`} />
      </div>
    </Mini>
  );
}

/** The whole window in a layout: where the header, message box and edges sit. */
function MiniLayout({ style }: { style: ChromeStyle }) {
  const chip = 'bg-panel border border-edge-dim';
  return (
    <Mini>
      {/* Framed: the chrome is one continuous frame (header, sides, message box) with the
          chat set INTO it as a rounded pane — drawn as a panel-coloured window with a
          canvas pane cut in. WHY (review-6 AR6-1): four separate strips read as "just two
          top bars", not the real framed shell. */}
      {style === 'default' && (
        <div className="absolute inset-0 bg-panel">
          <div className="absolute left-1 right-1 top-2 bottom-3 rounded-sm bg-canvas border border-edge" />
          <div className="absolute left-2 right-2 bottom-1 h-1.5 rounded-full bg-inset" />
        </div>
      )}
      {/* The chat, drawn after the frame so it sits on top of it. */}
      <div className={`absolute inset-x-3 ${style === 'default' ? 'top-3' : 'top-3.5'} flex flex-col gap-0.5`}>
        <div className="self-end w-1/2 h-1.5 rounded-sm bg-accent" />
        <div className="self-start w-3/5 h-1.5 rounded-sm bg-inset" />
      </div>
      {style === 'floating' && (
        <>
          <div className={`absolute inset-x-1.5 top-1 h-2 rounded-full ${chip}`} />
          <div className={`absolute inset-x-1.5 bottom-1 h-2.5 rounded-full ${chip}`} />
        </>
      )}
      {style === 'float' && (
        <>
          <div className={`absolute left-1.5 top-1 w-1.5 h-1.5 rounded-full ${chip}`} />
          <div className={`absolute left-3.5 top-1 w-1.5 h-1.5 rounded-full ${chip}`} />
          <div className={`absolute right-1.5 top-1 w-4 h-1.5 rounded-full ${chip}`} />
          <div className={`absolute left-1/4 right-1/4 bottom-2.5 h-2 rounded-full ${chip}`} />
          <div className="absolute left-1/4 right-1/4 bottom-1 flex justify-center gap-0.5">
            <span className={`w-2 h-1 rounded-full ${chip}`} /><span className={`w-2 h-1 rounded-full ${chip}`} /><span className={`w-1.5 h-1 rounded-full ${chip}`} />
          </div>
        </>
      )}
    </Mini>
  );
}

/** A card and a button at a roundness (0 square … 1 round), drawn with real radii. */
function MiniCorners({ r }: { r: number }) {
  return (
    <Mini>
      <div className="absolute inset-x-2 top-1.5 bottom-1.5 bg-inset border border-edge-dim flex items-end justify-end p-1" style={{ borderRadius: `${r * 10}px` }}>
        <div className="w-5 h-2.5 bg-accent" style={{ borderRadius: `${r * 5 + 0.5}px` }} />
      </div>
    </Mini>
  );
}

// Static class names so Tailwind generates them.
const GRID_COLS: Record<number, string> = { 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5' };

/** A row of picture tiles, one per choice; the first is always Auto (the theme's own).
 *  The picture IS the option; the border marks the pick, like the theme cards.
 *  `value` null = the saved value matches no tile (a roundness set by the old slider). */
function TilePicker<T extends string>({ label, choices, value, onChange, picture, name, autoIs }: {
  label: string;
  choices: readonly T[];
  value: T | undefined | null;
  onChange: (v: T | undefined) => void;
  picture: (id: T | typeof THEME) => ReactNode;
  name: (id: T) => string;
  /** What Auto currently resolves to, shown under it. */
  autoIs: string;
}) {
  const current = value === undefined ? THEME : value;
  const all = [THEME, ...choices] as (T | typeof THEME)[];
  return (
    <RadioGroup
      options={all}
      value={current ?? ''}
      onChange={(id) => onChange(id === THEME ? undefined : id as T)}
      aria-label={label}
      className={`grid gap-1.5 ${GRID_COLS[all.length] ?? 'grid-cols-4'}`}
    >
      {all.map((id) => {
        const selected = id === current;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (current === null && id === THEME) ? 0 : -1}
            onClick={() => onChange(id === THEME ? undefined : id as T)}
            className={`flex flex-col items-center gap-1 px-1 pt-1 pb-2 rounded-lg border transition-colors ${FOCUS_RING} ${selected ? 'border-accent bg-inset' : 'border-transparent hover:bg-inset/50'}`}
          >
            {picture(id)}
            <span className={`text-3xs leading-tight text-center truncate max-w-full ${selected ? 'text-fg font-medium' : 'text-fg-2'}`}>
              {id === THEME ? AUTO : name(id as T)}
            </span>
            {id === THEME && <span className="text-4xs text-fg-muted leading-none -mt-0.5 truncate max-w-full">{autoIs}</span>}
          </button>
        );
      })}
    </RadioGroup>
  );
}

/** One labelled slider. Greys out when disabled and shows the formatted value.
 *  Shared with the user-theme editor in ThemeScreen. */
export function LookSlider({
  label, min, max, step, value, onChange, format, disabled = false,
}: {
  label: string;
  min: number; max: number; step: number;
  value: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 ${disabled ? 'opacity-40' : ''}`}>
      {/* Fixed label column so every slider in a stack starts and ends at the same x. */}
      <span className="text-xs text-fg-2 shrink-0 w-28">{label}</span>
      <div className="flex items-center gap-2 flex-1">
        <input
          type="range" min={min} max={max} step={step}
          value={value}
          disabled={disabled}
          aria-label={label}
          onChange={e => onChange(parseFloat(e.target.value))}
          className="flex-1 accent-accent"
        />
        <span className="text-3xs text-fg-muted w-9 text-right">{format(value)}</span>
      </div>
    </div>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const whole = (v: number) => String(Math.round(v));

const GLASS_SLIDERS: { field: GlassField; label: string; min: number; max: number; step: number; format: (v: number) => string; blur?: boolean; terminal?: boolean; filter?: boolean }[] = [
  { field: 'panels-blur', label: 'Panel blur', min: 0, max: 30, step: 1, format: whole, blur: true },
  { field: 'panels-opacity', label: 'Panel opacity', min: 0.3, max: 1, step: 0.02, format: pct },
  { field: 'bubble-blur', label: 'Bubble blur', min: 0, max: 24, step: 1, format: whole, blur: true },
  { field: 'bubble-opacity', label: 'Bubble opacity', min: 0.3, max: 1, step: 0.02, format: pct },
  // Terminal floor: the engine raises anything lower to it (see ThemeScreen's old
  // ROADMAP L18 note), so the slider starts there and never lies about its effect.
  { field: 'terminal-opacity', label: 'Terminal opacity', min: TERMINAL_WALLPAPER_OPACITY_FLOOR, max: 1, step: 0.02, format: pct, terminal: true },
  { field: 'terminal-blur', label: 'Terminal blur', min: 0, max: 30, step: 1, format: whole, blur: true, terminal: true, filter: true },
  { field: 'terminal-brightness', label: 'Terminal brightness', min: 0.5, max: 1.2, step: 0.02, format: pct, terminal: true, filter: true },
];

/** A setting with its choices underneath: title (and optional hint) on top, the choices
 *  full width below — the design guide's rule for a set of choices (SA-1 "mixed"). */
function StackedRow({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div>
        <div className="text-xs font-medium text-fg">{title}</div>
        {hint && <p className="text-3xs text-fg-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function GlassSettings({ active, raw, look, set, reducedEffects }: {
  active: LoadedTheme; raw: LoadedTheme; look: LookOverrides; set: (next: LookOverrides) => void; reducedEffects: boolean;
}) {
  const [fineTune, setFineTune] = useState(look.glass === 'custom');
  const seeThrough = hasSeeThroughBackground(raw);
  const bakedTerminal = raw.background?.type === 'image' && !!raw.background?.['terminal-value'];
  const tabs = [
    // "Auto", not Destin's "Auto (Theme)": in a four-way strip the longer label wrapped
    // to two lines. Every picker's first choice reads "Auto" the same way.
    { id: THEME, label: AUTO },
    { id: 'clear', label: 'Clear' },
    { id: 'frosted', label: 'Frosted' },
    { id: 'solid', label: 'Solid' },
    // Custom appears only once the user has fine-tuned, so the row stays four
    // plain words until then.
    ...(look.glass === 'custom' ? [{ id: 'custom', label: 'Custom' }] : []),
  ];

  const pick = (id: string) => {
    const next = { ...look };
    if (id === THEME) delete next.glass;
    else next.glass = id as GlassPreset;
    set(next);
  };

  // Dragging any slider makes the glass "Custom", seeded from whatever is painted
  // right now, so the other six knobs do not jump when the first one moves.
  const setField = (field: GlassField, v: number) => {
    const painted: GlassValues = {};
    for (const s of GLASS_SLIDERS) painted[s.field] = active.background?.[s.field] ?? GLASS_DEFAULTS[s.field];
    const base = look.glass === 'custom' ? { ...painted, ...look.glassCustom } : painted;
    set({ ...look, glass: 'custom', glassCustom: { ...base, [field]: v } });
  };

  // WHY the hint sits under the title (redesign, 2026-09-24): it used to be a loose
  // paragraph under the strip, which read as a separate block of text.
  const hint = !seeThrough ? 'No effect on this theme — it has no wallpaper'
    : reducedEffects ? 'Blur is off while Reduce Visual Effects is on' : undefined;

  return (
    <div className="space-y-1.5">
      <StackedRow title="Glass" hint={hint}>
        <SegmentedTabs tabs={tabs} value={look.glass ?? THEME} onChange={pick} variant="contained" aria-label="Glass" />
      </StackedRow>
      <SettingRow
        variant="item"
        title="Fine-tune glass"
        description={look.glass === 'custom' ? 'Your own values' : 'Set each blur and see-through level'}
        expanded={fineTune}
        onClick={() => setFineTune(v => !v)}
      />
      {fineTune && (
        <div className="space-y-3 px-3 py-2">
          {GLASS_SLIDERS.map(s => {
            const value = (look.glass === 'custom' ? look.glassCustom?.[s.field] : undefined)
              ?? active.background?.[s.field]
              ?? (look.glass && look.glass !== 'custom' ? GLASS_PRESETS[look.glass][s.field] : undefined)
              ?? GLASS_DEFAULTS[s.field];
            return (
              <LookSlider
                key={s.field}
                label={s.label}
                min={s.min} max={s.max} step={s.step}
                value={s.field === 'terminal-opacity' ? Math.max(TERMINAL_WALLPAPER_OPACITY_FLOOR, value) : value}
                disabled={(s.blur && reducedEffects) || (s.filter && bakedTerminal)}
                onChange={v => setField(s.field, v)}
                format={s.format}
              />
            );
          })}
          {bakedTerminal && (
            <p className="text-3xs text-fg-muted leading-relaxed">
              This theme ships a pre-blurred terminal wallpaper, so terminal blur and brightness are fixed here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Roundness is three steps of the same 0..1 scale the old slider covered, so a tile
// stores exactly what dragging there would have (review-3: pictures, no slider).
type RoundPreset = 'square' | 'soft' | 'round';
const ROUND_PRESETS: Record<RoundPreset, number> = { square: 0, soft: 0.5, round: 1 };
const ROUND_LABEL: Record<RoundPreset, string> = { square: 'Square', soft: 'Soft', round: 'Round' };
const nearestRound = (r: number): RoundPreset => (r < 0.25 ? 'square' : r < 0.75 ? 'soft' : 'round');

/** The layout picker on its own. WHY split from LookSettings (Destin, appearance-panel-review
 *  AR-1, 2026-09-24): "layout should be at the top" — it heads the whole panel. */
export function LayoutSettings() {
  const { activeTheme, allThemes, theme: activeSlug, lookOverrides: look, setLookOverrides: set } = useTheme();
  const raw = allThemes.find(t => t.slug === activeSlug) ?? activeTheme;
  const themeStyle: ChromeStyle = raw.layout?.['chrome-style'] ?? 'default';
  return (
    <TilePicker<ChromeStyle>
      label="Layout"
      choices={['default', 'floating', 'float']}
      value={look.chromeStyle}
      onChange={v => {
        if (v) { set({ ...look, chromeStyle: v }); return; }
        const next = { ...look }; delete next.chromeStyle; set(next);
      }}
      picture={(id) => <MiniLayout style={id === THEME ? themeStyle : id as ChromeStyle} />}
      name={(id) => CHROME_LABEL[id]}
      autoIs={CHROME_LABEL[themeStyle]}
    />
  );
}

const LOOK_KEYS: (keyof LookOverrides)[] = ['glass', 'bubbleStyle', 'roundness'];

/** Bubbles, message box, roundness and glass, behind one "Additional Customizations" row (under Layout — review-5 AR5-2).
 *  WHY folded (Destin, review-3 AR3-2, picked "Look tucked away"): the most-used
 *  settings — layout, themes, the two switches — stay up front; these open in place. */
export function LookSettings() {
  const { activeTheme, allThemes, theme: activeSlug, lookOverrides: look, setLookOverrides: set, reducedEffects } = useTheme();
  // The theme's OWN choices, for the Auto labels. allThemes is raw; activeTheme
  // already has the overrides applied.
  const raw = allThemes.find(t => t.slug === activeSlug) ?? activeTheme;
  const without = (key: keyof LookOverrides) => { const next = { ...look }; delete next[key]; return next; };
  const themeBubble: BubbleStyle = raw.layout?.['bubble-style'] ?? 'default';
  const themeRound = themeRoundness(raw);
  const roundPick = look.roundness === undefined ? undefined
    : (Object.keys(ROUND_PRESETS) as RoundPreset[]).find(k => ROUND_PRESETS[k] === look.roundness) ?? null;
  const changed = LOOK_KEYS.filter(k => look[k] !== undefined).length;
  const [open, setOpen] = useState(false);

  // WHY one box (Destin, review-4 AR4-3: "all of the submenus should exist within the
  // customize look container when expanded"): the row's tinted box continues below it
  // when open — the row drops its bottom corners and the settings sit in the same tint.
  return (
    <div>
      <SettingRow
        variant="item"
        title="Additional Customizations"
        description={changed === 0 ? 'Message bubbles, corners, glass' : `${changed} changed from the theme`}
        expanded={open}
        onClick={() => setOpen(v => !v)}
        className={open ? 'rounded-b-none' : ''}
      />
      {open && (
        <div className="space-y-4 bg-inset/50 rounded-b-lg px-3 pt-2 pb-3">
          <StackedRow title="Message bubbles">
            <TilePicker<BubbleStyle>
              label="Message bubbles"
              choices={BUBBLE_CHOICES}
              value={look.bubbleStyle}
              onChange={v => set(v ? { ...look, bubbleStyle: v } : without('bubbleStyle'))}
              picture={id => <MiniBubbles style={id === THEME ? themeBubble : id as BubbleStyle} />}
              name={id => BUBBLE_LABEL[id]}
              autoIs={BUBBLE_LABEL[themeBubble]}
            />
          </StackedRow>
          <StackedRow title="Roundness">
            <TilePicker<RoundPreset>
              label="Roundness"
              choices={['square', 'soft', 'round']}
              value={roundPick}
              onChange={v => set(v ? { ...look, roundness: ROUND_PRESETS[v] } : without('roundness'))}
              picture={id => <MiniCorners r={id === THEME ? themeRound : ROUND_PRESETS[id as RoundPreset]} />}
              name={id => ROUND_LABEL[id]}
              autoIs={ROUND_LABEL[nearestRound(themeRound)]}
            />
          </StackedRow>
          <GlassSettings active={activeTheme} raw={raw} look={look} set={set} reducedEffects={reducedEffects} />
          {hasAnyOverride(look) && (
            <Button variant="secondary" size="sm" onClick={() => set({})} className="w-full">
              Reset all to Auto
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
