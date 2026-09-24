import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../state/theme-context';
import { useMarketplace } from '../state/marketplace-context';
import FavoriteStar from './marketplace/FavoriteStar';
import { computeOnAccent } from '../themes/theme-validator';
import SettingsExplainer, { type ExplainerSection } from './SettingsExplainer';
import type { LoadedTheme } from '../themes/theme-types';
import { themePreviewSrc } from '../themes/builtin/previews';
import { TERMINAL_WALLPAPER_OPACITY_FLOOR } from '../themes/theme-engine';
import { roundnessToShape, themeRoundness } from '../themes/look-overrides';
import { LookSettings, LookSlider, SECTION_LABEL } from './appearance/LookSettings';
import { useEscClose } from '../hooks/use-esc-close';
import { Button, Select, Toggle, SettingRow } from './ui';

// Plain-language explainer for the Appearance popup. Shown when the user taps
// the (i) icon in the popup header — see ThemeScreen's `showInfo` state.
const APPEARANCE_EXPLAINER: { intro: string; sections: ExplainerSection[] } = {
  intro:
    "Appearance lets you customize how YouCoded looks — colors, fonts, animations, and visual effects. You can use a built-in theme, download one from the marketplace, or build your own just by describing it to Claude.",
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
        { term: 'Look', text: "Your own layout, glass, bubble shape, message box and roundness, applied to every theme. Each one starts on \"Theme's choice\", which keeps the theme exactly as its author made it. Change one and it applies to every theme until you set it back." },
        { term: 'Glass', text: 'How see-through the panels and bubbles are over a wallpaper. Clear, Frosted and Solid are one-tap choices; Fine-tune sets each blur and see-through level yourself. Themes without a wallpaper are not affected.' },
        { term: 'The pencil icon', text: 'Appears on themes you built yourself. It opens an edit menu for that theme: accent color, roundness, particles, glass, and publishing it to the marketplace.' },
        { term: 'Theme cycle', text: 'Configured from the status bar widget editor (tap the gear in the status bar → the pencil next to "Theme"). Themes in the cycle rotate when you tap the theme pill at the bottom.' },
        { term: 'Reduce Visual Effects', text: 'Turns off particles, glass blur, and animations. Use this if the app feels slow or if movement bothers you. Glass blur sliders are automatically disabled while this is on.' },
        { term: 'Message Timestamps', text: 'Shows the time each chat message was sent inside the bubble.' },
        { term: 'Browse Marketplace', text: 'Open the gallery of themes other people have made and shared. Free to install.' },
        { term: 'Build New Theme', text: "Asks Claude to create a brand-new theme just by describing what you want in plain English (e.g. 'a soft sage green theme with rounded corners')." },
      ],
    },
    {
      heading: 'Common issues',
      bullets: [
        { term: 'Theme looks broken or colors are missing', text: "The theme file may be corrupted. Switch back to a built-in theme (Light/Dark/Midnight/Crème) first, then try the broken one again." },
        { term: 'App feels slow or laggy', text: 'Turn on "Reduce Visual Effects". Particles and glass blur use the most power — disabling them usually fixes it instantly.' },
        { term: "Can't edit most of a theme", text: "Only themes you made yourself can be edited. For any other theme, use the Look settings, which apply to every theme, or tap 'Build New Theme' to make your own copy." },
        { term: "Theme cycle isn't switching", text: 'Open the status bar widget editor and use the pencil next to "Theme" to pick at least 2 themes for the cycle.' },
        { term: 'Custom font not showing', text: "YouCoded reads fonts installed on your computer. If the font you want isn't installed system-wide, it can't be selected here. Install it through your operating system first." },
        { term: 'Published theme not appearing in marketplace', text: 'Theme submissions are reviewed before they go live. Yours should appear within a day or two if it passes the safety checks.' },
      ],
    },
  ],
};

const PARTICLE_OPTIONS = ['none', 'rain', 'dust', 'ember', 'snow', 'custom'] as const;

// Shape PARTICLE_OPTIONS for the shared <Select> (change 21). Labels stay the
// raw preset names so the visible text is unchanged from the old <option> list.
const PARTICLE_SELECT_OPTIONS = PARTICLE_OPTIONS.map((p) => ({ value: p, label: p }));

/** The particle choices to offer for a theme whose preset is `current`.
 *
 *  WHY (2026-09-23, roadmap themes, bug 5 of the 2026-07-19 input-migration
 *  family): a theme file can carry a preset that is not in the list (hand-made,
 *  built by Claude, or from a newer app). The dropdown then matched nothing and
 *  showed the empty "Select…" placeholder, so it read as unset and the next
 *  pick replaced it. The theme's own value is kept as an extra choice, exactly
 *  as written, so it shows as selected and survives untouched unless the user
 *  picks something else. */
export function particleSelectOptions(current: unknown): { value: string; label: string }[] {
  if (typeof current !== 'string' || !current.trim()) return PARTICLE_SELECT_OPTIONS;
  if (PARTICLE_SELECT_OPTIONS.some((o) => o.value === current)) return PARTICLE_SELECT_OPTIONS;
  return [...PARTICLE_SELECT_OPTIONS, { value: current, label: current }];
}

interface Props {
  onClose: () => void;
  onSendInput?: (text: string) => void;
  /** Run a slash command through the dispatcher rather than piping raw text at a
   *  PTY. Native sessions have no PTY, so onSendInput silently did nothing there
   *  — this button was fully dead in a YouCoded-runtime session (handoff §2.3,
   *  "the single most visible instance of the gap M3 closes"). */
  onRunCommand?: (command: string) => void;
  onOpenMarketplace?: () => void;
  onPublishTheme?: (slug: string) => void;
  /**
   * K12: `showInfo` is LIFTED to the Dialog owner rather than held here.
   *
   * This component fills a Dialog it does not own, so it cannot reach the
   * shell's header to set the explainer's title and back chevron. The host
   * holds the boolean, sets `title`/`onBack`/`scrollBody` from it, and passes
   * it back down — which is what lets the explainer drop its hand-rolled
   * header instead of reimplementing the one D1 already owns.
   */
  showInfo: boolean;
  /**
   * Lifted for the same reason as `showInfo`: the Dialog's header has to name
   * the theme being edited and offer the way back, and this component cannot
   * reach a Dialog it does not own.
   */
  editingSlug: string | null;
  onEditSlug: (slug: string | null) => void;
}

// Small pencil icon used on theme cards to open the per-theme edit panel.
// The top of a theme card: the theme's preview picture (built-ins ship theirs; community
// and user themes serve preview.png from their folder). If the picture cannot load — no
// preview.png, or a remote client that cannot resolve theme-asset:// — the card falls
// back to the token gradient the cards used to show, so nothing is ever blank.
// Only the user's own themes have an edit menu now. WHY (2026-09-24): the per-theme
// glass tweaks that gave built-in and marketplace themes a pencil were retired in
// favour of one global Look (appearance-panel-questions AP-3), which left their
// pencil with nothing behind it — so it is not drawn at all, rather than greyed on
// nearly every card.
function canCustomize(theme: LoadedTheme): boolean {
  return theme.source === 'user';
}

function ThemePreviewStrip({ theme }: { theme: LoadedTheme }) {
  const [failed, setFailed] = useState(false);
  const src = themePreviewSrc(theme);
  if (!src || failed) {
    return <div className="absolute inset-x-0 top-0 h-[72px]" style={{ background: `linear-gradient(90deg, ${theme.tokens.canvas}, ${theme.tokens.accent})` }} aria-hidden="true" />;
  }
  return <img src={src} alt="" className="absolute inset-x-0 top-0 h-[72px] w-full object-cover object-top" onError={() => setFailed(true)} />;
}

const PencilIcon = ({ className = 'w-3 h-3' }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
  </svg>
);

// WHY: `onShowInfo` was lifted to the Dialog owner (SettingsPanel ThemeButton)
// in D1 — the owner renders the (i) button into the header via `headerActions`.
// ThemeScreen only reads the boolean; it never needs to flip it. Removing the
// unused prop + `InfoIconButton` import found by the 2026-08-06 sweep.
export default function ThemeScreen({ onClose, onSendInput, onRunCommand, onOpenMarketplace, onPublishTheme, showInfo, editingSlug, onEditSlug }: Props) {
  // Always mounted when open (parent conditionally renders) — so open=true is correct here.
  useEscClose(true, onClose);
  const { allThemes, activeTheme, theme: activeSlug, setTheme, reducedEffects, setReducedEffects, showTimestamps, setShowTimestamps, lookOverrides } = useTheme();
  // MarketplaceContext supplies favorites and the toggle action.
  const mp = useMarketplace();
  const themeFavSet = useMemo(() => new Set(mp.themeFavorites), [mp.themeFavorites]);

  // Appearance panel shows favorites only, plus the active theme as a fallback
  // so there's always at least one card even when the user has unstarred their
  // current theme. The full installed list lives in Your Library › Themes.
  const gridThemes = useMemo(() => {
    const favs = allThemes.filter(t => themeFavSet.has(t.slug));
    if (favs.some(t => t.slug === activeSlug)) return favs;
    const active = allThemes.find(t => t.slug === activeSlug);
    return active ? [...favs, active] : favs;
  }, [allThemes, themeFavSet, activeSlug]);

  // The favorites box scrolls inside itself, and the active theme is appended LAST
  // when it is not a favorite — so it can sit hidden below the box's edge. Bring it
  // into view. Keyed on the list (NOT mount-only): favorites arrive a moment after
  // the panel opens, and that is what pushes the active card down. It stops for good
  // once the user touches the box, so it never yanks a list they are browsing.
  const favBoxRef = useRef<HTMLDivElement>(null);
  const userScrolledFavs = useRef(false);
  useLayoutEffect(() => {
    const box = favBoxRef.current;
    const card = box?.querySelector<HTMLElement>('[data-active-theme]');
    if (!box || !card || userScrolledFavs.current) return;
    const top = card.offsetTop; // the box is `relative`, so this is measured from its top
    if (top + card.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top;
  }, [gridThemes]);
  const markFavsTouched = () => { userScrolledFavs.current = true; };

  // Slug of the theme currently being edited (pencil opened). Null = main list.

  // Open edit view for a theme. We also activate it so edits preview live
  // behind the popup — users expect to see changes as they drag sliders.
  const openEditor = (slug: string) => {
    if (slug !== activeSlug) setTheme(slug);
    onEditSlug(slug);
  };

  // The RAW theme, never activeTheme: activeTheme carries the user's global Look
  // overrides, and the editor writes the object it is given back to the theme
  // file — reading activeTheme would bake those overrides into the theme.
  const editingTheme = editingSlug ? allThemes.find(t => t.slug === editingSlug) ?? null : null;

  if (showInfo) {
    // Header + scroll body come from the Dialog above this component now.
    return <SettingsExplainer intro={APPEARANCE_EXPLAINER.intro} sections={APPEARANCE_EXPLAINER.sections} />;
  }

  if (editingTheme) {
    return (
      <ThemeEditView
        theme={editingTheme}
        reducedEffects={reducedEffects}
        overridden={{ glass: !!lookOverrides.glass, roundness: lookOverrides.roundness !== undefined }}
        onPublishTheme={onPublishTheme}
        onClose={onClose}
      />
    );
  }

  return (
    // D1: header, close and scroll body come from the Dialog. The body keeps
    // space-y-4 rather than the shell's space-y-5 — the theme grid is dense on
    // purpose — but takes the shell's px-4 py-4 in place of its own p-3.
    // Three headed sections (2026-09-24): Themes · Look · Effects & chat. Before,
    // it was one unlabelled column, and the new Look settings would have made it a
    // long list with no signposts.
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className={SECTION_LABEL}>Themes</h3>
        {/* Favorites box (appearance-panel-questions AP-6): about two rows of cards
            (4 themes) and it scrolls inside itself, so starring many themes never
            pushes the settings below out of reach. max-h-52 = 208px = two h-24 rows
            plus the gap and a sliver of the third row, which says "there is more".
            data-guide-anchor: the first-run tour's "make it yours" stop rings the grid. */}
        <div ref={favBoxRef} onWheel={markFavsTouched} onPointerDown={markFavsTouched} onTouchStart={markFavsTouched} className="relative max-h-52 overflow-y-auto overscroll-contain rounded-lg" aria-label="Favorited themes">
          <div className="grid grid-cols-2 gap-2" data-guide-anchor="theme-grid">
            {gridThemes.map(t => {
              const isActive = t.slug === activeSlug;
              const isFav = themeFavSet.has(t.slug);
              return (
                // Fix: outer element is div+role=button (not <button>) so the
                // nested pencil and star buttons are valid HTML (no button-in-button).
                <div
                  key={t.slug}
                  data-active-theme={isActive || undefined}
                  role="button"
                  tabIndex={0}
                  onClick={() => setTheme(t.slug)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTheme(t.slug); } }}
                  // Change 22 reaches these tiles ONLY as a focus ring. They are
                  // deliberately NOT .layer-surface: the tile paints the
                  // *previewed* theme's own tokens inline, so painting the
                  // active theme's panel over it would defeat the preview.
                  // They were the only keyboard-reachable control in this file
                  // with no focus indication at all.
                  // Phase C P-3 #1 (Destin, 2026-08-27): every card is the same fixed
                  // height — the height the active card used to grow to — and the
                  // top is the theme's preview picture (the same one Marketplace and
                  // Library cards show). Before, only the active card had a second
                  // row ("active"), so its row-mate stretched to match and showed an
                  // empty strip with a floating pencil. Now nothing ever grows: name,
                  // "active" and the pencil share ONE row at the bottom.
                  // Round 2 (2026-08-27): h-24 instead of h-16 so the preview shows a real slice of
                  // the mock chat, not a sliver; `group` lets the star appear only on hover.
                  className={`group relative h-24 rounded-lg overflow-hidden border text-left transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${isActive ? 'border-accent' : 'border-edge-dim hover:border-edge'}`}
                  style={{ background: t.tokens.canvas }}
                >
                  <ThemePreviewStrip theme={t} />
                  <div className="absolute inset-x-0 bottom-0 h-6 flex items-center gap-1.5 pl-2 pr-1" style={{ background: t.tokens.canvas }}>
                    <p className="text-3xs font-medium truncate flex-1 min-w-0" style={{ color: t.tokens.fg }}>{t.name}</p>
                    {isActive && <span className="text-4xs shrink-0" style={{ color: t.tokens.accent }}>active</span>}
                  {/* Pencil — opens the edit menu, on the user's own themes only (see canCustomize). */}
                  {canCustomize(t) && (
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); openEditor(t.slug); }}
                    // Change 41: `bg-current` resolves to the inline `color` below,
                    // i.e. the previewed theme's own fg, so the hover is legible on
                    // a light and a dark swatch alike.
                    className="w-5 h-5 shrink-0 rounded-sm flex items-center justify-center coarse-hit transition-colors hover:bg-current/15"
                    style={{ color: t.tokens.fg }}
                    title="Edit theme"
                    aria-label={`Edit ${t.name}`}
                  >
                    <PencilIcon />
                  </button>
                  )}
                  </div>
                  {/* Star — toggles this theme in/out of the Appearance panel favorites.
                      Round 2 (Destin, 2026-08-27): hidden until the card is hovered or the
                      star itself has keyboard focus, so the preview picture stays clean. */}
                  <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <FavoriteStar
                      filled={isFav}
                      onToggle={() => mp.favoriteTheme(t.slug, !isFav).catch(() => {})}
                      size="sm"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Browse + Build side by side: the Themes section stays short so Look is
            visible without scrolling. Build stays the filled one (spec change 63). */}
        <div className="grid grid-cols-2 gap-2">
        {/* Browse marketplace — above Build (Destin, Phase C P-3 #3, 2026-08-27):
            the old "Browse all themes →" button is gone; it opened Your Library ›
            Themes and read as a duplicate of this one. Installed themes are one
            click away in the Library; this button is how you get MORE. */}
        {onOpenMarketplace && (
          <Button
            variant="secondary"
            onClick={() => {
              onOpenMarketplace();
              onClose();
            }}
            className="w-full py-2"
          >
            Browse Marketplace
          </Button>
        )}

        {/* Build with Claude — surfaced directly below the grid so users see
            the "make a new one" affordance before the ancillary toggles.
            Follow-up will relocate to the popup header and launch in a new
            session instead of piping into the current one.

            Now a filled `primary` (spec change 63). It used to be an accent-tinted
            OUTLINE (border-accent/30 + bg-accent/10 + text-accent) — a 5th button
            style that the shared Button doesn't have and that we don't want to add.
            Filling it keeps Build visually stronger than Browse (secondary) below,
            which is the hierarchy the tinted outline was there to create. */}
        <Button
          onClick={() => {
            // Per Q5 (Destin, 2026-07-28): run in the CURRENT session, not a new
            // one. onRunCommand routes through the slash dispatcher, which knows
            // how to reach a native session's harness; onSendInput is the legacy
            // raw-PTY path and is kept only as a fallback for callers that have
            // not been rewired.
            if (onRunCommand) onRunCommand('/theme-builder');
            else onSendInput?.('/theme-builder ');
            onClose();
          }}
          className="w-full py-2"
        >
          ✦ Build New Theme
        </Button>
        </div>
      </section>

      <section>
        <h3 className={SECTION_LABEL}>Look</h3>
        <p className="text-3xs text-fg-muted mb-3 leading-relaxed">Applies to every theme. "Theme's choice" keeps each theme as its author made it.</p>
        <LookSettings />
      </section>

      <section className="space-y-1">
        <h3 className={SECTION_LABEL}>Effects &amp; chat</h3>


        {/* Reduce Visual Effects — always on the main screen (accessibility/perf toggle).
            Global: disables particles, forces blur to 0, shortens animations. Previously
            this was nested inside the wallpaper-only Glass section, hiding it from users
            on solid/gradient themes who also benefit from the accessibility setting. */}
        <SettingRow
          variant="item"
          title="Reduce Visual Effects"
          description="Disables particles, blur, and animations"
          control={
            // Was a hand-rolled 36x20 switch (change 15): same geometry, but the
            // shared Toggle also carries role="switch" + aria-checked, which this
            // one never had — a screen reader read it as an unlabelled button.
            <Toggle
              checked={reducedEffects}
              onChange={(next) => setReducedEffects(next)}
              aria-label="Reduce Visual Effects"
            />
          }
        />

        {/* Message timestamps toggle */}
        <SettingRow
          variant="item"
          title="Message Timestamps"
          description="Show time sent in each chat bubble"
          // Same migration as the toggle above (change 15).
          control={
            <Toggle
              checked={showTimestamps}
              onChange={(next) => setShowTimestamps(next)}
              aria-label="Message Timestamps"
            />
          }
        />
      </section>
    </div>
  );
}

// Theme edit view — opened via the pencil, which only the user's OWN themes have
// (canCustomize). Everything here writes the theme file itself: accent, roundness,
// particles, glass, terminal, publish. Built-in and marketplace themes lost their
// glass-only version of this view when per-theme tweaks were retired (2026-09-24).
interface EditProps {
  /** The RAW theme (no global Look overrides applied) — it is written back to disk. */
  theme: LoadedTheme;
  reducedEffects: boolean;
  /** Which of this editor's settings the user's global Look is currently overriding.
   *  Their sliders are greyed with a line saying why (appearance-panel-questions AP-3:
   *  the global setting wins while it is on). */
  overridden: { glass: boolean; roundness: boolean };
  onPublishTheme?: (slug: string) => void;
  /** Closes the popup after publishing. An ACTION, not header chrome. */
  onClose: () => void;
}

// D1: the "Edit: {name}" title and the back chevron are the Dialog's, driven by
// the same `editingSlug` that selects this view. Its own header reimplemented
// the back arrow as a bare "←" glyph at a third size.
function ThemeEditView({ theme, reducedEffects, overridden, onPublishTheme, onClose }: EditProps) {
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

  // Change 40 (§9.D): the roundness slider is CONTROLLED, but its source of
  // truth (currentRoundness, below) is derived from the theme FILE via an async
  // writeFile — it does not update within a drag. A bare `value={currentRoundness}`
  // would therefore freeze the thumb mid-drag. So we keep a local draft the drag
  // updates instantly, and re-sync it whenever currentRoundness changes for an
  // EXTERNAL reason (switching which theme is being edited) — the exact staleness
  // §9.D flagged. Same draft+resync shape as EngineCard's context knob.
  const [roundnessDraft, setRoundnessDraft] = useState(0.5);

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

  // Glass fields are written to the user's theme file.
  const updateBackground = useCallback((field: string, value: number) => {
    if (!isUserTheme) return;
    const updated = { ...theme, background: { ...(theme.background ?? { type: 'solid' as const, value: 'transparent' }), [field]: value } };
    (window as any).claude?.theme?.writeFile?.(theme.slug, JSON.stringify(updated, null, 2));
  }, [theme, isUserTheme]);

  const setGlassField = updateBackground;

  const currentRoundness = themeRoundness(theme);

  // Re-sync the draft when the underlying theme's roundness changes for a reason
  // other than this slider (e.g. the editor is pointed at a different theme).
  useEffect(() => { setRoundnessDraft(currentRoundness); }, [currentRoundness]);

  return (
    <div className="space-y-4">
        {(overridden.glass || overridden.roundness) && (
          <p className="text-3xs text-fg-muted bg-inset border border-edge-dim rounded-md px-2.5 py-1.5 leading-relaxed">
            Your Look settings are overriding this theme's {overridden.glass && overridden.roundness ? 'glass and roundness' : overridden.glass ? 'glass' : 'roundness'}, so {overridden.glass && overridden.roundness ? 'those sliders are' : 'that slider is'} greyed out. Set {overridden.glass && overridden.roundness ? 'them' : 'it'} back to "Theme's choice" in Look to see this theme's own values.
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
                <span className="text-3xs text-fg-muted font-mono">{theme.tokens.accent}</span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-fg-2">Roundness</span>
              <div className="flex items-center gap-2 flex-1">
                <span className="text-3xs text-fg-faint">□</span>
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={roundnessDraft}
                  disabled={overridden.roundness}
                  onChange={e => { const v = parseFloat(e.target.value); setRoundnessDraft(v); updateRoundness(v); }}
                  className="flex-1 accent-accent"
                />
                <span className="text-3xs text-fg-faint">◯</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-2">Particles</span>
              {/* Was a native <select> (change 21). A native select's option list is
                  drawn by the OS, so the open menu showed the OS blue-highlight
                  styling inside a themed app — styling the closed trigger alone
                  couldn't fix that. <Select> renders the list itself.
                  The width wrapper keeps the row's right-hand control from
                  stretching: the Select trigger is w-full by design. */}
              <div className="w-32 shrink-0">
                <Select
                  size="sm"
                  options={particleSelectOptions(theme.effects?.particles)}
                  value={theme.effects?.particles ?? 'none'}
                  onChange={updateParticles}
                  aria-label="Particles"
                />
              </div>
            </div>
          </div>
        )}

        {/* Glass — themes with an image OR gradient background composite a real layer
            behind the chrome, so blurring/translucency produces a visible effect. Solid
            themes have nothing behind the chrome so the sliders are hidden. Blur sliders
            are greyed when Reduce Visual Effects is on (the engine forces blur:0). */}
        {(hasWallpaper || hasGradient) && (
          <div>
            <p className="text-4xs text-fg-muted uppercase tracking-wider mb-2">Glass</p>
            {reducedEffects && (
              <p className="text-3xs text-fg-muted bg-inset border border-edge-dim rounded-md px-2.5 py-1.5 mb-2 leading-relaxed">
                Reduce Visual Effects is active — blur is disabled. Opacity still applies.
              </p>
            )}
            <div className="space-y-3">
              <LookSlider
                label="Panel Blur"
                min={0} max={30} step={1}
                value={theme.background?.['panels-blur'] ?? 24}
                disabled={reducedEffects || overridden.glass}
                onChange={v => setGlassField('panels-blur', v)}
                format={v => String(Math.round(v))}
              />
              <LookSlider
                label="Panel Opacity"
                min={0.3} max={1} step={0.02}
                value={theme.background?.['panels-opacity'] ?? 0.88}
                disabled={overridden.glass}
                onChange={v => setGlassField('panels-opacity', v)}
                format={v => `${Math.round(v * 100)}%`}
              />
              <LookSlider
                label="Bubble Blur"
                min={0} max={24} step={1}
                value={theme.background?.['bubble-blur'] ?? 16}
                disabled={reducedEffects || overridden.glass}
                onChange={v => setGlassField('bubble-blur', v)}
                format={v => String(Math.round(v))}
              />
              <LookSlider
                label="Bubble Opacity"
                min={0.3} max={1} step={0.02}
                value={theme.background?.['bubble-opacity'] ?? 0.88}
                disabled={overridden.glass}
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
            <p className="text-4xs text-fg-muted uppercase tracking-wider mb-2">Terminal</p>
            {canTuneTerminalFilter && reducedEffects && (
              <p className="text-3xs text-fg-muted bg-inset border border-edge-dim rounded-md px-2.5 py-1.5 mb-2 leading-relaxed">
                Reduce Visual Effects is active — wallpaper blur is disabled. Opacity + brightness still apply.
              </p>
            )}
            {hasBakedTerminalBg && (
              <p className="text-3xs text-fg-muted bg-inset border border-edge-dim rounded-md px-2.5 py-1.5 mb-2 leading-relaxed">
                This theme ships a pre-blurred terminal wallpaper — blur + brightness are baked in. Only opacity is adjustable here.
              </p>
            )}
            <div className="space-y-3">
              {/* Fix (ROADMAP L18): this slider only renders under a wallpaper or
                  gradient (canTuneTerminalOpacity), and there the engine raises
                  any `terminal-opacity` below TERMINAL_WALLPAPER_OPACITY_FLOOR
                  to the floor (P-20.2, computeTerminalSurface). A 30% minimum
                  let the user drag through 50 percentage points of nothing —
                  the terminal did not change and the label lied about it. The
                  minimum is the floor, and the shown value is the EFFECTIVE
                  one (a pack that stored 0.6 reads "80%", which is what it
                  actually paints). Flat themes have no slider at all. */}
              <LookSlider
                label="Terminal Opacity"
                min={TERMINAL_WALLPAPER_OPACITY_FLOOR} max={1} step={0.02}
                value={Math.max(TERMINAL_WALLPAPER_OPACITY_FLOOR, theme.background?.['terminal-opacity'] ?? 0.6)}
                disabled={overridden.glass}
                onChange={v => setGlassField('terminal-opacity', v)}
                format={v => `${Math.round(v * 100)}%`}
              />
              {canTuneTerminalFilter && (
                <>
                  <LookSlider
                    label="Wallpaper Blur"
                    min={0} max={30} step={1}
                    value={theme.background?.['terminal-blur'] ?? 8}
                    disabled={reducedEffects || overridden.glass}
                    onChange={v => setGlassField('terminal-blur', v)}
                    format={v => String(Math.round(v))}
                  />
                  <LookSlider
                    label="Wallpaper Brightness"
                    min={0.5} max={1.2} step={0.02}
                    value={theme.background?.['terminal-brightness'] ?? 0.86}
                    disabled={overridden.glass}
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
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onPublishTheme(theme.slug);
              onClose();
            }}
            className="w-full"
          >
            Publish to Marketplace
          </Button>
        )}
    </div>
  );
}
