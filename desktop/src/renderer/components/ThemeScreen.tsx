import { useLayoutEffect, useMemo, useRef } from 'react';
import { useTheme } from '../state/theme-context';
import { useMarketplace } from '../state/marketplace-context';
import SettingsExplainer, { type ExplainerSection } from './SettingsExplainer';
import type { LoadedTheme } from '../themes/theme-types';
import { ThemeCard } from './appearance/ThemeCard';
import {
  BubbleSettings, GlassLook, LayoutSettings, ParticleSettings, ResetLook, RoundnessSettings, StackedRow,
} from './appearance/LookSettings';
import { useScrollFade } from '../hooks/useScrollFade';
import { useEscClose } from '../hooks/use-esc-close';
import { Button, CARD_LEVEL_1, SectionLabel, Toggle, SettingRow } from './ui';

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
        { term: 'Your themes', text: 'Every theme installed on your device. Tap one to use it right away.' },
        { term: 'Window, Chat, Glass & effects', text: "Your own layout (which brings its matching message box), roundness, message bubbles, glass and particles, applied to every theme. Each one starts on \"Auto\", which keeps the theme exactly as its author made it. Change one and it applies to every theme until you set it back to Auto." },
        { term: 'Glass', text: 'How see-through the panels and bubbles are over a wallpaper. Clear, Frosted and Solid are one-tap choices; Fine-tune sets each blur and see-through level yourself. Themes without a wallpaper are not affected.' },
        { term: 'The share icon', text: 'Appears on themes you built yourself. It publishes that theme to the marketplace so others can install it.' },
        { term: 'Particles', text: 'Falling rain, dust, embers or snow over the app. Auto keeps whatever the theme comes with.' },
        { term: 'Theme cycle', text: 'Configured from the status bar widget editor (tap the gear in the status bar → the pencil next to "Theme"). Themes in the cycle rotate when you tap the theme pill at the bottom.' },
        { term: 'Reduce visual effects', text: 'Turns off particles, glass blur, and animations. Use this if the app feels slow or if movement bothers you. Glass blur sliders are automatically disabled while this is on.' },
        { term: 'Message timestamps', text: 'Shows the time each chat message was sent inside the bubble.' },
        { term: 'Browse marketplace', text: 'Open the gallery of themes other people have made and shared. Free to install.' },
        { term: 'Build new theme', text: "Asks Claude to create a brand-new theme just by describing what you want in plain English (e.g. 'a soft sage green theme with rounded corners')." },
      ],
    },
    {
      heading: 'Common issues',
      bullets: [
        { term: 'Theme looks broken or colors are missing', text: "The theme file may be corrupted. Switch back to a built-in theme (Light/Dark/Midnight/Crème) first, then try the broken one again." },
        { term: 'App feels slow or laggy', text: 'Turn on "Reduce visual effects". Particles and glass blur use the most power — disabling them usually fixes it instantly.' },
        { term: 'Changing a theme itself', text: "The settings here apply to every theme. To change a theme's own colours or picture, tap 'Build new theme' and describe what you want, or ask Claude to edit one you built." },
        { term: "Theme cycle isn't switching", text: 'Open the status bar widget editor and use the pencil next to "Theme" to pick at least 2 themes for the cycle.' },
        { term: 'Custom font not showing', text: "YouCoded reads fonts installed on your computer. If the font you want isn't installed system-wide, it can't be selected here. Install it through your operating system first." },
        { term: 'Published theme not appearing in marketplace', text: 'Theme submissions are reviewed before they go live. Yours should appear within a day or two if it passes the safety checks.' },
      ],
    },
  ],
};

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
}

// Only the user's own themes can be published from here. WHY a share icon and no editor
// (appearance-questions AQ-1/AQ-3, 2026-10-01): the per-theme editor repeated the
// every-theme settings below and greyed itself out when they were set, so it is gone;
// Publish, the one thing still only reachable there, is the share icon on the card.
// The card itself lives in appearance/ThemeCard.tsx.
function canPublish(theme: LoadedTheme): boolean {
  return theme.source === 'user';
}

// WHY: `onShowInfo` was lifted to the Dialog owner (SettingsPanel ThemeButton)
// in D1 — the owner renders the (i) button into the header via `headerActions`.
// ThemeScreen only reads the boolean; it never needs to flip it. Removing the
// unused prop + `InfoIconButton` import found by the 2026-08-06 sweep.
export default function ThemeScreen({ onClose, onSendInput, onRunCommand, onOpenMarketplace, onPublishTheme, showInfo }: Props) {
  // Always mounted when open (parent conditionally renders) — so open=true is correct here.
  useEscClose(true, onClose);
  const { allThemes, theme: activeSlug, setTheme, reducedEffects, setReducedEffects, showTimestamps, setShowTimestamps } = useTheme();
  // MarketplaceContext supplies favorites and the toggle action.
  const mp = useMarketplace();
  const themeFavSet = useMemo(() => new Set(mp.themeFavorites), [mp.themeFavorites]);
  // slug → the theme library's preview URL, for cards whose theme has no local
  // preview.png (installs never download one — see ThemeCard's Preview).
  const libraryPreviews = useMemo(
    () => new Map(mp.themeEntries.filter(e => e.preview).map(e => [e.slug, e.preview as string])),
    [mp.themeEntries],
  );

  // Appearance panel shows favorites only, plus the active theme as a fallback
  // so there's always at least one card even when the user has unstarred their
  // current theme. The full installed list lives in Your library › Themes.
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
  // The app's standard edge fade (FolderSwitcher, ResumeBrowser): the box's top/bottom
  // edge fades whenever there is more to scroll, so it reads as scrollable (AR-1).
  useScrollFade(favBoxRef);
  const userScrolledFavs = useRef(false);
  useLayoutEffect(() => {
    const box = favBoxRef.current;
    const card = box?.querySelector<HTMLElement>('[data-active-theme]');
    if (!box || !card || userScrolledFavs.current) return;
    const top = card.offsetTop; // the box is `relative`, so this is measured from its top
    // 48 = the button zone at the box's bottom (pb-12): a card under the buttons is not "in view".
    if (top + card.offsetHeight > box.scrollTop + box.clientHeight - 48) box.scrollTop = top - 8;
  }, [gridThemes]);
  const markFavsTouched = () => { userScrolledFavs.current = true; };

  if (showInfo) {
    // Header + scroll body come from the Dialog above this component now.
    return <SettingsExplainer intro={APPEARANCE_EXPLAINER.intro} sections={APPEARANCE_EXPLAINER.sections} />;
  }

  return (
    // D1: header, close and scroll body come from the Dialog.
    // Headed sections: Themes · Window · Chat · Glass & effects (AQ-4, 2026-10-01).
    // space-y-4: the guide's 16px between groups (popup-spacing SP-4).
    <div className="space-y-4">
      <section className="space-y-2">
        {/* WHY SectionLabel, not the SECTION_LABEL class string (labels batch,
            guide: no spaced capitals — decisions H-3/L-1…L-4); the constant
            LookSettings.tsx used to export is retired. */}
        <SectionLabel>Themes</SectionLabel>
        {/* The themes box (Destin, appearance-panel-review-3 AR3-2): "doesn't feel like a
            container, just an outline" → a filled, rounded box. It shows about 1.5 theme cards,
            and Browse / Build sit INSIDE it at the bottom with the cards scrolling under them,
            faded by the masked edge (.scroll-mask) rather than the painted band.
            max-h-64 = 256px: 8px top padding + one ~124px card (16:9 picture + slim strip) + the gap
            + ~half the next row above the button zone (pb-12 keeps the last card 8px clear of the buttons).
            data-guide-anchor: the first-run tour's "make it yours" stop rings the grid. */}
        <div className="relative rounded-xl border border-edge bg-inset/50 overflow-hidden">
          <div
            ref={favBoxRef}
            onWheel={markFavsTouched} onPointerDown={markFavsTouched} onTouchStart={markFavsTouched}
            className="scroll-mask max-h-64 overscroll-contain p-2 pb-12"
            // 40 = the buttons' top edge (8px padding + a 32px button). pb-12 (48) leaves the
            // last card 8px above them — the same gap as between cards (review-4 AR4-1).
            style={{ ['--scroll-mask-under' as string]: '40px' }}
            aria-label="Favorited themes"
          >
          <div className="grid grid-cols-2 gap-2" data-guide-anchor="theme-grid">
            {gridThemes.map(t => (
              <ThemeCard
                key={t.slug}
                theme={t}
                active={t.slug === activeSlug}
                favorite={themeFavSet.has(t.slug)}
                onSelect={() => setTheme(t.slug)}
                onToggleFavorite={() => { mp.favoriteTheme(t.slug, !themeFavSet.has(t.slug)).catch(() => {}); }}
                // The share icon exists only on the user's own themes (canPublish).
                onShare={canPublish(t) && onPublishTheme ? () => onPublishTheme(t.slug) : undefined}
                fallbackPreview={libraryPreviews.get(t.slug)}
              />
            ))}
          </div>
        </div>

          <div className="absolute inset-x-0 bottom-0 grid grid-cols-2 gap-2 p-2">
        {/* Browse marketplace — above Build (Destin, Phase C P-3 #3, 2026-08-27):
            the old "Browse all themes →" button is gone; it opened Your library ›
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
            Browse marketplace
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
          ✦ Build new theme
        </Button>
          </div>
        </div>
      </section>

      {/* WHY three named cards, nothing folded (appearance-questions AQ-4, 2026-10-01:
          Destin picked "Named groups, nothing folded"). Before: bare Layout tiles, one
          folded "Additional customizations" grab-bag, and "Effects & chat" mixing an
          accessibility switch with a chat setting. Now each group is a small label over a
          level-1 card (guide: a label first, nothing bare), split by what it changes. */}
      <section>
        <SectionLabel className="mb-2">Window</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 space-y-4`}>
          <StackedRow title="Layout"><LayoutSettings /></StackedRow>
          <RoundnessSettings />
        </div>
      </section>

      <section>
        <SectionLabel className="mb-2">Chat</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 space-y-4`}>
          <BubbleSettings />
          <SettingRow
            header
            variant="item"
            title="Message timestamps"
            description="Show time sent in each chat bubble"
            control={
              <Toggle
                checked={showTimestamps}
                onChange={(next) => setShowTimestamps(next)}
                aria-label="Message timestamps"
              />
            }
          />
        </div>
      </section>

      <section className="space-y-2">
        <SectionLabel>Glass &amp; effects</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 space-y-4`}>
          <GlassLook />
          <ParticleSettings />
          {/* Reduce visual effects — global: disables particles, forces blur to 0,
              shortens animations. It sits with the glass and particles it switches off. */}
          <SettingRow
            header
            variant="item"
            title="Reduce visual effects"
            description="Disables particles, blur, and animations"
            control={
              <Toggle
                checked={reducedEffects}
                onChange={(next) => setReducedEffects(next)}
                aria-label="Reduce visual effects"
              />
            }
          />
        </div>
        <ResetLook />
      </section>
    </div>
  );
}
