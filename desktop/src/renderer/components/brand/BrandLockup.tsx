import appIcon from './app-icon-192.png';

/**
 * The stacked YouCoded logo: the glass app icon, "youcoded" under it, the tagline under
 * that. Every measure is a brand decision (DECISIONS.md, rounds 9–26): Outfit SemiBold at
 * −3.5% tracking, "you" in the purple-to-pink gradient, the tagline at 0.34× the name's
 * size pulled 6px tighter at a 36px name (v26 STACK sc). `size` is the name's height in px;
 * the icon and gaps scale with it, so the logo keeps its proportions at any size.
 */
export function BrandLockup({ size = 36, tagline = true }: { size?: number; tagline?: boolean }) {
  const k = size / 36;
  return (
    <div className="flex flex-col items-center select-none" aria-label="YouCoded" role="img">
      <img src={appIcon} alt="" width={68 * k} height={68 * k} className="brand-icon" draggable={false} />
      <span className="brand-name" style={{ fontSize: size, marginTop: 10 * k }}>
        <span className="brand-name__you">you</span>coded
      </span>
      {tagline && (
        <span className="brand-tagline" style={{ fontSize: size * 0.34, marginTop: 2 * k, lineHeight: 1 }}>
          agents for everyone
        </span>
      )}
    </div>
  );
}

/**
 * The side-by-side logo: icon, then "youcoded" with the tagline tucked up beside the "y"'s
 * tail (first-run deck R-1, Destin 2026-10-04: "maybe try horizontal icon/brand/tagline,
 * all a bit bigger"). Measures from the approved lockup (v20 SPACING sd, v24–v26 HORIZ hc):
 * gap a quarter of the icon's height; tagline 0.33× the name, its top 0.42× the name's size
 * above the bottom of the name's line, starting 0.8× the "y"'s width in; the text block
 * 2px lower at a 64px icon, net of the name's 3.5% raise. `icon` is the icon's height in px;
 * the name is 42/64 of it, as on the approved board.
 */
// The height of Outfit's text box (ascent + descent) as a share of its size. The board
// measured the tagline's place from the bottom of that box, not from the line's height.
const OUTFIT_CONTENT = 1.26;

export function BrandLockupRow({ icon = 80 }: { icon?: number }) {
  const k = icon / 64;
  const name = 42 * k;
  // WHY a fixed 0.53em and not a measurement: Outfit SemiBold's "y" is 0.53em wide less the
  // −3.5% tracking; measuring it at runtime would mean a layout read on mount for a number
  // the bundled font never changes.
  const yWidth = name * (0.53 - 0.035);
  return (
    <div className="flex items-center select-none" style={{ gap: icon / 4 }} aria-label="YouCoded — agents for everyone" role="img">
      <img src={appIcon} alt="" width={icon} height={icon} className="brand-icon" draggable={false} />
      {/* paddingBottom keeps the block as tall as name + tagline stacked, as on the board,
          so the icon centres against the same height after the tagline tucks up. */}
      <div className="relative" style={{ transform: `translateY(${(2 - 0.035 * 64) * k}px)`, paddingBottom: name * (OUTFIT_CONTENT - 1) + name * 0.33 + 1 }}>
        <span className="brand-name block" style={{ fontSize: name }}>
          <span className="brand-name__you">you</span>coded
        </span>
        <span className="brand-tagline absolute" style={{ fontSize: name * 0.33, lineHeight: 1, left: yWidth * 0.8, top: name * (OUTFIT_CONTENT - 0.42) }}>
          agents for everyone
        </span>
      </div>
    </div>
  );
}
