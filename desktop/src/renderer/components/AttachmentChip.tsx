// AttachmentChip — one attached file in the composer's row above the input
// box. Design C from dev/workbench/mockups/AttachmentChips.tsx, picked by
// Destin 2026-08-27 (ledger P-19): a 128×96 card, preview on top, the file
// name in a 12px strip along the bottom with its type glyph, the ✕ ALWAYS
// visible top-right (the old 48px chip hid it until hover — invisible on a
// phone, where there is no hover).
//
// Preview per kind (shared/artifacts/categorization.ts → previewKind):
//   image    → the picture (file://, as the old chip); a load failure falls
//              back to the glyph, never the browser's broken-image icon
//   markdown → the first ~600 bytes RENDERED (MarkdownHeadPreview)
//   text     → the first ~600 bytes in a mono block (MonoHeadPreview)
//   glyph    → big type icon + extension in caps (pdf, office, media, …)
// The head is read once per path over fs:read-head and cached module-wide, so
// re-renders of the composer (every keystroke) never re-read a file.
//
// The mock-up page renders THIS component for its section C so the page
// cannot drift from what shipped; `imageSrc` exists so that page (a browser
// tab, where file:// cannot load) and the tests can hand it a data URI.
import React, { useEffect, useRef, useState } from 'react';
import { Button } from './ui/Button';
import { FileKindIcon } from './project-view/icons';
import { fileExtension, fileKind, previewKind } from '../../shared/artifacts/categorization';
import { READ_HEAD_DEFAULT_BYTES, type ReadHeadResult } from '../../shared/read-head';
import { MarkdownHeadPreview, MonoHeadPreview } from './HeadPreview';
import { useOnRemoteReconnect } from '../hooks/useOnRemoteReconnect';

// ── Head cache ───────────────────────────────────────────────────────────────
// Keyed by path; holds the in-flight promise so two chips for the same file
// (or a re-mount) share one IPC round trip. Attachments are short-lived and
// user-picked, so a stale entry costs at most one out-of-date preview.
const headCache = new Map<string, Promise<ReadHeadResult>>();

/** Tests only — the cache is module state and would leak between cases. */
export function clearFileHeadCache(): void {
  headCache.clear();
}

function readHead(path: string): Promise<ReadHeadResult> {
  let p = headCache.get(path);
  if (!p) {
    const fn = (window as any).claude?.fs?.readHead as
      | ((filePath: string, maxBytes?: number) => Promise<ReadHeadResult>)
      | undefined;
    p = typeof fn === 'function'
      ? fn(path, READ_HEAD_DEFAULT_BYTES).catch((e: unknown) => ({ ok: false as const, error: String(e) }))
      : Promise.resolve({ ok: false as const, error: 'fs.readHead unavailable' });
    // WHY a failure leaves the cache: it was kept for the page's life, so a preview whose
    // read was lost (a phone's connection dropping) stayed failed until the page reloaded
    // (2026-09-11 phone pass sweep). Only a successful read is shared; a failed one is
    // asked again by the next chip, or by this one after a remote reconnect.
    const settled = p;
    void settled.then((res) => { if (!res.ok && headCache.get(path) === settled) headCache.delete(path); });
    headCache.set(path, p);
  }
  return p;
}

type HeadState = { status: 'loading' } | { status: 'ready'; text: string } | { status: 'failed' };

/** The file head for a text-like preview. `enabled=false` never reads. */
function useFileHead(path: string, enabled: boolean): HeadState {
  const [state, setState] = useState<HeadState>({ status: 'loading' });
  // A failed preview reads again after a remote reconnect (see readHead's WHY).
  const [retry, setRetry] = useState(0);
  const failedRef = useRef(false);
  failedRef.current = state.status === 'failed';
  useOnRemoteReconnect(() => { if (failedRef.current) setRetry((n) => n + 1); });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    readHead(path).then((res) => {
      if (cancelled) return;
      setState(res.ok && res.text.trim().length > 0 ? { status: 'ready', text: res.text } : { status: 'failed' });
    });
    return () => { cancelled = true; };
  }, [path, enabled, retry]);
  return enabled ? state : { status: 'failed' };
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function fileNameOf(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

function fileUrl(path: string): string {
  return `file://${path.replace(/\\/g, '/')}`;
}

/** Big type glyph + extension in caps — the preview for anything the card
 *  can't cheaply render, and the fallback when a preview fails. */
function GlyphPreview({ path }: { path: string }) {
  const ext = fileExtension(path);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-0.5 text-fg-muted" data-testid="glyph-preview">
      <FileKindIcon kind={fileKind(path)} size={28} />
      <span className="text-3xs uppercase tracking-wide">{ext || 'file'}</span>
    </div>
  );
}

function Preview({ path, imageSrc }: { path: string; imageSrc?: string }) {
  const kind = previewKind(path);
  const [imgFailed, setImgFailed] = useState(false);
  const head = useFileHead(path, kind === 'markdown' || kind === 'text');

  if (kind === 'image' && !imgFailed) {
    return (
      <img
        src={imageSrc ?? fileUrl(path)}
        alt=""
        loading="lazy"
        className="w-full h-full object-cover"
        // A path the renderer origin can't load must not leave a broken-image
        // icon behind — swap to the glyph instead.
        onError={() => setImgFailed(true)}
      />
    );
  }
  if (kind === 'markdown' && head.status === 'ready') return <MarkdownHeadPreview text={head.text} />;
  if (kind === 'text' && head.status === 'ready') return <MonoHeadPreview text={head.text} />;
  return <GlyphPreview path={path} />;
}

// ── The chip ─────────────────────────────────────────────────────────────────

interface Props {
  path: string;
  /** Display name; derived from the path when absent. */
  name?: string;
  onRemove: () => void;
  /** Override for the image source (tests, and the mock-up page in a browser
   *  tab where file:// can't load). Shipping callers leave it unset. */
  imageSrc?: string;
}

export function AttachmentChip({ path, name, onRemove, imageSrc }: Props) {
  const label = name ?? fileNameOf(path);
  const kind = fileKind(path);
  return (
    <div
      title={label}
      data-file-kind={kind}
      className="relative shrink-0 w-32 h-24 rounded-md border border-edge bg-panel overflow-hidden flex flex-col"
    >
      <div className="flex-1 min-h-0 bg-inset overflow-hidden">
        <Preview path={path} imageSrc={imageSrc} />
      </div>
      <div className="flex items-center gap-1 px-1.5 h-5 border-t border-edge bg-panel text-fg text-xs shrink-0">
        <span className="text-fg-dim shrink-0"><FileKindIcon kind={kind} size={12} /></span>
        <span className="truncate min-w-0">{label}</span>
      </div>
      {/* In-chip remover, NOT a panel closer — CloseButton's 28px would cover a
          third of the card. Destin's call (spec §11.8 F): keep the 16px
          geometry, the accessible name and the focus ring. Always visible
          (no hover-only opacity) with a panel fill + border so it stays
          legible over a photo. Still owed a `.coarse-hit` pass: 16px is well
          under the ~44dp touch guideline and this renderer is the Android UI. */}
      {/* WHY variant/size instead of a className restyle (2026-09-16): the design
          check flagged this as a ghost button rebuilt by hand. raised + icon-xs are
          the same look as shared styles; icon-xs keeps the touch-size hit area. */}
      <Button
        variant="raised"
        size="icon-xs"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="absolute top-1 right-1"
      >
        ×
      </Button>
    </div>
  );
}
