import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArtifactViewProps } from './types';
import { BinaryContent, CenterLoading } from './BinaryContent';
import { ZoomPill } from '../ui';
import { Loupe, pointInRect, useZoomPan } from './zoom';
import { useEscClose } from '../../hooks/use-esc-close';

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};

/** Below this width the pill would overflow the frame it sits in. Measured, not
 *  guessed: the pill renders ~128px wide with the magnifier button, and sits 8px
 *  in from the edge, so ~144px is where it stops fitting.
 *
 *  An earlier 260px was WRONG and hid the controls in the ordinary layout: with
 *  the file list open the viewer is ~272px and the inset frame ~240px, so the
 *  one place a picture is most shrunken had no way to zoom it. The genuinely
 *  narrow case this guards is the ~107px minimum (MIN_DRAWER_WIDTH 320 minus the
 *  210px file list). */
const MIN_WIDTH_FOR_PILL = 150;

export function ImageView({ absolutePath, findBarOpen }: ArtifactViewProps) {
  // BinaryContent owns loading/error for the byte read.
  return (
    <BinaryContent absolutePath={absolutePath} noun="image">
      {(bytes) => <ImageContent bytes={bytes} absolutePath={absolutePath} findBarOpen={findBarOpen} />}
    </BinaryContent>
  );
}

// All zoom/loupe state lives HERE, not in ImageView: BinaryContent keys this
// child by absolutePath, so switching files remounts it and every file opens
// plainly at fit size. State one level up would carry a stale zoom across.
function ImageContent({ bytes, absolutePath, findBarOpen }:
  { bytes: Uint8Array; absolutePath: string; findBarOpen?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [loupeOn, setLoupeOn] = useState(false);

  const isSvg = absolutePath.toLowerCase().endsWith('.svg');
  // No hover, no lens: a magnifier that follows a cursor is meaningless without
  // one, and rendering a control that can do nothing is worse than omitting it.
  // A media query rather than a platform check — a remote browser on a desktop
  // has a real cursor and should get the lens.
  //
  // `any-hover`, NOT `hover`: the un-prefixed form asks about the PRIMARY
  // pointer, and on a touchscreen laptop (Destin's is one) the primary pointer
  // can be the finger — which would hide the magnifier on a machine that has a
  // trackpad right there. `any-hover` asks the question that actually matters:
  // is there any device here that can hover? A phone answers no.
  const canLoupe = typeof window !== 'undefined'
    && window.matchMedia?.('(any-hover: hover) and (any-pointer: fine)')?.matches === true;

  // Build a blob: URL from the bytes (same-origin, works everywhere) instead of
  // an <img src="file://…">, which the renderer origin can't load.
  useEffect(() => {
    const ext = absolutePath.split('.').pop()?.toLowerCase() ?? '';
    // base64ToBytes allocates an exact-size buffer, so .buffer is the full data.
    // Cast narrows ArrayBufferLike → ArrayBuffer for the strict BlobPart type.
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: MIME[ext] ?? 'application/octet-stream' });
    const objUrl = URL.createObjectURL(blob);
    setUrl(objUrl);
    return () => URL.revokeObjectURL(objUrl);
  }, [bytes, absolutePath]);

  // The drawer's resize handle writes --drawer-width straight to <html> with NO
  // React re-render (state/drawer-width.ts), so the container has to be observed
  // or the fit scale goes stale while the divider is being dragged.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [url]);

  // A vector's REPORTED size is meaningless: a viewBox-only SVG answers
  // naturalWidth 300×150 whatever it actually draws. Its ratio is right, its
  // size is not.
  //
  // Left to itself the browser handles this fine — CSS's default sizing
  // algorithm stretches a ratio-only replaced element to the container, which is
  // why such an SVG already filled the pane before this feature existed. But
  // this viewer sets an EXPLICIT width/height (the lens has to draw from an
  // element whose CSS box equals its content box), and that would have pinned
  // the drawing at the bogus 300×150 — small in a big pane, and below the lens's
  // own minimum size, so the magnifier would have refused to open on exactly the
  // format it works best on. Recompute the size the browser would have chosen.
  const content = (() => {
    if (!isSvg || !(natural.w > 0) || !(box.w > 0)) return natural;
    const up = Math.min(box.w / natural.w, box.h / natural.h);
    return { w: natural.w * up, h: natural.h * up };
  })();

  const zoom = useZoomPan({
    containerW: box.w, containerH: box.h, contentW: content.w, contentH: content.h,
  });

  // Escape rides the app's dismissal stack. A raw keydown listener here would
  // either swallow the Escape that interrupts Claude or fire alongside it, and
  // Android's hardware back button routes through this same stack.
  useEscClose(loupeOn, () => setLoupeOn(false));

  // Hit-test, not "here is the picture": answering unconditionally kept the lens
  // visible everywhere in the pane — including parked on top of the pill, which
  // made the magnifier impossible to switch off (reported 2026-08-27).
  const resolveSource = useCallback((cx: number, cy: number) => {
    const el = imgRef.current;
    if (!el) return null;
    return pointInRect(cx, cy, el.getBoundingClientRect()) ? { el } : null;
  }, []);

  // WHY CenterLoading: the shared LoadingState (guide "File viewers" known deviation, 2026-10-13).
  if (!url) return <CenterLoading what="image" />;

  return (
    <div
      data-zoomable
      className="relative h-full w-full overflow-hidden"
      // Only claim the touch gestures once there is something to pan; at fit the
      // page keeps its normal scrolling behaviour.
      style={{ touchAction: zoom.isFit ? undefined : 'none' }}
      {...zoom.bind}
    >
      {/* The picture lives in an inset frame, not against the pane edges: the
          viewer has always given an image 16px of breathing room (the old
          `p-4`), and losing it silently would be a visual change nobody asked
          for. This inner box is also what gets MEASURED — clientWidth includes
          padding, so measuring a padded outer box would over-report the space
          available and fit the picture slightly too large. */}
      <div ref={boxRef} className="absolute inset-4 overflow-hidden">
      <img
        ref={imgRef}
        src={url}
        alt=""
        draggable={false}
        onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        className="absolute left-1/2 top-1/2 max-w-none select-none"
        style={{
          // Explicit size, so the element's CSS box always equals the content
          // box. The lens draws from this element, so any mismatch (an
          // object-contain letterbox, a vector at its default size) would
          // magnify something different from what is on screen.
          width: content.w || undefined,
          height: content.h || undefined,
          // translate(-50%,-50%) centres it, then pan and scale ride on top. A
          // transform creates no scroll extent, which is exactly why dragging is
          // the only way to pan and why zoom-math clamps the offset.
          transform:
            `translate(-50%, -50%) translate(${zoom.offset.x}px, ${zoom.offset.y}px) scale(${zoom.scale})`,
          transformOrigin: 'center',
          cursor: zoom.isFit ? undefined : (zoom.dragging ? 'grabbing' : 'grab'),
        }}
      />
      </div>

      {/* `box.w > 0 &&` matters: before the first measurement the width is 0 and
          we do NOT yet know it is narrow. Treating unknown as narrow would hide
          the pill on first paint and flash it in a frame later, on every file. */}
      {!(box.w > 0 && box.w < MIN_WIDTH_FOR_PILL) && (
        <ZoomPill
          // Ctrl+F opens ContentFindBar in this exact corner (its default
          // `top-2 right-2`), so step out from under it while it is up.
          className={findBarOpen ? 'absolute top-14 right-2' : 'absolute top-2 right-2'}
          percent={zoom.percent}
          canZoomIn={zoom.canZoomIn}
          canZoomOut={zoom.canZoomOut}
          onZoomIn={zoom.zoomIn}
          onZoomOut={zoom.zoomOut}
          onReset={zoom.reset}
          loupe={canLoupe ? { on: loupeOn, onToggle: () => setLoupeOn((v) => !v) } : null}
        />
      )}

      {loupeOn && (
        <Loupe resolveSource={resolveSource} displayScale={zoom.scale} vector={isSvg} clipTo={boxRef} />
      )}
    </div>
  );
}
