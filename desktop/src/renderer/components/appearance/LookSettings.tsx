// The "Look" section of Settings → Appearance: the user's own choices laid over
// every theme (themes/look-overrides.ts). Every control's first option is
// "Theme's choice", which is also what everything starts on — Destin's
// appearance-panel-questions deck, 2026-09-24: AP-1 (one picker for layout),
// AP-2 (glass presets with Fine-tune on request), AP-4 (bubble shape, message
// box, roundness), AP-S1 (nobody's look changes until they change a setting).

import { useState } from 'react';
import { useTheme } from '../../state/theme-context';
import type { BubbleStyle, ChromeStyle, InputStyle, LoadedTheme } from '../../themes/theme-types';
import {
  GLASS_DEFAULTS, GLASS_PRESETS, hasAnyOverride, hasSeeThroughBackground, themeRoundness,
  type GlassField, type GlassPreset, type GlassValues, type LookOverrides,
} from '../../themes/look-overrides';
import { TERMINAL_WALLPAPER_OPACITY_FLOOR } from '../../themes/theme-engine';
import { Button, RadioGroup, SegmentedTabs, Select, SettingRow, FOCUS_RING } from '../ui';

export const SECTION_LABEL = 'text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2';

const CHROME_LABEL: Record<ChromeStyle, string> = {
  default: 'Framed',
  floating: 'Floating bars',
  float: 'Minimalist',
};
const BUBBLE_LABEL: Record<BubbleStyle, string> = {
  default: 'Standard', pill: 'Pill', flat: 'Flat', bordered: 'Outlined',
};
const INPUT_LABEL: Record<InputStyle, string> = {
  default: 'Standard', floating: 'Floating', minimal: 'Minimal', terminal: 'Terminal',
};
const THEME = 'theme';

/** A tiny drawing of each layout, so the choice is seen rather than read.
 *  Drawn in currentColor so it follows the app's text colour on any theme. */
function LayoutSketch({ style }: { style: ChromeStyle }) {
  const bar = { fill: 'currentColor', fillOpacity: 0.35 };
  return (
    <svg viewBox="0 0 60 40" className="w-full h-auto" aria-hidden="true">
      <rect x="0.5" y="0.5" width="59" height="39" rx="3" fill="none" stroke="currentColor" strokeOpacity="0.25" />
      {/* chat lines, the same in all three */}
      <rect x="14" y="13" width="22" height="3" rx="1.5" fill="currentColor" fillOpacity="0.18" />
      <rect x="24" y="19" width="24" height="3" rx="1.5" fill="currentColor" fillOpacity="0.18" />
      {style === 'default' && (
        <>
          <rect x="0.5" y="0.5" width="59" height="7" rx="3" {...bar} />
          <rect x="0.5" y="30" width="59" height="9.5" rx="3" {...bar} />
          <rect x="0.5" y="7" width="3" height="23" {...bar} />
          <rect x="56.5" y="7" width="3" height="23" {...bar} />
        </>
      )}
      {style === 'floating' && (
        <>
          <rect x="4" y="3" width="52" height="6" rx="3" {...bar} />
          <rect x="4" y="29" width="52" height="8" rx="3" {...bar} />
        </>
      )}
      {style === 'float' && (
        <>
          <circle cx="7" cy="6" r="2" {...bar} />
          <circle cx="12.5" cy="6" r="2" {...bar} />
          <rect x="40" y="4" width="15" height="4" rx="2" {...bar} />
          <rect x="13" y="28" width="34" height="5" rx="2.5" {...bar} />
          <rect x="19" y="35" width="7" height="2.5" rx="1.25" {...bar} />
          <rect x="28" y="35" width="7" height="2.5" rx="1.25" {...bar} />
          <rect x="37" y="35" width="5" height="2.5" rx="1.25" {...bar} />
        </>
      )}
    </svg>
  );
}

const LAYOUT_CHOICES = [THEME, 'default', 'floating', 'float'] as const;

function LayoutPicker({ raw, value, onChange }: { raw: LoadedTheme; value: ChromeStyle | undefined; onChange: (v: ChromeStyle | undefined) => void }) {
  const themeStyle: ChromeStyle = raw.layout?.['chrome-style'] ?? 'default';
  const current = value ?? THEME;
  return (
    <RadioGroup
      options={LAYOUT_CHOICES}
      value={current}
      onChange={(id) => onChange(id === THEME ? undefined : id as ChromeStyle)}
      aria-label="Layout"
      className="grid grid-cols-4 gap-2"
    >
      {LAYOUT_CHOICES.map((id) => {
        const selected = id === current;
        const sketch: ChromeStyle = id === THEME ? themeStyle : id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id === THEME ? undefined : id as ChromeStyle)}
            // A tile, not a list row: the sketch IS the option. Border marks the pick,
            // like the theme cards above it.
            className={`flex flex-col items-center gap-1 p-1.5 rounded-lg border text-fg-2 transition-colors ${FOCUS_RING} ${selected ? 'border-accent bg-inset' : 'border-edge-dim hover:border-edge'}`}
          >
            <LayoutSketch style={sketch} />
            <span className="text-3xs font-medium leading-tight text-center">
              {id === THEME ? "Theme's choice" : CHROME_LABEL[id]}
            </span>
            {id === THEME && <span className="text-4xs text-fg-muted leading-none">{CHROME_LABEL[themeStyle]}</span>}
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

function GlassSettings({ active, raw, look, set, reducedEffects }: {
  active: LoadedTheme; raw: LoadedTheme; look: LookOverrides; set: (next: LookOverrides) => void; reducedEffects: boolean;
}) {
  const [fineTune, setFineTune] = useState(look.glass === 'custom');
  const seeThrough = hasSeeThroughBackground(raw);
  const bakedTerminal = raw.background?.type === 'image' && !!raw.background?.['terminal-value'];
  const tabs = [
    { id: THEME, label: "Theme's" },
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

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-fg-2">Glass</span>
      </div>
      <SegmentedTabs
        tabs={tabs}
        value={look.glass ?? THEME}
        onChange={pick}
        variant="contained"
        aria-label="Glass"
      />
      {!seeThrough && (
        <p className="text-3xs text-fg-muted leading-relaxed">
          This theme has no wallpaper, so glass has no effect on it. Your choice still applies to themes that do.
        </p>
      )}
      {seeThrough && reducedEffects && (
        <p className="text-3xs text-fg-muted leading-relaxed">
          Reduce Visual Effects is on, so blur is off. See-through still applies.
        </p>
      )}
      <SettingRow
        variant="item"
        title="Fine-tune"
        description={look.glass === 'custom' ? 'Your own values' : 'Set each blur and see-through level yourself'}
        expanded={fineTune}
        onClick={() => setFineTune(v => !v)}
      />
      {fineTune && (
        <div className="space-y-3 px-1 pt-1">
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

function ChoiceRow<T extends string>({ title, labels, themeValue, value, onChange }: {
  title: string; labels: Record<T, string>; themeValue: T; value: T | undefined; onChange: (v: T | undefined) => void;
}) {
  const options = [
    { value: THEME, label: `Theme's choice (${labels[themeValue]})` },
    ...(Object.keys(labels) as T[]).map(k => ({ value: k, label: labels[k] })),
  ];
  return (
    <SettingRow
      variant="item"
      title={title}
      control={
        <div className="w-52 shrink-0">
          <Select
            size="sm"
            options={options}
            value={value ?? THEME}
            onChange={v => onChange(v === THEME ? undefined : v as T)}
            aria-label={title}
          />
        </div>
      }
    />
  );
}

export function LookSettings() {
  const { activeTheme, allThemes, theme: activeSlug, lookOverrides: look, setLookOverrides: set, reducedEffects } = useTheme();
  // The theme's OWN choices, for the "Theme's choice (…)" labels. allThemes is raw;
  // activeTheme already has the overrides applied.
  const raw = allThemes.find(t => t.slug === activeSlug) ?? activeTheme;
  const without = (key: keyof LookOverrides) => { const next = { ...look }; delete next[key]; return next; };
  const themeRound = themeRoundness(raw);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <span className="text-xs text-fg-2">Layout</span>
        <LayoutPicker
          raw={raw}
          value={look.chromeStyle}
          onChange={v => set(v ? { ...look, chromeStyle: v } : without('chromeStyle'))}
        />
      </div>

      <GlassSettings active={activeTheme} raw={raw} look={look} set={set} reducedEffects={reducedEffects} />

      <div className="space-y-1">
        <ChoiceRow
          title="Bubble shape"
          labels={BUBBLE_LABEL}
          themeValue={raw.layout?.['bubble-style'] ?? 'default'}
          value={look.bubbleStyle}
          onChange={v => set(v ? { ...look, bubbleStyle: v } : without('bubbleStyle'))}
        />
        <ChoiceRow
          title="Message box"
          labels={INPUT_LABEL}
          themeValue={raw.layout?.['input-style'] ?? 'default'}
          value={look.inputStyle}
          onChange={v => set(v ? { ...look, inputStyle: v } : without('inputStyle'))}
        />
        <SettingRow
          variant="item"
          title="Roundness"
          control={
            <div className="w-52 shrink-0">
              <Select
                size="sm"
                options={[{ value: THEME, label: "Theme's choice" }, { value: 'custom', label: 'Custom' }]}
                value={look.roundness === undefined ? THEME : 'custom'}
                onChange={v => set(v === THEME ? without('roundness') : { ...look, roundness: themeRound })}
                aria-label="Roundness"
              />
            </div>
          }
        />
        {look.roundness !== undefined && (
          <div className="px-3 pt-1">
            <LookSlider
              label="Corners"
              min={0} max={1} step={0.05}
              value={look.roundness}
              onChange={v => set({ ...look, roundness: v })}
              format={v => (v < 0.05 ? 'Square' : v > 0.95 ? 'Round' : pct(v))}
            />
          </div>
        )}
      </div>

      {hasAnyOverride(look) && (
        <Button variant="ghost" size="sm" onClick={() => set({})} className="w-full">
          Reset everything to Theme's choice
        </Button>
      )}
    </div>
  );
}
