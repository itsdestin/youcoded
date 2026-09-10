// ArtifactThumbnail — mini pre-render for an artifact card in Project View.
// Strategy by file type:
//   - Images (png/jpg/gif/webp/svg/bmp/ico/avif) → artifacts.read-binary IPC →
//     blob: URL, the same path ImageView uses. NOT <img src="file://…"> — the
//     renderer origin (http in dev, app/asset in prod/Android) blocks file://
//     subresources, so file:// thumbnails silently fell back to the letter
//     glyph everywhere except a packaged file://-origin build.
//   - Markdown → fetch content via artifacts.get, RENDER the first ~600 bytes
//     (MarkdownHeadPreview — Destin's rule 2026-08-27: never a raw `##`).
//   - Plain text → same fetch, first ~8 lines as tiny monospace text.
//   - HTML / htm → sandboxed <iframe srcDoc> with pointer-events: none so the
//     parent card stays clickable. The empty sandbox attribute blocks scripts.
//   - Everything else → fall back to the original ext-letter glyph.
// ALL content-fetching (images included, now that they go through IPC) is gated
// by an IntersectionObserver so a project with hundreds of artifacts doesn't
// issue hundreds of IPC reads on mount.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactRecord } from '../../shared/artifacts/types';
import { MarkdownHeadPreview } from './HeadPreview';

interface Props {
  artifact: ArtifactRecord;
  projectPath: string;
  className?: string;
  // Background utility for the thumbnail container. Defaults to bg-inset (the
  // Project View grid look). The tool-call preview card passes bg-canvas so the
  // thumbnail reads as recessed inside the raised bg-inset card.
  bgClass?: string;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const MARKDOWN_EXTS = new Set(['md', 'markdown']);
const TEXT_EXTS = new Set(['txt', 'rtf']);
const HTML_EXTS = new Set(['html', 'htm']);

type Kind = 'image' | 'markdown' | 'text' | 'html' | 'fallback';

function getExt(p: string): string {
  const filename = p.split(/[\\/]/).pop() ?? '';
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

// Build an absolute path for an internal artifact. External artifacts already
// have absolutePath populated. Uses whichever separator the project path uses
// so we don't mix slashes on Windows.
function joinPath(projectPath: string, relPath: string): string {
  if (!projectPath) return relPath;
  const sep = projectPath.includes('\\') ? '\\' : '/';
  const cleanProject = projectPath.replace(/[\\/]+$/, '');
  const cleanRel = relPath.replace(/^[\\/]+/, '');
  return `${cleanProject}${sep}${cleanRel}`;
}

// MIME by extension for the image blob URL (a wrong subtype still decodes —
// Chromium sniffs image bytes — but svg genuinely needs its correct type).
function imageMime(ext: string): string {
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'ico') return 'image/x-icon';
  return `image/${ext}`;
}

export function ArtifactThumbnail({ artifact, projectPath, className = '', bgClass = 'bg-inset' }: Props) {
  const ext = getExt(artifact.path);
  const kind: Kind = useMemo(() => {
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (MARKDOWN_EXTS.has(ext)) return 'markdown';
    if (TEXT_EXTS.has(ext)) return 'text';
    if (HTML_EXTS.has(ext)) return 'html';
    return 'fallback';
  }, [ext]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  // blob: URL for image thumbnails (read-binary → Blob). Revoked on change/unmount.
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  // Measured container size, used to scale the HTML iframe preview down so the
  // whole page (rendered at a desktop logical width) fits the small card.
  const [boxSize, setBoxSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const absolutePath = artifact.kind === 'internal'
    ? joinPath(projectPath, artifact.path)
    : artifact.absolutePath;

  // IntersectionObserver gate: only fetch content once the card scrolls into
  // view (or close to it). Images go through the same gate now that they read
  // via IPC — a grid of hundreds must not fire hundreds of reads on mount.
  useEffect(() => {
    if (kind === 'fallback') return;
    const node = containerRef.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { rootMargin: '100px' }, // pre-fetch 100px before visible — feels instant on scroll
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [kind]);

  // Image thumbnails: read bytes over the artifacts:read-binary IPC and show a
  // blob: URL (mirrors useArtifactBytes / ImageView — see the header comment for
  // why file:// doesn't work). Any failure (guarded path, too-large, orphan)
  // falls back to the ext-letter glyph via imgFailed.
  useEffect(() => {
    if (kind !== 'image' || !inView || !absolutePath) return;
    let cancelled = false;
    let url: string | null = null;
    const readBinary = (window.claude as any)?.artifacts?.readBinary;
    if (typeof readBinary !== 'function') { setImgFailed(true); return; }
    readBinary(absolutePath)
      .then((res: any) => {
        if (cancelled) return;
        if (res?.ok && typeof res.base64 === 'string') {
          const bin = atob(res.base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          url = URL.createObjectURL(new Blob([bytes], { type: imageMime(ext) }));
          setImgUrl(url);
        } else {
          setImgFailed(true);
        }
      })
      .catch(() => { if (!cancelled) setImgFailed(true); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setImgUrl(null);
      setImgFailed(false);
    };
  }, [kind, inView, absolutePath, ext, artifact.lastModified]);

  // Fetch content once visible. Refetch when the artifact's lastModified
  // changes so an edit in another window updates the thumbnail.
  useEffect(() => {
    if (!inView || (kind !== 'text' && kind !== 'markdown' && kind !== 'html')) return;
    let cancelled = false;
    (window.claude as any).artifacts.get(projectPath, artifact.id)
      .then((res: any) => {
        if (cancelled) return;
        // A thumbnail shows a few lines. Over-cap files now return a real
        // multi-MB prefix instead of null, so slice before it lands in state —
        // otherwise every visible tile parks megabytes in React.
        if (res && res.ok) setContent((res.content ?? '').slice(0, 2000));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [inView, kind, projectPath, artifact.id, artifact.lastModified]);

  // Measure the thumbnail box so the HTML iframe can be rendered at a desktop
  // logical width and scaled to fit (a true zoomed-out webpage thumbnail rather
  // than a cropped top-left fragment). Only needed for the html branch.
  useEffect(() => {
    if (kind !== 'html') return;
    const node = containerRef.current;
    if (!node) return;
    // WHY the zero guard: a hidden ancestor (Project View's Files tab while
    // another tab is showing) measures 0x0, which would drop htmlScale to its
    // 0.16 fallback and re-scale every HTML thumbnail visibly when the tab comes
    // back. A real box is never 0x0 here, so keeping the last measurement is
    // always the better answer.
    const measure = () => {
      const w = node.clientWidth;
      const h = node.clientHeight;
      if (w === 0 && h === 0) return;
      setBoxSize({ w, h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [kind]);

  // Render the HTML page at this logical width, then scale down to the card.
  const HTML_DESIGN_WIDTH = 1100;
  const htmlScale = boxSize.w > 0 ? boxSize.w / HTML_DESIGN_WIDTH : 0.16;

  const showFallbackGlyph =
    kind === 'fallback' ||
    (kind === 'image' && (imgFailed || !absolutePath)) ||
    ((kind === 'text' || kind === 'markdown' || kind === 'html') && content === null);

  return (
    <div
      ref={containerRef}
      className={`relative flex items-center justify-center ${bgClass} overflow-hidden ${className}`}
    >
      {showFallbackGlyph && (
        <span className="text-2xl font-mono text-fg-muted">{ext ? ext.toUpperCase() : '—'}</span>
      )}

      {kind === 'image' && imgUrl && !imgFailed && (
        <img
          src={imgUrl}
          alt=""
          decoding="async"
          className="w-full h-full object-cover"
          onError={() => setImgFailed(true)}
        />
      )}

      {kind === 'markdown' && content !== null && (
        // Rendered, not raw: the same scaled MarkdownContent the composer's
        // attachment card uses, over the first ~600 bytes.
        <div className="absolute inset-0">
          <MarkdownHeadPreview text={content.slice(0, 600)} />
        </div>
      )}

      {kind === 'text' && content !== null && (
        // First ~8 lines, monospace, very small — readable enough to identify
        // a plan / walkthrough / note at a glance. whitespace-pre-wrap so long
        // lines wrap inside the card instead of overflowing horizontally.
        <pre className="absolute inset-0 m-0 p-2 text-4xs leading-tight font-mono text-fg-2 overflow-hidden whitespace-pre-wrap break-words">
          {content.split('\n').slice(0, 8).join('\n')}
        </pre>
      )}

      {kind === 'html' && content !== null && (
        // Render the page at a desktop logical width (HTML_DESIGN_WIDTH) and
        // scale it down to the card so the WHOLE page is visible as a zoomed-out
        // thumbnail, instead of a 1:1 cropped top-left fragment. Empty sandbox =
        // scripts disabled; pointer-events none keeps the parent <button> clickable.
        <iframe
          srcDoc={content}
          sandbox=""
          loading="lazy"
          title=""
          className="absolute top-0 left-0 border-0 pointer-events-none bg-white origin-top-left"
          style={{
            width: HTML_DESIGN_WIDTH,
            // Height in logical px that, once scaled, fills the box exactly.
            height: boxSize.h > 0 ? boxSize.h / htmlScale : HTML_DESIGN_WIDTH,
            transform: `scale(${htmlScale})`,
          }}
        />
      )}
    </div>
  );
}
