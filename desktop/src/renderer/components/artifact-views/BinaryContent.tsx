import React from 'react';
import { useArtifactBytes } from './useArtifactBytes';
import { getPlatform, isRemoteMode } from '../../platform';
import { Button, ErrorState, LoadingState } from '../ui';
import { RemoteFileCard } from './RemoteFileCard';

// Shared loading/error shell for every binary viewer (pdf/docx/xlsx/image).
// Each viewer previously re-wired useArtifactBytes + its own loading/error
// branches — and PdfView forgot them entirely, leaving a permanently blank
// pane on a failed read. Centralizing the states here makes that bug class
// impossible: the inner viewer component only ever mounts with real bytes.
//
// The child is keyed by absolutePath so ALL of its internal state (parsed
// sheets, rendered html, selection, parse errors) resets when the user
// switches files — no stale-content flash from the previous document.

/** Map the read-binary error codes to a human message. Exported so a test can
 *  pin that no message names a control this component does not render. */
export function describeBytesError(error: string, noun: string): string {
  switch (error) {
    case 'orphan':
      return `This ${noun} no longer exists on disk.`;
    case 'too-large':
      // Was: "…use “Open externally”" — a control this component never rendered.
      // The button below is that control, finally present.
      return `This ${noun} is larger than YouCoded can display.`;
    case 'not-allowed':
      return `This ${noun} is outside your project folders and can’t be previewed.`;
    case 'unavailable':
      return `Preview isn’t available on this platform.`;
    default:
      return `Couldn’t open this ${noun}.`;
  }
}

export function CenterNote({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-center h-full text-fg-muted text-sm p-4 text-center">{children}</div>;
}

/** A viewer's wait, centred in the pane.
 *  WHY (guide "File viewers" known deviation, 2026-10-13): each viewer said its own loading words
 *  in plain grey ("Loading…", "Loading viewer…") outside the shared LoadingState, so they read and
 *  looked different. One shared piece now: the braille spinner and "Loading <what>…". */
export function CenterLoading({ what }: { what: string }) {
  return (
    <div className="flex items-center justify-center h-full p-4">
      <LoadingState what={what} />
    </div>
  );
}

/** The read failures a second try can fix: the file came back, or the read itself failed.
 *  Size, permission and platform refusals answer the same way every time, so they keep their
 *  note (and Open in default app) rather than gaining a Try again that cannot help. */
const SAME_ANSWER_EVERY_TIME = new Set(['too-large', 'not-allowed', 'unavailable']);
function isRetryableBytesError(error: string): boolean {
  return !SAME_ANSWER_EVERY_TIME.has(error);
}

export function BinaryContent({ absolutePath, noun, children }: {
  absolutePath: string;
  /** What to call the file in messages: "document", "image", "spreadsheet", "PDF". */
  noun: string;
  children: (bytes: Uint8Array) => React.ReactElement;
}) {
  const { bytes, loading, error, sizeBytes, reload } = useArtifactBytes(absolutePath);
  if (loading) return <CenterLoading what={noun} />;
  if (error === 'too-large' && isRemoteMode()) {
    // Over remote access the host refuses a file over the phone's preview
    // ceiling with its size; the phone offers Download instead of a preview
    // (questions deck 2026-09-10, Q-6/Q-8). Desktop keeps the message below.
    return <RemoteFileCard path={absolutePath} sizeBytes={sizeBytes} reason="too-large" />;
  }
  if (error || !bytes) {
    // The action the old copy pointed at but never rendered. Desktop-only for
    // the same reason BinaryFallback gates it: shell.openPath is a no-op on
    // remote and absent on Android, so the button would silently do nothing.
    const isElectron = getPlatform() === 'electron';
    const code = error ?? 'read-failed';
    if (isRetryableBytesError(code)) {
      // WHY ErrorState (guide "File viewers" known deviation, 2026-10-13; CLAUDE.md "specific
      // accurate detail + Try again for recoverable failures"): a failed Word / PDF / Excel /
      // image read was a grey sentence with nothing to press on a phone. Now the shared error
      // box, the same as the text viewer's failed read (ActiveArtifactView), with Try again
      // re-running the read and Open in default app kept beside it on desktop.
      return (
        <div className="p-4">
          <ErrorState
            message={describeBytesError(code, noun)}
            onRetry={reload}
            moreActions={isElectron ? [{ label: 'Open in default app', onClick: () => (window.claude as any).shell?.openPath?.(absolutePath) }] : undefined}
          />
        </div>
      );
    }
    return (
      <CenterNote>
        <div className="flex flex-col items-center gap-3">
          <span>{describeBytesError(code, noun)}</span>
          {isElectron && (
            <Button size="sm" onClick={() => (window.claude as any).shell?.openPath?.(absolutePath)}>
              Open in default app
            </Button>
          )}
        </div>
      </CenterNote>
    );
  }
  return <React.Fragment key={absolutePath}>{children(bytes)}</React.Fragment>;
}
