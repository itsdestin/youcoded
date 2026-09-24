// desktop/src/renderer/components/artifact-views/RendererRegistry.ts
import { ComponentType, lazy } from 'react';
import { MarkdownView } from './MarkdownView';
import { CsvView } from './CsvView';
import { ImageView } from './ImageView';
import { HtmlView } from './HtmlView';
import { BinaryFallback } from './BinaryFallback';
import type { ArtifactViewProps } from './types';

export type { ArtifactViewProps } from './types';

type ViewSpec = ComponentType<ArtifactViewProps>;

// Heavy viewers (pdfjs / mammoth / SheetJS) are code-split via React.lazy so
// their bundles only load when a file of that type is opened. The Registry now
// returns a real component for every entry — ActiveArtifactView wraps the render
// in a <Suspense> boundary so the lazy ones resolve transparently.
const PdfView = lazy(() => import('./PdfView').then((m) => ({ default: m.PdfView })));
// CodeMirror editor — lazy like the other heavy viewers (~150KB + per-language
// chunks); ViewerErrorBoundary is REQUIRED around the render because lazy()
// THROWS chunk-load rejections (a real Android-offline failure mode).
const CodeEditorView = lazy(() => import('./CodeEditorView').then((m) => ({ default: m.CodeEditorView })));
const DocxView = lazy(() => import('./DocxView').then((m) => ({ default: m.DocxView })));
const XlsxView = lazy(() => import('./XlsxView').then((m) => ({ default: m.XlsxView })));

const REGISTRY: Record<string, ViewSpec> = {
  md: MarkdownView,
  markdown: MarkdownView,
  txt: MarkdownView, // shares the textarea path
  ts: CodeEditorView,
  tsx: CodeEditorView,
  js: CodeEditorView,
  jsx: CodeEditorView,
  py: CodeEditorView,
  css: CodeEditorView,
  json: CodeEditorView,
  yaml: CodeEditorView,
  yml: CodeEditorView,
  png: ImageView,
  jpg: ImageView,
  jpeg: ImageView,
  gif: ImageView,
  webp: ImageView,
  bmp: ImageView,
  ico: ImageView,
  avif: ImageView,
  html: HtmlView,
  htm: HtmlView,
  svg: ImageView,
  pdf: PdfView,
  docx: DocxView,
  xlsx: XlsxView,
  // CSV/TSV are extremely common agent output — a spreadsheet-style grid, not
  // a code dump. (Text path: content prop, no binary IPC.)
  csv: CsvView,
  tsv: CsvView,
};

/**
 * The component that renders EDIT mode. Distinct from getViewer because most
 * read-mode viewers have no edit UI at all — HtmlView is an iframe preview,
 * CsvView a grid — so "Edit" on those files rendered nothing (found in
 * review). md/markdown/txt keep MarkdownView's textarea (plan decision);
 * every other editable text file edits in the CodeMirror editor, whatever
 * its read-mode presentation is.
 */
export function getEditViewer(path: string): ViewSpec {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return MarkdownView;
  return CodeEditorView;
}

// Fix: a text-extension file whose BYTES sniffed binary (a .md or .ts holding
// NUL bytes) resolves from artifacts:get as content:null + binary:true. These
// viewers render from the text `content` prop, so routing them by extension
// showed a silent blank pane — they must fall back to BinaryFallback instead.
// HtmlView belongs here too: it also renders from `content` (srcDoc), and with
// null content it shows a PERPETUAL "Loading…" — an unresolvable claim, worse
// than blank (error-message-standards). Real binary viewers (Image/Pdf/Docx/
// Xlsx) read their own bytes from disk and keep extension routing.
const TEXT_CONTENT_VIEWERS: ReadonlySet<ViewSpec> = new Set([MarkdownView, CodeEditorView, CsvView, HtmlView]);

// Files whose viewer fetches its OWN bytes (BinaryContent -> artifacts:read-binary)
// and whose format is not text. For these the artifacts:get text fetch is pure
// waste -- and worse, it applied the TEXT EDITOR's 2 MB cap to a 2.3 MB photo and
// refused it (spec 2026-08-25 artifact-pane-size-limits, §1.1).
//
// Derived from REGISTRY + TEXT_CONTENT_VIEWERS rather than a second hand-kept
// extension list, so the two can never drift and any future binary viewer is
// covered automatically.
//
// SVG is the one deliberate exception: it renders through ImageView but is text
// and is editable today, so it keeps the text fetch or the pencil vanishes (D5).
export function rendersFromBytesOnly(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'svg') return false;
  const hit = REGISTRY[ext];
  return !!hit && !TEXT_CONTENT_VIEWERS.has(hit);
}

/** True when this viewer renders from the `content` string (and can therefore be
 *  showing only a PREFIX of a big file), as opposed to reading its own bytes.
 *  The partial-view banner is gated on this: an over-cap .svg or .html takes the
 *  text path but renders from bytes / a srcDoc, so a banner there would announce
 *  a partial view of something complete. */
export function isTextContentViewer(v: unknown): boolean {
  return TEXT_CONTENT_VIEWERS.has(v as ViewSpec);
}

// WHY its own check, not exporting CodeEditorView itself: doc comments (mockup,
// Style A) give code files a simpler, non-scroll-synced comments rail than
// MarkdownView's inline margin — ActiveArtifactView needs to know "is this the
// CM6 viewer" without importing the lazy chunk directly.
export function isCodeEditorViewer(v: unknown): boolean {
  return v === CodeEditorView;
}

export function getViewer(path: string, opts?: { textHint?: boolean; binaryHint?: boolean }): ViewSpec {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const hit = REGISTRY[ext];
  if (hit) {
    // Sniffed-binary override for text viewers only — see TEXT_CONTENT_VIEWERS.
    if (opts?.binaryHint && TEXT_CONTENT_VIEWERS.has(hit)) return BinaryFallback;
    return hit;
  }
  // D4: an unknown extension is no longer an automatic BinaryFallback. When the
  // artifacts:get response sniffed the bytes as TEXT (binary:false), route to
  // CodeView so rs/go/kt/sh/sql/toml/… and extensionless files render — and
  // edit — as code. No hint (older callers, pre-fetch renders) keeps the old
  // conservative fallback.
  if (opts?.textHint) return CodeEditorView;
  return BinaryFallback;
}
