import { useEffect, useMemo, useState } from 'react';
import type { ArtifactViewProps } from './types';
import { inlineLocalAssets } from './html-inline-assets';
import { CenterLoading } from './BinaryContent';
import { HTML_PREVIEW_CSP, previewFrameProps, withPolicyMeta } from './html-preview-csp';

// HtmlView — full-size interactive preview of an HTML artifact.
//
// Renders the file's content inline via `srcDoc` (a `file://` document cannot be
// framed from the app's page, so we feed the already-read HTML string the same
// way the card thumbnail does). `allow-scripts` lets self-contained mockups
// (incl. Tailwind-CDN pages) render and run; we omit `allow-same-origin` so the
// frame stays an opaque origin and can't script the app.
//
// WHY the policy (2026-10-30 audit F1/F8): the file is NOT always the user's own — it may be downloaded, cloned, or written by an
// assistant that read something hostile. So the frame runs under html-preview-csp.ts: scripts and public CDNs still work, but it
// cannot fetch/XHR/beacon, post a form, or prefetch. Navigation of the frame itself is stopped in main (frame-navigation-guard.ts).
//
// Relative local assets (sibling styles.css / game.js / images) can never load
// from a srcDoc frame — no base URL, and file:// subresources are refused —
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

  // Built once per document, not per render.
  const framed = useMemo(() => (doc === null ? '' : withPolicyMeta(doc, HTML_PREVIEW_CSP)), [doc]);
  if (content === null || doc === null) {
    // WHY CenterLoading, not a bare "Loading…": the shared LoadingState names what is loading
    // (guide "File viewers" known deviation, 2026-10-13).
    return <CenterLoading what="page" />;
  }
  return (
    <iframe
      srcDoc={framed}
      {...previewFrameProps(HTML_PREVIEW_CSP)}
      sandbox="allow-scripts allow-popups allow-forms"
      className="w-full h-full border-0 bg-white"
      title="HTML preview"
    />
  );
}
