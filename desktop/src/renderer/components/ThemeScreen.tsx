import React, { useCallback, useRef, useState } from 'react';
import { useTheme } from '../state/theme-context';
import { computeOnAccent } from '../themes/theme-validator';
import SettingsExplainer, { InfoIconButton, type ExplainerSection } from './SettingsExplainer';

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
        { term: 'The little checkmark', text: 'Adds a theme to your "cycle". Themes in the cycle rotate when you tap the theme pill in the bottom status bar — handy if you like switching looks throughout the day.' },
        { term: 'Edit (only for themes you made)', text: "Built-in themes are locked. To customize colors and shape, make a copy first by tapping 'Build New Theme with Claude'." },
        { term: 'Accent', text: 'The main highlight color used for buttons, links, and active items.' },
        { term: 'Roundness', text: 'How curved the corners of buttons and panels are. Drag left for sharp/square, right for round/pill-shaped.' },
        { term: 'Particles', text: 'Optional floating effects on the background — rain, snow, dust, or ember. Set to "none" to turn them off.' },
        { term: 'Glass (Blur and Opacity)', text: 'Only appears for themes with a wallpaper or gradient background. Controls how see-through and blurry the panels and chat bubbles look on top of the background.' },
        { term: 'Browse Theme Marketplace', text: 'Open the gallery of themes other people have made and shared. Free to install.' },
        { term: 'Reduce Visual Effects', text: 'Turns off particles, glass blur, and animations. Use this if the app feels slow or if movement bothers you.' },
        { term: 'Message Timestamps', text: 'Shows the time each chat message was sent inside the bubble.' },
        { term: 'Build New Theme with Claude', text: "Asks Claude to create a brand-new theme just by describing what you want in plain English (e.g. 'a soft sage green theme with rounded corners')." },
      ],
    },
    {
      heading: 'Common issues',
      bullets: [
        { term: 'Theme looks broken or colors are missing', text: "The theme file may be corrupted. Switch back to a built-in theme (Light/Dark/Midnight/Crème) first, then try the broken one again." },
        { term: 'App feels slow or laggy', text: 'Turn on "Reduce Visual Effects". Particles and glass blur use the most power — disabling them usually fixes it instantly.' },
        { term: "Can't edit a theme", text: "You can only edit themes you made yourself. Built-in themes are read-only. Tap 'Build New Theme with Claude' to make your own copy you can change." },
        { term: "Theme cycle isn't switching", text: 'Make sure you\'ve added at least 2 themes to the cycle (the little checkmark in the corner of each theme card).' },
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

export default function ThemeScreen({ onClose, onSendInput, onOpenMarketplace, onPublishTheme }: Props) {
  const { allThemes, theme: activeSlug, setTheme, cycleList, setCycleList, font, activeTheme, reducedEffects, setReducedEffects, showTimestamps, setShowTimestamps, setGlassOverride } = useTheme();
  const accentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Flips the popup body to the plain-language explainer view via the (i) icon.
  const [showInfo, setShowInfo] = useState(false);

  // NOTE: all hooks below MUST run before the `if (showInfo) return` early
  // return further down. Returning before a hook changes hook count between
  // renders and crashes the whole app with React minified error #300.
  const currentFontName = font.split(',')[0].trim().replace(/^['"]|['"]$/g, '');

  const updateAccent = useCallback((hex: string) => {
    if (!activeTheme || activeTheme.source !== 'user') return;
    if (accentTimerRef.current) clearTimeout(accentTimerRef.current);
    accentTimerRef.current = setTimeout(() => {
      const onAccent = computeOnAccent(hex);
      const updated = { ...activeTheme, tokens: { ...activeTheme.tokens, accent: hex, 'on-accent': onAccent } };
      (window as any).claude?.theme?.writeFile?.(activeTheme.slug, JSON.stringify(updated, null, 2));
    }, 150);
  }, [activeTheme]);

  const updateRoundness = useCallback((value: number) => {
    if (!activeTheme || activeTheme.source !== 'user') return;
    const shape = roundnessToShape(value);
    const updated = { ...activeTheme, shape };
    (window as any).claude?.theme?.writeFile?.(activeTheme.slug, JSON.stringify(updated, null, 2));
  }, [activeTheme]);

  const updateParticles = useCallback((preset: string) => {
    if (!activeTheme || activeTheme.source !== 'user') return;
    const updated = { ...activeTheme, effects: { ...(activeTheme.effects ?? {}), particles: preset as any } };
    (window as any).claude?.theme?.writeFile?.(activeTheme.slug, JSON.stringify(updated, null, 2));
  }, [activeTheme]);

  // Update a single background.* field and persist
  const updateBackground = useCallback((field: string, value: number) => {
    if (!activeTheme || activeTheme.source !== 'user') return;
    const updated = { ...activeTheme, background: { ...(activeTheme.background ?? { type: 'solid' as const, value: 'transparent' }), [field]: value } };
    (window as any).claude?.theme?.writeFile?.(activeTheme.slug, JSON.stringify(updated, null, 2));
  }, [activeTheme]);

  const currentRoundness = (() => {
    const md = activeTheme?.shape?.['radius-md'];
    if (!md) return 0.5;
    return Math.min(parseInt(md) / 16, 1);
  })();

  // Explainer view — swap the popup body. Must live AFTER every hook above.
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <h2 className="text-sm font-bold text-fg">Themes</h2>
        {/* Info icon — reveals the plain-language explainer view */}
        <div className="flex items-center gap-1">
          <InfoIconButton onClick={() => setShowInfo(true)} />
          <button onClick={onClose} className="text-fg-muted hover:text-fg-2 text-lg leading-none w-6 h-6 flex items-center justify-center">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Theme grid */}
        <div>
          <p className="text-[9px] text-fg-faint uppercase tracking-wider mb-2">Your Themes</p>
          <div className="grid grid-cols-2 gap-2">
            {allThemes.map(t => {
              const isActive = t.slug === activeSlug;
              const inCycle = cycleList.includes(t.slug);
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
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      setCycleList(
                        inCycle
                          ? cycleList.filter(s => s !== t.slug).length > 0
                            ? cycleList.filter(s => s !== t.slug)
                            : cycleList
                          : [...cycleList, t.slug]
                      );
                    }}
                    className="absolute top-1 right-1 w-4 h-4 rounded-sm border flex items-center justify-center"
                    style={{ background: inCycle ? t.tokens.accent : 'transparent', borderColor: inCycle ? t.tokens.accent : '#555' }}
                    title={inCycle ? 'Remove from cycle' : 'Add to cycle'}
                  >
                    {inCycle && <span style={{ color: t.tokens['on-accent'], fontSize: 8 }}>✓</span>}
                  </button>
                </button>
              );
            })}
          </div>
        </div>

        {/* Edit controls — only for user themes */}
        {activeTheme && activeTheme.source === 'user' && (
          <div>
            <p className="text-[9px] text-fg-faint uppercase tracking-wider mb-2">Edit: {activeTheme.name}</p>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-fg-2">Accent</span>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={activeTheme.tokens.accent}
                    onChange={e => updateAccent(e.target.value)}
                    className="w-6 h-6 rounded-sm cursor-pointer border-0 bg-transparent"
                  />
                  <span className="text-[10px] text-fg-muted font-mono">{activeTheme.tokens.accent}</span>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-fg-2">Roundness</span>
                <div className="flex items-center gap-2 flex-1">
                  <span className="text-[10px] text-fg-faint">□</span>
                  <input
                    type="range" min="0" max="1" step="0.05"
                    value={currentRoundness}
                    onChange={e => updateRoundness(parseFloat(e.target.value))}
                    className="flex-1 accent-accent"
                  />
                  <span className="text-[10px] text-fg-faint">◯</span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-fg-2">Particles</span>
                <select
                  value={activeTheme.effects?.particles ?? 'none'}
                  onChange={e => updateParticles(e.target.value)}
                  className="bg-inset text-fg-2 text-[10px] rounded-sm border border-edge-dim px-2 py-0.5"
                >
                  {PARTICLE_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              {onPublishTheme && (
                <button
                  onClick={() => {
                    onPublishTheme(activeTheme.slug);
                    onClose();
                  }}
                  className="w-full py-1.5 rounded-lg border border-edge-dim text-fg-2 text-[10px] font-medium hover:bg-inset transition-colors mt-1"
                >
                  Publish to Marketplace
                </button>
              )}
            </div>
          </div>
        )}

        {/* Glass + Reduce Effects — only meaningful for wallpaper themes.
            Solid/gradient themes render opaque chrome (no glass at all), so
            both the sliders AND the Reduce Effects toggle are hidden on them.
            When Reduce Effects is on for a wallpaper theme, blur is forced
            to 0 at the engine level, so we hide the two blur sliders but
            keep the opacity sliders (opacity still works). */}
        {activeTheme?.background?.type === 'image' && (() => {
          const setField = (field: string, v: number) => {
            activeTheme.source === 'user' ? updateBackground(field, v) : setGlassOverride(activeTheme.slug, field, v);
          };
          return (
            <>
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

              <div>
                <p className="text-[9px] text-fg-faint uppercase tracking-wider mb-2">Glass</p>
                <div className="space-y-3">
                  {!reducedEffects && (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-fg-2 shrink-0">Panel Blur</span>
                      <div className="flex items-center gap-2 flex-1">
                        <input
                          type="range" min="0" max="30" step="1"
                          value={activeTheme.background?.['panels-blur'] ?? 24}
                          onChange={e => setField('panels-blur', parseFloat(e.target.value))}
                          className="flex-1 accent-accent"
                        />
                        <span className="text-[10px] text-fg-muted w-7 text-right">{activeTheme.background?.['panels-blur'] ?? 24}</span>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-fg-2 shrink-0">Panel Opacity</span>
                    <div className="flex items-center gap-2 flex-1">
                      <input
                        type="range" min="0.3" max="1" step="0.02"
                        value={activeTheme.background?.['panels-opacity'] ?? 0.88}
                        onChange={e => setField('panels-opacity', parseFloat(e.target.value))}
                        className="flex-1 accent-accent"
                      />
                      <span className="text-[10px] text-fg-muted w-7 text-right">{Math.round((activeTheme.background?.['panels-opacity'] ?? 0.88) * 100)}%</span>
                    </div>
                  </div>
                  {!reducedEffects && (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-fg-2 shrink-0">Bubble Blur</span>
                      <div className="flex items-center gap-2 flex-1">
                        <input
                          type="range" min="0" max="24" step="1"
                          value={activeTheme.background?.['bubble-blur'] ?? 16}
                          onChange={e => setField('bubble-blur', parseFloat(e.target.value))}
                          className="flex-1 accent-accent"
                        />
                        <span className="text-[10px] text-fg-muted w-7 text-right">{activeTheme.background?.['bubble-blur'] ?? 16}</span>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-fg-2 shrink-0">Bubble Opacity</span>
                    <div className="flex items-center gap-2 flex-1">
                      <input
                        type="range" min="0.3" max="1" step="0.02"
                        value={activeTheme.background?.['bubble-opacity'] ?? 0.88}
                        onChange={e => setField('bubble-opacity', parseFloat(e.target.value))}
                        className="flex-1 accent-accent"
                      />
                      <span className="text-[10px] text-fg-muted w-7 text-right">{Math.round((activeTheme.background?.['bubble-opacity'] ?? 0.88) * 100)}%</span>
                    </div>
                  </div>
                </div>
              </div>
            </>
          );
        })()}

        {/* Browse marketplace */}
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

        {/* Build with Claude */}
        <button
          onClick={() => {
            onSendInput?.('/theme-builder ');
            onClose();
          }}
          className="w-full py-2 rounded-lg border border-accent/30 bg-accent/10 text-accent text-xs font-medium hover:bg-accent/20 transition-colors"
        >
          ✦ Build New Theme with Claude
        </button>
      </div>
    </div>
  );
}
