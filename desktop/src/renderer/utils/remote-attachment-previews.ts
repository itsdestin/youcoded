// Pictures a phone browser picked, kept so the attachment card can show them (card #194, Destin 2026-11-12).
//
// WHY: the card loads a picture by `file://` address, which only the installed desktop app can follow; a phone browser
// showed the glyph instead. The browser, though, already HOLDS the picture it just uploaded, so the card can preview that
// copy — nothing is read from the computer, and no new permission is opened (the wider "full previews" that read the
// temp attachment folders were left for a later, security-reviewed card). Only for pictures the phone itself picked this
// page-load: after a reload the copy is gone and the card falls back to the file glyph, as before.
const previews = new Map<string, string>();
/** A phone rarely holds more than a handful of pending attachments; the oldest copies are released past this. */
const MAX_KEPT = 20;

/** Remember the browser's own copy of an uploaded picture, keyed by the computer-side path it was uploaded to. */
export function rememberAttachmentPreview(computerPath: string, file: Blob): void {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const old = previews.get(computerPath);
  if (old) URL.revokeObjectURL(old);
  previews.set(computerPath, URL.createObjectURL(file));
  while (previews.size > MAX_KEPT) {
    const first = previews.keys().next().value as string;
    URL.revokeObjectURL(previews.get(first)!);
    previews.delete(first);
  }
}

export function attachmentPreviewFor(computerPath: string): string | undefined {
  return previews.get(computerPath);
}

/** Tests only. */
export function clearAttachmentPreviews(): void {
  for (const u of previews.values()) URL.revokeObjectURL(u);
  previews.clear();
}
