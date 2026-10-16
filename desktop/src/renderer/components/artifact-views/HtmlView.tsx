import { useEffect, useState } from 'react';
import type { ArtifactViewProps } from './types';
import { inlineLocalAssets } from './html-inline-assets';
import { CenterLoading } from './BinaryContent';

// HtmlView — full-size interactive preview of an HTML artifact.
//
// Renders the file's content inline via `srcDoc` (the app's CSP blocks loading a
// `file://` document into an iframe, so we feed the already-read HTML string the
// same way the card thumbnail does). `allow-scripts` lets self-contained mockups
// (incl. Tailwind-CDN pages) render and run; we omit `allow-same-origin` so the
// frame stays an opaque origin and can't script the app. Artifacts are the
// user's own generated files, so script execution for a faithful preview is the
// right trade-off.
//
// Relative local assets (sibling styles.css / game.js / images) can never load
// from a srcDoc frame — no base URL, and the CSP blocks file:// subresources —
// so they are INLINED first via html-inline-assets.ts (guarded read-binary
// IPC). A page whose assets fail to fetch degrades to the old behavior:
// unstyled markup, not a broken pane.
export function HtmlView({ content, absolutePath }: ArtifactViewProps) {
  const [doc, setDoc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    if (content === null) return;
    inlineLocalAssets(content, absolutePath).then((processed) => {
      if (!cancelled) setDoc(processed);
    });
    return () => { cancelled = true; };
  }, [content, absolutePath]);

  if (content === null || doc === null) {
    // WHY CenterLoading, not a bare "Loading…": the shared LoadingState names what is loading
    // (guide "File viewers" known deviation, 2026-10-13).
    return <CenterLoading what="page" />;
  }
  return (
    <iframe
      srcDoc={doc}
      sandbox="allow-scripts allow-popups allow-forms"
      className="w-full h-full border-0 bg-white"
      title="HTML preview"
    />
  );
}
