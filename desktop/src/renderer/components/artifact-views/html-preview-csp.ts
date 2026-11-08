// The Content-Security-Policy every HTML preview frame carries (the full preview, HtmlView, and the card thumbnail).
//
// WHY (2026-10-30 security audit F1/F8): a previewed HTML file can come from anywhere — a downloaded file, a cloned project, a page
// the assistant wrote after reading something hostile. The frame already could not touch the app (opaque origin), but it could
// send whatever it could read to the internet, and the preview can pull in project files (html-inline-assets.ts). This policy
// closes the doors that exist only to SEND: fetch/XHR/WebSocket/beacons (connect-src 'none'), form posts, prefetching, plugins.
//
// WHAT IS DELIBERATELY STILL ALLOWED, and the cost: a preview is meant to look and run like the real page, and mockups made by
// an assistant lean on public CDNs, so https scripts, styles, fonts, images and embedded frames still load, and inline scripts
// (and eval, which the Vue/Alpine/Babel CDN builds use) still run. A page can therefore still leak small amounts of text by
// requesting an image whose address carries it. That residue is accepted; the data SOURCE is narrowed instead (only
// stylesheets/scripts/images of the matching file type are pulled in from the project - html-inline-assets.ts), and a
// preview that wants the network for its own data (fetch to an API) stops working - that is the trade the audit asked for.
//
// Two layers on purpose: the iframe `csp` attribute (Chromium: Electron, Android, Chrome/Edge phones — enforced from outside, so
// the page cannot remove it) plus the same policy as a <meta> inside the document (Safari/Firefox on a phone's browser ignore
// the attribute). They say the same thing, so wherever both apply they simply agree.
// The app's own page policy is inherited by srcdoc frames as well (src/shared/app-csp.ts explains why); a frame's effective
// policy is the intersection of all of them, so this one can only narrow.

/** Full interactive preview: runs scripts, loads public assets, sends nothing. */
export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob: https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https: http:",
  "font-src data: https:",
  "media-src data: blob: https:",
  // data:/blob: never leave the computer (a game fetching its own embedded asset keeps working); everything else is closed.
  "connect-src data: blob:",
  "frame-src https: data: blob:",
  "worker-src blob:",
  "object-src 'none'",
  "form-action 'none'",
].join('; ');

/** Card thumbnail: scripts are already off (empty sandbox); keep the sight-only loads and nothing else. */
export const HTML_THUMBNAIL_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https: http:",
  "font-src data: https:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
].join('; ');

/** Props for the <iframe>: spread them so React passes the (non-standard in TS) `csp` attribute through. */
export const previewFrameProps = (policy: string): Record<string, string> => ({ csp: policy });

/** The same policy as a <meta>, placed so it comes before the page's own markup without disturbing standards mode:
 *  after a leading doctype (a node before the doctype would flip the page to quirks mode and change how it draws). */
export function withPolicyMeta(html: string, policy: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, '&quot;')}"><meta http-equiv="x-dns-prefetch-control" content="off">`;
  // Optional BOM, whitespace and comments may precede the doctype and are still "before the doctype" for the parser.
  const lead = /^(?:﻿|\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(html);
  if (lead) return html.slice(0, lead[0].length) + meta + html.slice(lead[0].length);
  return meta + html;
}
