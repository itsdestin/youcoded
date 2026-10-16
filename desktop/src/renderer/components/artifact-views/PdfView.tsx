import { useCallback, useEffect, useRef, useState } from 'react';
import { BinaryContent, CenterNote } from './BinaryContent';
import * as pdfjs from 'pdfjs-dist';
// Fix: pdfjs-dist v5+ ships ESM-only workers (.mjs, not .js). Import via Vite's
// `?url` suffix so it's treated as a static asset URL rather than a bundled
// module — Vite can't bundle the worker as a regular import because rolldown
// can't resolve the .js path that no longer exists in the package.
// @ts-ignore — Vite ?url query suffix is not typed in this tsconfig (moduleResolution: node)
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl as string;
import type { ArtifactViewProps } from './types';
import { ZoomPill } from '../ui';
import { Loupe, ZOOM_RUNGS } from './zoom';
import { useEscClose } from '../../hooks/use-esc-close';

/** The base render scale, unchanged from before zoom existed. 100% on the pill. */
const BASE_SCALE = 1.5;

/** Chrome accepts an oversized canvas, reports the requested width, paints
 *  NOTHING, and throws no exception — so a pre-emptive cap is the only defense
 *  that exists here. "Render and catch" is not available. */
export const PDF_MAX_MEGAPIXELS = 16;
export const PDF_MAX_DIMENSION = 16384;

/** Largest scale a page of this size can be drawn at before the canvas silently
 *  stops painting. Capped by area AND by a single dimension — a very long page
 *  hits the dimension limit first. */
export function pdfScaleCeiling(pageW: number, pageH: number): number {
  if (!(pageW > 0) || !(pageH > 0)) return 1;
  const byArea = Math.sqrt((PDF_MAX_MEGAPIXELS * 1_000_000) / (pageW * pageH));
  const byDim = Math.min(PDF_MAX_DIMENSION / pageW, PDF_MAX_DIMENSION / pageH);
  return Math.max(1, Math.min(byArea, byDim));
}

export function PdfView({ absolutePath, findBarOpen }: ArtifactViewProps) {
  // BinaryContent owns loading/error for the byte read; PdfPages only ever
  // mounts with real bytes (and is remounted per file, resetting its state).
  return (
    <BinaryContent absolutePath={absolutePath} noun="PDF">
      {(bytes) => <PdfPages bytes={bytes} findBarOpen={findBarOpen} />}
    </BinaryContent>
  );
}

function PdfPages({ bytes, findBarOpen }: { bytes: Uint8Array; findBarOpen?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  // The document is held in a ref, NOT re-fetched per scale: putting `scale` in
  // the loading effect's deps would re-run getDocument() and destroy() on every
  // click of "+", re-parsing the whole file to draw it slightly bigger.
  const docRef = useRef<any>(null);
  const [numPages, setNumPages] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState({ w: 0, h: 0 });

  // `zoom` here is a multiplier on BASE_SCALE, so 1 = exactly what this viewer
  // showed before zoom existed.
  const [zoom, setZoom] = useState(1);
  const [loupeOn, setLoupeOn] = useState(false);

  const canLoupe = typeof window !== 'undefined'
    && window.matchMedia?.('(any-hover: hover) and (any-pointer: fine)')?.matches === true;

  useEffect(() => {
    let cancelled = false;
    // Copy into a fresh Uint8Array — pdfjs takes ownership of (detaches) the
    // buffer it's handed, which would break a re-render off the same bytes.
    const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
    loadingTask.promise.then(async (pdf: any) => {
      if (cancelled) { pdf.destroy?.(); return; }
      docRef.current = pdf;
      setNumPages(pdf.numPages);
      // First page's intrinsic size drives the ceiling, so "+" can be disabled
      // with a reason BEFORE a click produces a blank canvas.
      const first = await pdf.getPage(1);
      if (cancelled) return;
      const vp = first.getViewport({ scale: 1 });
      setPageSize({ w: vp.width, h: vp.height });
    }).catch((e: any) => {
      // Corrupt/encrypted PDFs reject here — surface a message instead of an
      // unhandled rejection + permanently blank pane.
      if (!cancelled) setParseError(String(e?.message ?? e));
    });
    return () => {
      cancelled = true;
      // destroy() aborts an in-flight load AND frees the worker transport for a
      // finished one — without it every file switch leaked the previous
      // document's memory in the pdf.js worker.
      loadingTask.destroy().catch(() => {});
    };
  }, [bytes]);

  const ceiling = pdfScaleCeiling(pageSize.w * BASE_SCALE, pageSize.h * BASE_SCALE);
  const rungs = ZOOM_RUNGS.filter((r) => r > 1 && r <= ceiling);
  const canZoomIn = zoom < (rungs.length ? rungs[rungs.length - 1] : 1) - 1e-6;
  const atSizeCeiling = pageSize.w > 0 && rungs.length > 0 && zoom >= rungs[rungs.length - 1] - 1e-6
    && (ZOOM_RUNGS.find((r) => r > zoom + 1e-6) ?? 0) > ceiling;

  const step = useCallback((dir: 1 | -1) => {
    setZoom((z) => {
      const stops = [1, ...rungs];
      if (dir === 1) return stops.find((s) => s > z + 1e-6) ?? stops[stops.length - 1];
      const below = stops.filter((s) => s < z - 1e-6);
      return below.length ? below[below.length - 1] : 1;
    });
  }, [rungs]);

  useEscClose(loupeOn, () => setLoupeOn(false));

  // A PDF is one canvas PER PAGE and the page under the cursor changes as the
  // list scrolls, so the lens hit-tests the rendered canvases by their rects.
  // (document.elementFromPoint would be the obvious tool and is not implemented
  // in jsdom, which would make this untestable.)
  const resolveSource = useCallback((cx: number, cy: number) => {
    const root = rootRef.current;
    if (!root) return null;
    for (const el of Array.from(root.querySelectorAll('canvas'))) {
      const r = el.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
        return { el: el as HTMLCanvasElement };
      }
    }
    return null;   // between pages — the lens hides itself
  }, []);

  if (parseError) return <CenterNote>Couldn’t open this PDF. It may be corrupt or password-protected.</CenterNote>;

  // The pill lives OUTSIDE the scrolling element, not inside it: an absolutely
  // positioned child of a scroll container scrolls away with the content, and
  // `fixed` would pin it to the WINDOW — wrong the moment the pane is not where
  // the window corner is (Project View, a resized drawer, a narrow window).
  return (
    <div data-zoomable className="relative h-full">
      <div ref={rootRef} className="scroll-mask absolute inset-0 overflow-auto p-4">
        {Array.from({ length: numPages }, (_, i) => (
          <PdfPage key={i} doc={docRef} index={i + 1} scale={BASE_SCALE * zoom} fitWidth={zoom <= 1 + 1e-6} />
        ))}
      </div>

      <ZoomPill
        // Same corner and the same find-bar dodge as the image viewer, so the
        // control does not move when you switch between a picture and a PDF.
        className={findBarOpen ? 'absolute top-14 right-2' : 'absolute top-2 right-2'}
        percent={Math.round(zoom * 100)}
        canZoomIn={canZoomIn}
        canZoomOut={zoom > 1 + 1e-6}
        zoomInDisabledReason={atSizeCeiling ? 'This page can’t be drawn any larger' : undefined}
        onZoomIn={() => step(1)}
        onZoomOut={() => step(-1)}
        onReset={() => setZoom(1)}
        loupe={canLoupe ? { on: loupeOn, onToggle: () => setLoupeOn((v) => !v) } : null}
      />

      {loupeOn && <Loupe resolveSource={resolveSource} displayScale={zoom} clipTo={rootRef} />}
    </div>
  );
}

/** One page, owning its own canvas and its own render task.
 *
 *  The render task is the point of this component. The previous imperative loop
 *  never called RenderTask.cancel() anywhere — it only had a `cancelled` flag
 *  gating the LOOP — so it could not re-render at all: a second render into a
 *  live canvas is the pdf.js "Cannot use the same canvas during multiple
 *  render() operations" error. */
function PdfPage({ doc, index, scale, fitWidth }: {
  doc: React.MutableRefObject<any>;
  index: number;
  scale: number;
  /** At rest the page is capped to the pane width, exactly as this viewer has
   *  always shown a PDF. Once zoomed that cap has to come OFF, or "+" only makes
   *  the text sharper at the same size — which is not what a plus button means.
   *  The container scrolls to reach the rest of the page. */
  fitWidth: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taskRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pdf = doc.current;
      const canvas = canvasRef.current;
      if (!pdf || !canvas) return;
      // Cancel the previous render for THIS canvas before touching it again.
      taskRef.current?.cancel?.();
      const page = await pdf.getPage(index);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.maxWidth = fitWidth ? '100%' : 'none';
      canvas.style.marginBottom = '8px';
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      taskRef.current = page.render({ canvasContext: ctx, viewport, canvas });
      // A cancelled render rejects — that is the expected path on a scale change,
      // not an error worth surfacing.
      await taskRef.current.promise.catch(() => {});
    })();
    return () => {
      cancelled = true;
      taskRef.current?.cancel?.();
    };
  }, [doc, index, scale, fitWidth]);

  return <canvas ref={canvasRef} />;
}
