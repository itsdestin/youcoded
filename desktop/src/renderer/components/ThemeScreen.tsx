import React, { useCallback, useRef } from 'react';
import { useTheme } from '../state/theme-context';
import { computeOnAccent } from '../themes/theme-validator';

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
  const { allThemes, theme: activeSlug, setTheme, cycleList, setCycleList, font, activeTheme, reducedEffects, setReducedEffects } = useTheme();
  const accentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const currentRoundness = (() => {
    const md = activeTheme?.shape?.['radius-md'];
    if (!md) return 0.5;
    return Math.min(parseInt(md) / 16, 1);
  })();

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <h2 className="text-sm font-bold text-fg">Themes</h2>
        <button onClick={onClose} className="text-fg-muted hover:text-fg-2 text-lg leading-none">✕</button>
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

        {/* Visual effects toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-fg-2">Reduce Visual Effects</p>
            <p className="text-[10px] text-fg-faint">Disables particles, glassmorphism, and animations</p>
          </div>
          <button
            onClick={() => setReducedEffects(!reducedEffects)}
            className={`w-9 h-5 rounded-full transition-colors relative ${reducedEffects ? 'bg-accent' : 'bg-edge'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${reducedEffects ? 'left-[18px]' : 'left-0.5'}`} />
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
