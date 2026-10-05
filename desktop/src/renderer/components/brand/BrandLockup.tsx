import { useLayoutEffect, useRef, useState } from 'react';
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
/**
 * The side-by-side logo with the tagline tucked beside the "y"'s tail (first-run deck R-1,
 * Destin 2026-10-04: "maybe try horizontal icon/brand/tagline, all a bit bigger").
 *
 * WHY it is laid out exactly as the approved board drew it (src22/boards.html round26(),
 * v26 HORIZ hc), measurements and all: an approximation with fixed ratios was rejected on
 * sight (deck first-run-2 P2-1: "tagline is far too close to brand name"). The board stacks
 * name and tagline, then lifts the tagline to `nameBox − 0.42 × size` from the block's top,
 * `0.8 × "y" width` in, keeping the stacked height; the block sits 2px lower at a 64px
 * icon, the gap is a quarter of the icon. One measurement on mount, after the bundled font
 * has loaded — not per frame.
 */
export function BrandLockupRow({ icon = 80, showIcon = true }: { icon?: number; showIcon?: boolean }) {
  const k = icon / 64;
  const size = 42 * k;
  const blockRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const tagRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number; height: number } | null>(null);
  useLayoutEffect(() => {
    let live = true;
    const measure = () => {
      const b = blockRef.current, n = nameRef.current;
      if (!live || !b || !n) return;
      const height = b.getBoundingClientRect().height;
      const nh = n.getBoundingClientRect().height;
      const cv = document.createElement('canvas').getContext('2d');
      let yw = size * 0.5;
      if (cv) { cv.font = `600 ${size}px Outfit`; yw = cv.measureText('y').width; }
      setPlace({ top: nh - size * 0.42, left: yw * 0.8, height });
    };
    // The font must be in before measuring, or the fallback's metrics place the tagline.
    void (document.fonts?.load(`600 ${size}px Outfit`) ?? Promise.resolve()).then(measure, measure);
    return () => { live = false; };
  }, [size]);
  return (
    <div className="flex items-center select-none" style={{ gap: icon / 4 }} aria-label="YouCoded — agents for everyone" role="img">
      {showIcon && <img src={appIcon} alt="" width={icon} height={icon} className="brand-icon" draggable={false} />}
      <div ref={blockRef} className="relative inline-block" style={{ transform: `translateY(${2 * k}px)`, height: place?.height, lineHeight: 'normal' }}>
        <span ref={nameRef} className="brand-name" style={{ fontSize: size }}>
          <span className="brand-name__you">you</span>coded
        </span>
        <div ref={tagRef} style={place ? { position: 'absolute', left: place.left, top: place.top, margin: 0 } : { marginTop: 1 }}>
          <span className="brand-tagline inline-block" style={{ fontSize: size * 0.33 }}>agents for everyone</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The name without the icon (deck first-run-4 P4-3), with the tagline stacked under it
 * (the stacked lockup's spacing: 0.34× the name, pulled 6px tighter at a 36px name),
 * tucked beside the "y" as in the side-by-side lockup, or left off.
 */
export function BrandWordmark({ size, tagline }: { size: number; tagline: 'stack' | 'tuck' | 'none' }) {
  if (tagline === 'tuck') return <BrandLockupRow icon={size * 64 / 42} showIcon={false} />;
  const k = size / 36;
  return (
    <div className="flex flex-col items-center select-none" style={{ lineHeight: 'normal' }} aria-label="YouCoded" role="img">
      <span className="brand-name" style={{ fontSize: size }}>
        <span className="brand-name__you">you</span>coded
      </span>
      {/* WHY the wrapper with its own 16px-at-36 line: the approved board (v26 STACK sc) set
          the tagline in a block whose line box came from the page's 16px text, and its −6px
          pull is measured from that box. Without it the tagline sat on the "y" (rejected,
          deck first-run-6). Scaled with the name so the proportions hold at any size. */}
      {tagline === 'stack' && (
        <div style={{ marginTop: -6 * k, fontSize: 16 * k, lineHeight: 'normal' }}>
          <span className="brand-tagline inline-block" style={{ fontSize: size * 0.34 }}>agents for everyone</span>
        </div>
      )}
    </div>
  );
}
