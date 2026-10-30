// The Content-Security-Policy of the app's main page (renderer/index.html), built in ONE place.
//
// WHY it exists (2026-10-30 security audit F4): the app's own comments said "the app's CSP blocks file://" but there was none,
// so a stray script or a theme stylesheet could contact any website. Vite stamps this policy into index.html as a <meta> tag
// (vite.config.ts), which covers all three ways the page is served: the desktop window (file://), the phone's browser and
// the Android WebView.
//
// WHY script-src is still wide open (read before tightening — it was tried): the preview of an HTML file and an app "page" are
// <iframe srcdoc> documents, and a srcdoc frame INHERITS its parent's policy (measured in Electron 41: a parent with
// `script-src 'self'` silently blocks every inline script in the frame). Those frames must run inline scripts, the
// Tailwind/React/Vue CDN builds that need eval, and scripts from CDNs, so the page's script-src has to allow them too. The
// real fix is to serve those frames from their own address (as the Office editor's `office:` scheme already is) so they stop
// inheriting; only then can script-src become 'self'. Until then this policy still does the part that does not conflict:
// no network requests (fetch/XHR/beacon) except the app's own, the phone link and the worker API; no plugins; no form posts;
// frames only from the app's own schemes and https.
//
// The same inheritance means every source list below must stay wide enough for previews (https: images, styles, fonts).

/** Hosts the page itself calls with fetch(): the marketplace/account Worker. Game lobbies use a wss: socket (allowed below). */
const API_HOSTS = ['https://api.youcoded.ai'];

export function buildAppCsp(opts: { workbench?: boolean } = {}): string {
  // The UI workbench (a browser page with a fake backend, never shipped) fetches its Office sample documents from a local
  // practice editor server on a changing port. Nothing in the real app does this.
  const workbenchHosts = opts.workbench ? ' http://127.0.0.1:* http://localhost:*' : '';
  return [
    "default-src 'self'",
    // See the long note above: inline + eval + https because srcdoc frames inherit this list.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: file: theme-asset: https: http:",
    "font-src 'self' data: file: theme-asset: https:",
    "media-src 'self' data: blob: file: theme-asset: https:",
    // ws:/wss: because the phone app and a second computer connect to the host by address (any address); everything else
    // the page fetches is its own files, data:/blob: pictures and the Worker.
    `connect-src 'self' file: data: blob: theme-asset: ws: wss: ${API_HOSTS.join(' ')}${workbenchHosts}`,
    // about:srcdoc frames (previews, pages) are always allowed; office: is the document editor; https: for embeds in previews.
    "frame-src 'self' office: blob: https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    // No <form> may post anywhere (inherited by previews, which also set their own).
    "form-action 'none'",
  ].join('; ');
}
