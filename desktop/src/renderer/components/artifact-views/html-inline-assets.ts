// Inline an HTML artifact's RELATIVE local assets so the preview renders the
// way the page actually looks (Destin's review: an index.html referencing
// styles.css / game.js rendered unstyled and inert). srcDoc previews have no
// base URL and file:// subresources are refused, so relative refs can
// never load on their own — instead the sibling files are fetched through the
// guarded artifacts:read-binary IPC and inlined: stylesheets become <style>,
// scripts become inline <script>, images/fonts become data: URIs.
//
// Scope rules:
// - Only RELATIVE refs are touched (no scheme, no //, no leading /) — http(s)
//   and data: refs already work in the sandboxed iframe.
// - Fetch failures leave the original ref in place (same non-render as today).
// - readBinary is the fetch path on purpose: it carries the project-roots
//   allowlist + sensitive-path deny + 50MB cap, so an HTML file cannot be used
//   to lift files the binary viewers could not already read.
// - v1 limits: url(...) refs INSIDE fetched CSS are not chased, and at most
//   MAX_ASSETS refs are inlined (a runaway page degrades to partial styling,
//   not a hung preview).

const MAX_ASSETS = 40;

// WHY a file-type check per kind of reference (2026-10-30 audit F1): the HTML file chooses the path, so `<link rel=stylesheet
// href="../../notes/secret.txt">` used to paste ANY readable text file into a <style> element where the page's own script could
// read it back. A stylesheet reference now inlines only a .css file, a script reference only script files; pictures and fonts
// were already limited by their extension tables.
const STYLESHEET_EXT = new Set(['css']);
const SCRIPT_EXT = new Set(['js', 'mjs', 'cjs']);
function hasExt(ref: string, allowed: Set<string>): boolean {
  const name = ref.split(/[?#]/)[0].split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && allowed.has(name.slice(dot + 1).toLowerCase());
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  svg: 'image/svg+xml',
};
const FONT_MIME: Record<string, string> = {
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};

function isRelativeRef(ref: string | null): ref is string {
  if (!ref) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false; // http:, data:, mailto:…
  if (ref.startsWith('//') || ref.startsWith('/') || ref.startsWith('#')) return false;
  return true;
}

/** Resolve `ref` against the html file's directory, folding ./ and ../ . */
export function resolveRelativeRef(htmlAbsPath: string, ref: string): string {
  const fwd = htmlAbsPath.replace(/\\/g, '/');
  const baseDir = fwd.slice(0, fwd.lastIndexOf('/') + 1);
  const clean = ref.split(/[?#]/)[0]; // strip query/fragment for the disk path
  const parts = (baseDir + clean).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.' || (p === '' && out.length > 0)) continue;
    if (p === '..') { out.pop(); continue; }
    out.push(p);
  }
  return out.join('/');
}

async function fetchBytes(absPath: string): Promise<Uint8Array | null> {
  try {
    const res = await (window.claude as any).artifacts?.readBinary?.(absPath);
    if (!res?.ok || typeof res.base64 !== 'string') return null;
    return Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const decodeText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
function toDataUri(bytes: Uint8Array, mime: string): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(bin)}`;
}

/**
 * Returns the HTML string with relative local assets inlined. Never throws —
 * any failure returns the input unchanged.
 */
export async function inlineLocalAssets(html: string, htmlAbsPath: string): Promise<string> {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let budget = MAX_ASSETS;
    const jobs: Promise<void>[] = [];
    const take = () => (budget-- > 0);

    // <link rel="stylesheet" href> → <style>
    for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet" i][href]'))) {
      const ref = link.getAttribute('href');
      if (!isRelativeRef(ref) || !hasExt(ref, STYLESHEET_EXT) || !take()) continue;
      jobs.push(fetchBytes(resolveRelativeRef(htmlAbsPath, ref)).then((bytes) => {
        if (!bytes) return;
        const style = doc.createElement('style');
        style.textContent = decodeText(bytes);
        link.replaceWith(style);
      }));
    }
    // <script src> → inline script (executes in the sandboxed opaque-origin
    // frame exactly as a remote script would — same trust boundary as today).
    for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
      const ref = script.getAttribute('src');
      if (!isRelativeRef(ref) || !hasExt(ref, SCRIPT_EXT) || !take()) continue;
      jobs.push(fetchBytes(resolveRelativeRef(htmlAbsPath, ref)).then((bytes) => {
        if (!bytes) return;
        script.removeAttribute('src');
        script.textContent = decodeText(bytes);
      }));
    }
    // <img src> / <source src|srcset(single)> / <link rel=icon> → data: URIs
    const imageish = [
      ...Array.from(doc.querySelectorAll('img[src]')),
      ...Array.from(doc.querySelectorAll('link[rel~="icon" i][href]')),
    ];
    for (const el of imageish) {
      const attr = el.tagName === 'LINK' ? 'href' : 'src';
      const ref = el.getAttribute(attr);
      if (!isRelativeRef(ref) || !take()) continue;
      const ext = ref.split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? '';
      const mime = IMAGE_MIME[ext] ?? FONT_MIME[ext];
      if (!mime) continue;
      jobs.push(fetchBytes(resolveRelativeRef(htmlAbsPath, ref)).then((bytes) => {
        if (bytes) el.setAttribute(attr, toDataUri(bytes, mime));
      }));
    }

    if (jobs.length === 0) return html;
    await Promise.all(jobs);
    const doctype = /^\s*<!doctype/i.test(html) ? '<!DOCTYPE html>\n' : '';
    return doctype + doc.documentElement.outerHTML;
  } catch {
    return html;
  }
}
