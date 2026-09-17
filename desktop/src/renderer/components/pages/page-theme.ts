// Theme delivery for a framed page (Phase 1 shell).
//
// The theme engine paints the app by writing CSS custom properties on <html>
// (theme-engine.ts → root.style.setProperty). A page runs in an opaque-origin
// frame that inherits none of that, so the host reads the same properties off
// the document and hands them over: once, baked into the document before it is
// framed (no flash of the wrong theme), and again by postMessage whenever the
// theme changes. The page never rebuilds — a <style> block is swapped, nothing
// else — so a theme change keeps its working state (scope §2).
//
// WHY a fixed token list rather than every custom property on :root: the app's
// root also carries layout/perf knobs (--right-pane-width, --panels-blur …)
// that mean nothing inside a page and would tempt page code to depend on
// host internals. The list below is the design guide's token vocabulary (§2)
// plus the radius and font scale, i.e. what the style kit is written against.

export const PAGE_THEME_TOKENS: readonly string[] = [
  'canvas', 'panel', 'inset', 'well',
  'accent', 'on-accent',
  'fg', 'fg-2', 'fg-dim', 'fg-muted', 'fg-faint',
  'edge', 'edge-dim',
  'link', 'link-hover',
  'destructive', 'destructive-fg', 'on-destructive',
  'radius', 'radius-sm', 'radius-md', 'radius-lg', 'radius-xl', 'radius-full',
  'font-sans', 'font-mono',
];

/** The message the host posts into a page frame when the theme changes. */
export const PAGE_THEME_MESSAGE = 'youcoded:theme';
/** The message a page posts to the host to save its own data (design §5). */
export const PAGE_DATA_SET_MESSAGE = 'youcoded:data:set';
export const PAGE_THEME_STYLE_ID = 'youcoded-theme';

/** Snapshot of the current theme as one `:root { … }` rule. Reads computed
 *  values, so it works whether a token came from a stylesheet or from the
 *  engine's inline setProperty. Unset tokens are skipped rather than emitted
 *  empty, so a page's own fallback (`var(--x, …)`) still applies. */
export function readThemeCss(root: HTMLElement = document.documentElement): string {
  const cs = getComputedStyle(root);
  const lines: string[] = [];
  for (const t of PAGE_THEME_TOKENS) {
    const v = cs.getPropertyValue(`--${t}`).trim();
    if (v) lines.push(`--${t}: ${v};`);
  }
  // color-scheme steers native controls (scrollbars, date pickers) inside the
  // frame the same way the host's <html> steers its own.
  const scheme = cs.getPropertyValue('color-scheme').trim() || cs.colorScheme;
  if (scheme) lines.push(`color-scheme: ${scheme};`);
  return `:root { ${lines.join(' ')} }`;
}

/** Runs INSIDE the page: applies theme updates the host posts, and gives the
 *  page `window.youcoded` — its saved data (baked in by the host, so it is
 *  there before the page's own scripts run; review F4), `save(data)` which
 *  posts the data to the host, and `onData(cb)` for a later refresh. Kept
 *  tiny and dependency-free because it is stringified into the page document. */
function bootstrap(dataJson: string): string {
  return `(function(){
  var ID = ${JSON.stringify(PAGE_THEME_STYLE_ID)};
  var THEME = ${JSON.stringify(PAGE_THEME_MESSAGE)};
  var SET = ${JSON.stringify(PAGE_DATA_SET_MESSAGE)};
  var subs = [];
  window.youcoded = {
    data: ${dataJson},
    save: function (data) { window.youcoded.data = data; try { parent.postMessage({ type: SET, data: data }, '*'); } catch (e) {} },
    onData: function (cb) { subs.push(cb); }
  };
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d) return;
    if (d.type === THEME && typeof d.css === 'string') {
      var el = document.getElementById(ID);
      if (!el) { el = document.createElement('style'); el.id = ID; document.head.appendChild(el); }
      el.textContent = d.css;
    }
  });
})();`;
}

/** Bakes the theme, the style kit and the bootstrap into a page document so
 *  the first paint is already in the live theme. Inserted at the top of
 *  <head> so the page's own styles still win on a tie. */
export function prepareHostedDocument(html: string, themeCss: string, kitCss: string, data: unknown = null): string {
  // `</script>` inside the data would end the script early; escape the one
  // sequence that matters in a JSON literal placed in a script.
  const dataJson = JSON.stringify(data ?? null).replace(/<\//g, '<\\/');
  const head =
    `<style id="${PAGE_THEME_STYLE_ID}">${themeCss}</style>` +
    `<style id="youcoded-kit">${kitCss}</style>` +
    `<script>${bootstrap(dataJson)}</script>`;
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + head + html.slice(m.index + m[0].length);
  const h = /<html[^>]*>/i.exec(html);
  if (h) return html.slice(0, h.index + h[0].length) + `<head>${head}</head>` + html.slice(h.index + h[0].length);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

/** Watches the host document for anything the theme engine touches — the
 *  inline style and data attributes on <html> and <body> — and reports the
 *  fresh CSS. Attribute-level, not a React subscription, so a theme-pack
 *  reload or the appearance sliders count too, not only a theme switch. */
export function watchThemeCss(onChange: (css: string) => void): () => void {
  let last = readThemeCss();
  const check = () => {
    const next = readThemeCss();
    if (next !== last) { last = next; onChange(next); }
  };
  const mo = new MutationObserver(check);
  mo.observe(document.documentElement, { attributes: true });
  mo.observe(document.body, { attributes: true });
  return () => mo.disconnect();
}
