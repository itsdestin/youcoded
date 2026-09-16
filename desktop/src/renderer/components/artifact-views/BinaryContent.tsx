import React from 'react';
import { useArtifactBytes } from './useArtifactBytes';
import { getPlatform, isRemoteMode } from '../../platform';
import { Button } from '../ui';
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

export function BinaryContent({ absolutePath, noun, children }: {
  absolutePath: string;
  /** What to call the file in messages: "document", "image", "spreadsheet", "PDF". */
  noun: string;
  children: (bytes: Uint8Array) => React.ReactElement;
}) {
  const { bytes, loading, error, sizeBytes } = useArtifactBytes(absolutePath);
  if (loading) return <CenterNote>Loading {noun}…</CenterNote>;
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
    return (
      <CenterNote>
        <div className="flex flex-col items-center gap-3">
          <span>{describeBytesError(error ?? 'read-failed', noun)}</span>
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
