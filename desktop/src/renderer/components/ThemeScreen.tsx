import React, { useCallback, useRef, useState } from 'react';
import { useTheme } from '../state/theme-context';
import { computeOnAccent } from '../themes/theme-validator';
import SettingsExplainer, { InfoIconButton, type ExplainerSection } from './SettingsExplainer';
import type { LoadedTheme } from '../themes/theme-types';

// Plain-language explainer for the Appearance popup. Shown when the user taps
// the (i) icon in the popup header — see ThemeScreen's `showInfo` state.
const APPEARANCE_EXPLAINER: { intro: string; sections: ExplainerSection[] } = {
  intro:
    "Appearance lets you customize how DestinCode looks — colors, fonts, animations, and visual effects. You can use a built-in theme, download one from the marketplace, or build your own just by describing it to Claude.",
  sections: [
    {
      heading: "What's a theme?",
      paragraphs: [
        "A theme is a set of colors and styles that change the whole look of the app. It includes the background, text colors, accent color (used for buttons and highlights), how round the corners are, and decorative effects like falling particles or blurred glass panels.",
      ],
    },
    {
      heading: 'What the settings do',
      bullets: [
        { term: 'Your Themes', text: 'Every theme installed on your device. Tap one to use it right away.' },
        { term: 'The pencil icon', text: 'Opens an edit menu for that theme. For themes you built yourself, you can change the accent color, roundness, and particles. For any theme with a wallpaper, you can also tune the glass (blur/opacity) here. Built-in themes are otherwise locked — make a copy via "Build New Theme with Claude" if you want to change more.' },
        { term: 'Theme cycle', text: 'Configured from the status bar widget editor (tap the gear in the status bar → the pencil next to "Theme"). Themes in the cycle rotate when you tap the theme pill at the bottom.' },
        { term: 'Reduce Visual Effects', text: 'Turns off particles, glass blur, and animations. Use this if the app feels slow or if movement bothers you. Glass blur sliders are automatically disabled while this is on.' },
        { term: 'Message Timestamps', text: 'Shows the time each chat message was sent inside the bubble.' },
        { term: 'Browse Theme Marketplace', text: 'Open the gallery of themes other people have made and shared. Free to install.' },
        { term: 'Build New Theme with Claude', text: "Asks Claude to create a brand-new theme just by describing what you want in plain English (e.g. 'a soft sage green theme with rounded corners')." },
      ],
    },
    {
      heading: 'Common issues',
      bullets: [
        { term: 'Theme looks broken or colors are missing', text: "The theme file may be corrupted. Switch back to a built-in theme (Light/Dark/Midnight/Crème) first, then try the broken one again." },
        { term: 'App feels slow or laggy', text: 'Turn on "Reduce Visual Effects". Particles and glass blur use the most power — disabling them usually fixes it instantly.' },
        { term: "Can't edit most of a theme", text: "Only themes you made yourself can have their accent/roundness/particles changed. Built-in themes are read-only aside from glass tuning. Tap 'Build New Theme with Claude' to make your own copy." },
        { term: "Theme cycle isn't switching", text: 'Open the status bar widget editor and use the pencil next to "Theme" to pick at least 2 themes for the cycle.' },
        { term: 'Custom font not showing', text: "DestinCode reads fonts installed on your computer. If the font you want isn't installed system-wide, it can't be selected here. Install it through your operating system first." },
        { term: 'Published theme not appearing in marketplace', text: 'Theme submissions are reviewed before they go live. Yours should appear within a day or two if it passes the safety checks.' },
      ],
    },
  ],
};

const PARTICLE_OPTIONS = ['none', 'rain', 'dust', 'ember', 'snow', 'custom'] as const;

function roundnessToShape(value: number) {
  const sm  = Math.round(value * 8);
  const md  = Math.round(value * 16);
  const lg  = Math.round(value * 24);
  const xl  = Math.round(value * 32);
  const xxl = Math.min(Math.round(value * 48), 36); // cap at 36px to prevent bubble content clipping
  return { 'radius-sm': `${sm}px`, 'radius-md': `${md}px`, 'radius-lg': `${lg}px`, 'radius-xl': `${xl}px`, 'radius-2xl': `${xxl}px`, 'radius-full': '9999px' };
}

interface Props { onClose: () => void; onSendInput?: (text: string) => void; onOpenMarketplace?: () => void; onPublishTheme?: (slug: string) => void; }

// Small pencil icon used on theme cards to open the per-theme edit panel.
const PencilIcon = ({ className = 'w-3 h-3' }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
  </svg>
);

export default function ThemeScreen({ onClose, onSendInput, onOpenMarketplace, onPublishTheme }: Props) {
  const { allThemes, theme: activeSlug, setTheme, reducedEffects, setReducedEffects, showTimestamps, setShowTimestamps, setGlassOverride } = useTheme();
  // Flips the popup body to the plain-language explainer view via the (i) icon.
  const [showInfo, setShowInfo] = useState(false);
  // Slug of the theme currently being edited (pencil opened). Null = main list.
  const [editingSlug, setEditingSlug] = useState<string | null>(null);

  // Open edit view for a theme. We also activate it so edits preview live
  // behind the popup — users expect to see changes as they drag sliders.
  const openEditor = (slug: string) => {
    if (slug !== activeSlug) setTheme(slug);
    setEditingSlug(slug);
  };

  const editingTheme = editingSlug ? allThemes.find(t => t.slug === editingSlug) ?? null : null;

  if (showInfo) {
    return (
      <SettingsExplainer
        title="Appearance"
        intro={APPEARANCE_EXPLAINER.intro}
        sections={APPEARANCE_EXPLAINER.sections}
        onBack={() => setShowInfo(false)}
        onClose={onClose}
      />
    );
  }

  if (editingTheme) {
    return (
      <ThemeEditView
        theme={editingTheme}
        reducedEffects={reducedEffects}
        setGlassOverride={setGlassOverride}
        onPublishTheme={onPublishTheme}
        onBack={() => setEditingSlug(null)}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <h2 className="text-sm font-bold text-fg">Themes</h2>
        <div className="flex items-center gap-1">
          <InfoIconButton onClick={() => setShowInfo(true)} />
          <button onClick={onClose} className="text-fg-muted hover:text-fg-2 text-lg leading-none w-6 h-6 flex items-center justify-center">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Theme grid — pencil on each card opens the per-theme edit view.
            Cycle membership moved to the status bar widget editor. */}
        <div>
          <p className="text-[9px] text-fg-faint uppercase tracking-wider mb-2">Your Themes</p>
          <div className="grid grid-cols-2 gap-2">
            {allThemes.map(t => {
              const isActive = t.slug === activeSlug;
              return (
                <button
                  key={t.slug}
                  onClick={() => setTheme(t.slug)}
                  className={`relative rounded-lg overflow-hidden border text-left transition-colors ${isActive ? 'border-accent' : 'border-edge-dim hover:border-edge'}`}
                >
                  <div style={{ height: 6, background: `linear-gradient(90deg, ${t.tokens.canvas}, ${t.tokens.accent})` }} />
                  <div className="px-2 py-1.5" style={{ background: t.tokens.canvas }}>
                    <p className="text-[10px] font-medium truncate" style={{ color: t.tokens.fg }}>{t.name}</p>
                    {isActive && <span className="text-[8px]" style={{ color: t.tokens.accent }}>active</span>}
                  </div>
                  {/* Pencil — opens the per-theme edit menu. Color tracks theme fg
                      so it stays legible on both light and dark card backgrounds. */}
                  <button
                    onClick={e => { e.stopPropagation(); openEditor(t.slug); }}
                    className="absolute top-1 right-1 w-5 h-5 rounded-sm flex items-center justify-center hover:bg-black/20 transition-colors"
                    style={{ color: t.tokens.fg }}
                    title="Edit theme"
                    aria-label={`Edit ${t.name}`}
                  >
                    <PencilIcon />
                  </button>
                </button>
              );
            })}
          </div>
        </div>

        {/* Build with Claude — surfaced directly below the grid so users see
            the "make a new one" affordance before the ancillary toggles.
            Follow-up will relocate to the popup header and launch in a new
            session instead of piping into the current one. */}
        <button
          onClick={() => {
            onSendInput?.('/theme-builder ');
            onClose();
          }}
          className="w-full py-2 rounded-lg border border-accent/30 bg-accent/10 text-accent text-xs font-medium hover:bg-accent/20 transition-colors"
        >
          ✦ Build New Theme with Claude
        </button>

        {/* Browse marketplace — paired with Build as the two acquisition paths */}
        {onOpenMarketplace && (
          <button
            onClick={() => {
              onOpenMarketplace();
              onClose();
            }}
            className="w-full py-2 rounded-lg border border-edge-dim bg-panel text-fg-2 text-xs font-medium hover:bg-inset transition-colors"
          >
            Browse Theme Marketplace
          </button>
        )}

        {/* Reduce Visual Effects — always on the main screen (accessibility/perf toggle).
            Global: disables particles, forces blur to 0, shortens animations. Previously
            this was nested inside the wallpaper-only Glass section, hiding it from users
            on solid/gradient themes who also benefit from the accessibility setting. */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-fg-2">Reduce Visual Effects</p>
            <p className="text-[10px] text-fg-faint">Disables particles, blur, and animations</p>
          </div>
          <button
            onClick={() => setReducedEffects(!reducedEffects)}
            className={`w-9 h-5 rounded-full transition-colors relative ${reducedEffects ? 'bg-accent' : 'bg-edge'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${reducedEffects ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
        </div>

        {/* Message timestamps toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-fg-2">Message Timestamps</p>
            <p className="text-[10px] text-fg-faint">Show time sent in each chat bubble</p>
          </div>
          <button
            onClick={() => setShowTimestamps(!showTimestamps)}
            className={`w-9 h-5 rounded-full transition-colors relative ${showTimestamps ? 'bg-accent' : 'bg-edge'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${showTimestamps ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
        </div>
      </div>
    </div>
  );
}

// Per-theme edit view — opened via the pencil on a theme card.
// - User themes: accent / roundness / particles / publish, plus glass if wallpaper
// - Built-in or community themes: glass only (accent/roundness/particles are locked)
interface EditProps {
  theme: LoadedTheme;
  reducedEffects: boolean;
  setGlassOverride: (slug: string, field: string, v: number) => void;
  onPublishTheme?: (slug: string) => void;
  onBack: () => void;
  onClose: () => void;
}

function ThemeEditView({ theme, reducedEffects, setGlassOverride, onPublishTheme, onBack, onClose }: EditProps) {
  const accentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUserTheme = theme.source === 'user';
  const hasWallpaper = theme.background?.type === 'image';
  const hasGradient = theme.background?.type === 'gradient';
  // Pre-baked terminal-value asset already has blur/brightness cooked in — the
  // runtime-filter slider wouldn't affect it, so hide those two sliders.
  const hasBakedTerminalBg = hasWallpaper && !!theme.background?.['terminal-value'];
  const canTuneTerminalOpacity = hasWallpaper || hasGradient;
  const canTuneTerminalFilter = hasWallpaper && !hasBakedTerminalBg;

  const updateAccent = useCallback((hex: string) => {
    if (!isUserTheme) return;
    if (accentTimerRef.current) clearTimeout(accentTimerRef.current);
    accentTimerRef.current = setTimeout(() => {
      const onAccent = computeOnAccent(hex);
      const updated = { ...theme, tokens: { ...theme.tokens, accent: hex, 'on-accent': onAccent } };
      (window as any).claude?.theme?.writeFile?.(theme.slug, JSON.stringify(updated, null, 2));
    }, 150);
  }, [theme, isUserTheme]);

  const updateRoundness = useCallback((value: number) => {
    if (!isUserTheme) return;
    const shape = roundnessToShape(value);
    const updated = { ...theme, shape };
    (window as any).claude?.theme?.writeFile?.(theme.slug, JSON.stringify(updated, null, 2));
  }, [theme, isUserTheme]);

  const updateParticles = useCallback((preset: string) => {
    if (!isUserTheme) return;
    const updated = { ...theme, effects: { ...(theme.effects ?? {}), particles: preset as any } };
    (window as any).claude?.theme?.writeFile?.(theme.slug, JSON.stringify(updated, null, 2));
  }, [theme, isUserTheme]);

  // Glass fields are writable for user themes (persisted to the theme file)
  // and overridable via localStorage for built-in/community themes.
  const updateBackground = useCallback((field: string, value: number) => {
    if (!isUserTheme) return;
    const updated = { ...theme, background: { ...(theme.background ?? { type: 'solid' as const, value: 'transparent' }), [field]: value } };
    (window as any).claude?.theme?.writeFile?.(theme.slug, JSON.stringify(updated, null, 2));
  }, [theme, isUserTheme]);

  const setGlassField = (field: string, v: number) => {
    if (isUserTheme) updateBackground(field, v);
    else setGlassOverride(theme.slug, field, v);
  };

  const currentRoundness = (() => {
    const md = theme.shape?.['radius-md'];
    if (!md) return 0.5;
    return Math.min(parseInt(md) / 16, 1);
  })();

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onBack}
            className="text-fg-muted hover:text-fg-2 text-sm leading-none w-6 h-6 flex items-center justify-center shrink-0"
            title="Back"
            aria-label="Back to themes"
          >
            ←
          </button>
          <h2 className="text-sm font-bold text-fg truncate">Edit: {theme.name}</h2>
        </div>
        <button onClick={onClose} className="text-fg-muted hover:text-fg-2 text-lg leading-none w-6 h-6 flex items-center justify-center shrink-0">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Locked banner for non-user themes so it's clear why most controls are absent */}
        {!isUserTheme && (
          <p className="text-[10px] text-fg-faint bg-inset border border-edge-dim rounded-md px-2.5 py-1.5 leading-relaxed">
            Built-in themes are locked. Only glass + terminal transparency sliders are customizable. Use "Build New Theme with Claude" to make an editable copy.
          </p>
        )}

        {/* User-theme-only controls */}
        {isUserTheme && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-2">Accent</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={theme.tokens.accent}
                  onChange={e => updateAccent(e.target.value)}
                  className="w-6 h-6 rounded-sm cursor-pointer border-0 bg-transparent"
                />
                <span className="text-[10px] text-fg-muted font-mono">{theme.tokens.accent}</span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-fg-2">Roundness</span>
              <div className="flex items-center gap-2 flex-1">
                <span className="text-[10px] text-fg-faint">□</span>
                <input
                  type="range" min="0" max="1" step="0.05"
                  defaultValue={currentRoundness}
                  onChange={e => updateRoundness(parseFloat(e.target.value))}
                  className="flex-1 accent-accent"
                />
                <span className="text-[10px] text-fg-faint">◯</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-2">Particles</span>
              <select
                value={theme.effects?.particles ?? 'none'}
                onChange={e => updateParticles(e.target.value)}
                className="bg-inset text-fg-2 text-[10px] rounded-sm border border-edge-dim px-2 py-0.5"
              >
                {PARTICLE_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
        )}

        {/* Glass — only for themes with a wallpaper (image background). Solid/gradient
            themes render opaque chrome so the sliders do nothing on them. Blur sliders
            are greyed when Reduce Visual Effects is on (the engine forces blur:0). */}
        {hasWallpaper && (
          <div>
            <p className="text-[9px] text-fg-faint uppercase tracking-wider mb-2">Glass</p>
            {reducedEffects && (
              <p className="text-[10px] text-fg-faint bg-inset border border-edge-dim rounded-md px-2.5 py-1.5 mb-2 leading-relaxed">
                Reduce Visual Effects is active — blur is disabled. Opacity still applies.
              </p>
            )}
            <div className="space-y-3">
              <GlassSlider
                label="Panel Blur"
                min={0} max={30} step={1}
                value={theme.background?.['panels-blur'] ?? 24}
                disabled={reducedEffects}
                onChange={v => setGlassField('panels-blur', v)}
                format={v => String(Math.round(v))}
              />
              <GlassSlider
                label="Panel Opacity"
                min={0.3} max={1} step={0.02}
                value={theme.background?.['panels-opacity'] ?? 0.88}
                onChange={v => setGlassField('panels-opacity', v)}
                format={v => `${Math.round(v * 100)}%`}
              />
              <GlassSlider
                label="Bubble Blur"
                min={0} max={24} step={1}
                value={theme.background?.['bubble-blur'] ?? 16}
                disabled={reducedEffects}
                onChange={v => setGlassField('bubble-blur', v)}
                format={v => String(Math.round(v))}
              />
              <GlassSlider
                label="Bubble Opacity"
                min={0.3} max={1} step={0.02}
                value={theme.background?.['bubble-opacity'] ?? 0.88}
                onChange={v => setGlassField('bubble-opacity', v)}
                format={v => `${Math.round(v * 100)}%`}
              />
            </div>
          </div>
        )}

        {/* Terminal — transparency knobs for TerminalView. Opacity applies to
            any see-through background (wallpaper OR gradient). Blur + brightness
            are runtime-CSS-filter on the wallpaper layer, so they're hidden when
            the theme ships a pre-baked `terminal-value` asset (bake dictates
            those values) or when there's no wallpaper to blur. */}
        {canTuneTerminalOpacity && (
          <div>
            <p className="text-[9px] text-fg-faint uppercase tracking-wider mb-2">Terminal</p>
            {canTuneTerminalFilter && reducedEffects && (
              <p className="text-[10px] text-fg-faint bg-inset border border-edge-dim rounded-md px-2.5 py-1.5 mb-2 leading-relaxed">
                Reduce Visual Effects is active — wallpaper blur is disabled. Opacity + brightness still apply.
              </p>
            )}
            {hasBakedTerminalBg && (
              <p className="text-[10px] text-fg-faint bg-inset border border-edge-dim rounded-md px-2.5 py-1.5 mb-2 leading-relaxed">
                This theme ships a pre-blurred terminal wallpaper — blur + brightness are baked in. Only opacity is adjustable here.
              </p>
            )}
            <div className="space-y-3">
              <GlassSlider
                label="Terminal Opacity"
                min={0.3} max={1} step={0.02}
                value={theme.background?.['terminal-opacity'] ?? 0.6}
                onChange={v => setGlassField('terminal-opacity', v)}
                format={v => `${Math.round(v * 100)}%`}
              />
              {canTuneTerminalFilter && (
                <>
                  <GlassSlider
                    label="Wallpaper Blur"
                    min={0} max={30} step={1}
                    value={theme.background?.['terminal-blur'] ?? 8}
                    disabled={reducedEffects}
                    onChange={v => setGlassField('terminal-blur', v)}
                    format={v => String(Math.round(v))}
                  />
                  <GlassSlider
                    label="Wallpaper Brightness"
                    min={0.5} max={1.2} step={0.02}
                    value={theme.background?.['terminal-brightness'] ?? 0.86}
                    onChange={v => setGlassField('terminal-brightness', v)}
                    format={v => `${Math.round(v * 100)}%`}
                  />
                </>
              )}
            </div>
          </div>
        )}

        {/* Publish — user themes only */}
        {isUserTheme && onPublishTheme && (
          <button
            onClick={() => {
              onPublishTheme(theme.slug);
              onClose();
            }}
            className="w-full py-1.5 rounded-lg border border-edge-dim text-fg-2 text-[10px] font-medium hover:bg-inset transition-colors"
          >
            Publish to Marketplace
          </button>
        )}
      </div>
    </div>
  );
}

// Single glass slider row — greys out when disabled and shows the formatted value.
function GlassSlider({
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
      <span className="text-xs text-fg-2 shrink-0">{label}</span>
      <div className="flex items-center gap-2 flex-1">
        <input
          type="range" min={min} max={max} step={step}
          value={value}
          disabled={disabled}
          onChange={e => onChange(parseFloat(e.target.value))}
          className="flex-1 accent-accent"
        />
        <span className="text-[10px] text-fg-muted w-9 text-right">{format(value)}</span>
      </div>
    </div>
  );
}
