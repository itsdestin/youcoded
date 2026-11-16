// Clipboard helpers for the chat context menu.
//
// navigator.clipboard requires a secure context (https / localhost). The remote
// browser access mode serves the UI over plain http to a LAN/Tailscale IP, where
// the async Clipboard API is unavailable — so writes fall back to a hidden
// textarea + execCommand('copy'), the same fallback ShareSheet.tsx already uses.

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand path (insecure origin / denied permission)
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Keep it out of view and out of the layout while still selectable.
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Read clipboard text for Paste. Returns null when unavailable (insecure origin,
// denied permission) — the caller then no-ops rather than inserting garbage.
export async function readText(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch {
    // insecure origin or permission denied
  }
  return null;
}

// Card #143 a: copy a picture from the page itself — for a phone or remote browser, whose clipboard is its own (the
// computer's windows ask the computer instead, shell.pictureAction). A website picture from another origin cannot be read
// here (no CORS), so this can fail; the caller says so rather than guessing why. Browsers only accept PNG on the clipboard,
// so another format is redrawn as PNG first.
export function canCopyImageHere(): boolean {
  return typeof ClipboardItem !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.clipboard?.write;
}

export async function copyImageFromPage(src: string): Promise<boolean> {
  try {
    if (!canCopyImageHere()) return false;
    const res = await fetch(src);
    if (!res.ok) return false;
    let blob = await res.blob();
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width; canvas.height = bmp.height;
      canvas.getContext('2d')?.drawImage(bmp, 0, 0);
      blob = await new Promise<Blob>((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error('no png'))), 'image/png'));
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}
