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

const PAGE_THEME_TOKENS: readonly string[] = [
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
/** Posted when Esc is pressed inside the page: the frame has focus, so the
 *  host's own Esc handling never sees the key (design review, item 7). */
export const PAGE_ESC_MESSAGE = 'youcoded:esc';
/** Host → page: the page's saved data changed underneath it (a sync arrival,
 *  or another window). This is what makes `youcoded.onData` fire — before
 *  Phase 2 a page could register a callback nothing ever called. */
export const PAGE_DATA_MESSAGE = 'youcoded:data';
/** Host → page: the band's refresh button was pressed, so fetch again (§5). */
export const PAGE_REFRESH_MESSAGE = 'youcoded:refresh';
/** Page → host: `youcoded.fetch(url, opts)`, carrying its own request id. */
export const PAGE_FETCH_MESSAGE = 'youcoded:fetch';
/** Host → page: the answer to one `youcoded:fetch`, matched by request id. */
export const PAGE_FETCH_RESULT_MESSAGE = 'youcoded:fetch:result';
/** The live socket (spec 2026-10-04). Page → host: open / send / close, each
 *  carrying the page's OWN socket id; host → page: one event kind for both a
 *  state change and a batch of messages, matched by that same id. */
export const PAGE_SOCKET_OPEN_MESSAGE = 'youcoded:socket:open';
export const PAGE_SOCKET_SEND_MESSAGE = 'youcoded:socket:send';
export const PAGE_SOCKET_CLOSE_MESSAGE = 'youcoded:socket:close';
export const PAGE_SOCKET_EVENT_MESSAGE = 'youcoded:socket:event';
/** Camera video (spec 2026-10-04, Part 2). Page → host: start / stop / ack (the
 *  page is done with the picture numbered `n`); host → page: one event kind for a
 *  state change and for a picture (an ImageBitmap, transferred). */
export const PAGE_VIDEO_START_MESSAGE = 'youcoded:video:start';
export const PAGE_VIDEO_STOP_MESSAGE = 'youcoded:video:stop';
export const PAGE_VIDEO_ACK_MESSAGE = 'youcoded:video:ack';
export const PAGE_VIDEO_EVENT_MESSAGE = 'youcoded:video:event';
const PAGE_THEME_STYLE_ID = 'youcoded-theme';

/** True when the app's page pane is glass: the theme has a wallpaper/gradient
 *  AND the chrome style is floating or float. This is EXACTLY the condition
 *  under which styles/globals.css ("Screens in floating chrome") and
 *  styles/float-chrome.css make `.screen-pane` see-through, so a page that goes
 *  transparent here is always sitting on glass and never on a hole. WHY here and
 *  not in CSS: the page lives in a sandboxed frame and cannot see the host's
 *  attributes, so the host reads them and tells it. */
export function paneIsGlass(root: HTMLElement = document.documentElement, body: HTMLElement = document.body): boolean {
  const style = body.getAttribute('data-chrome-style');
  return root.hasAttribute('data-wallpaper') && (style === 'floating' || style === 'float');
}

/** The attribute the page's own CSS keys on (`:root[data-yc-see-through]`). */
export const PAGE_SEE_THROUGH_ATTR = 'data-yc-see-through';

/** Snapshot of the current theme as one `:root { … }` rule. Reads computed
 *  values, so it works whether a token came from a stylesheet or from the
 *  engine's inline setProperty. Unset tokens are skipped rather than emitted
 *  empty, so a page's own fallback (`var(--x, …)`) still applies. */
export function readThemeCss(root: HTMLElement = document.documentElement, seeThrough = false): string {
  const cs = getComputedStyle(root);
  const lines: string[] = [];
  for (const t of PAGE_THEME_TOKENS) {
    const v = cs.getPropertyValue(`--${t}`).trim();
    if (v) lines.push(`--${t}: ${v};`);
  }
  // The theme's glass density, only while the page is see-through: a page that
  // lets the wallpaper show draws its own cards with the same recipe the app's
  // panes use (--panel at --panels-opacity). Not in the token list: it means
  // nothing to a page that is not see-through.
  if (seeThrough) {
    const op = Number.parseFloat(cs.getPropertyValue('--panels-opacity'));
    lines.push(`--panels-opacity: ${Number.isFinite(op) ? op : 1};`);
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
 *  posts the data to the host, `onData(cb)` for a later change, `fetch(url,
 *  opts)` (the page's only door out — a postMessage round trip the host
 *  forwards to `pages:fetch`, design §5) and `onRefresh(cb)` for the band's
 *  refresh button. Kept tiny and dependency-free because it is stringified
 *  into the page document.
 *
 *  WHY the two guards in the message listener: the frame is sandboxed with
 *  allow-popups, so a window this page opened holds `opener` and can post to
 *  it. `e.source !== parent` drops anything that did not come from the host,
 *  and every answer is matched against this bootstrap's own request map, so a
 *  forged `youcoded:fetch:result` resolves nothing (design review 1, finding 8). */
function bootstrap(dataJson: string, devicesJson = '{}'): string {
  return `(function(){
  var ID = ${JSON.stringify(PAGE_THEME_STYLE_ID)};
  var THEME = ${JSON.stringify(PAGE_THEME_MESSAGE)};
  var SET = ${JSON.stringify(PAGE_DATA_SET_MESSAGE)};
  var ESC = ${JSON.stringify(PAGE_ESC_MESSAGE)};
  var DATA = ${JSON.stringify(PAGE_DATA_MESSAGE)};
  var REFRESH = ${JSON.stringify(PAGE_REFRESH_MESSAGE)};
  var FETCH = ${JSON.stringify(PAGE_FETCH_MESSAGE)};
  var RESULT = ${JSON.stringify(PAGE_FETCH_RESULT_MESSAGE)};
  var S_OPEN = ${JSON.stringify(PAGE_SOCKET_OPEN_MESSAGE)};
  var S_SEND = ${JSON.stringify(PAGE_SOCKET_SEND_MESSAGE)};
  var S_CLOSE = ${JSON.stringify(PAGE_SOCKET_CLOSE_MESSAGE)};
  var S_EVENT = ${JSON.stringify(PAGE_SOCKET_EVENT_MESSAGE)};
  var V_START = ${JSON.stringify(PAGE_VIDEO_START_MESSAGE)};
  var V_STOP = ${JSON.stringify(PAGE_VIDEO_STOP_MESSAGE)};
  var V_ACK = ${JSON.stringify(PAGE_VIDEO_ACK_MESSAGE)};
  var V_EVENT = ${JSON.stringify(PAGE_VIDEO_EVENT_MESSAGE)};
  var videos = {};
  var videoSeq = 0;
  var sockets = {};
  var socketSeq = 0;
  var subs = [];
  var refreshSubs = [];
  var waiting = {};
  var seq = 0;
  function call(list, arg) {
    for (var i = 0; i < list.length; i++) { try { list[i](arg); } catch (err) {} }
  }
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { try { parent.postMessage({ type: ESC }, '*'); } catch (err) {} }
  });
  window.youcoded = {
    data: ${dataJson},
    // Home-device deck, Q-address: the page suggested an address but the
    // person may have allowed another, so the page asks here where its device
    // is. Only ALLOWED devices appear; a page waiting for a yes sees none.
    devices: ${devicesJson},
    save: function (data) { window.youcoded.data = data; try { parent.postMessage({ type: SET, data: data }, '*'); } catch (e) {} },
    onData: function (cb) { if (typeof cb === 'function') subs.push(cb); },
    onRefresh: function (cb) { if (typeof cb === 'function') refreshSubs.push(cb); },
    // A live connection to the page's approved home device. The host owns the
    // real one; this is a handle. Every 'open' is a fresh connection: wait for
    // the device's own "logged in" reply in onMessages before subscribing, and
    // subscribe again after every 'open'. send() is refused unless 'open'.
    socket: function (url, opts) {
      var o = opts || {};
      var id = 's' + (++socketSeq);
      var rec = { state: 'connecting', onState: o.onState, onMessages: o.onMessages };
      sockets[id] = rec;
      try { parent.postMessage({ type: S_OPEN, id: id, url: String(url) }, '*'); }
      catch (e) { rec.state = 'closed'; delete sockets[id]; }
      return {
        send: function (text) {
          if (rec.state !== 'open' || typeof text !== 'string') return false;
          try { parent.postMessage({ type: S_SEND, id: id, text: text }, '*'); return true; } catch (e) { return false; }
        },
        close: function () {
          if (!sockets[id]) return;
          delete sockets[id];
          rec.state = 'closed';
          try { parent.postMessage({ type: S_CLOSE, id: id }, '*'); } catch (e) {}
        }
      };
    },
    // Live camera video, played by the app: the page names a device connection and
    // a camera, and gets PICTURES (ImageBitmaps) — never an address or a stream.
    // onFrame(bitmap, ack): draw it on a canvas, then call ack() to ask for the next.
    // onState('starting' | 'playing' | 'stopped', why). stop() ends it.
    video: function (connection, target, opts) {
      var o = opts || {};
      var id = 'v' + (++videoSeq);
      var rec = { state: 'starting', onFrame: o.onFrame, onState: o.onState };
      videos[id] = rec;
      try { parent.postMessage({ type: V_START, id: id, connection: String(connection), target: String(target) }, '*'); }
      catch (e) { rec.state = 'stopped'; delete videos[id]; }
      return {
        stop: function () {
          if (!videos[id]) return;
          delete videos[id];
          rec.state = 'stopped';
          try { parent.postMessage({ type: V_STOP, id: id }, '*'); } catch (e) {}
        }
      };
    },
    fetch: function (url, opts) {
      return new Promise(function (resolve, reject) {
        var o = opts || {};
        var id = 'f' + (++seq);
        waiting[id] = { resolve: resolve, reject: reject };
        try {
          parent.postMessage({
            type: FETCH, id: id, url: String(url),
            method: o.method, headers: o.headers, body: o.body, as: o.as, socket: o.socket
          }, '*');
        } catch (e) {
          delete waiting[id];
          reject(new Error('This page could not reach YouCoded.'));
        }
      });
    }
  };
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var d = e && e.data;
    if (!d) return;
    if (d.type === THEME && typeof d.css === 'string') {
      var el = document.getElementById(ID);
      if (!el) { el = document.createElement('style'); el.id = ID; document.head.appendChild(el); }
      el.textContent = d.css;
      // The host says whether the app's pane behind this page is glass (and the
      // person has not switched it off): the page turns see-through with it, live.
      document.documentElement.toggleAttribute(${JSON.stringify(PAGE_SEE_THROUGH_ATTR)}, d.seeThrough === true);
      return;
    }
    if (d.type === S_EVENT && typeof d.id === 'string') {
      // Matched by this page's own id: a forged event for an id it never made resolves nothing.
      var sr = sockets[d.id];
      if (!sr) return;
      if (d.kind === 'state' && typeof d.state === 'string') {
        sr.state = d.state;
        if (d.state === 'closed') delete sockets[d.id];
        if (typeof sr.onState === 'function') { try { sr.onState(d.state, typeof d.why === 'string' ? d.why : undefined); } catch (err) {} }
      } else if (d.kind === 'messages' && Array.isArray(d.texts) && typeof sr.onMessages === 'function') {
        try { sr.onMessages(d.texts.filter(function (t) { return typeof t === 'string'; })); } catch (err) {}
      }
      return;
    }
    if (d.type === V_EVENT && typeof d.id === 'string') {
      // Matched by this page's own id: a forged event for an id it never made resolves nothing.
      var vr = videos[d.id];
      if (!vr) { if (d.bitmap && typeof d.bitmap.close === 'function') { try { d.bitmap.close(); } catch (err) {} } return; }
      if (d.kind === 'state' && typeof d.state === 'string') {
        vr.state = d.state;
        if (d.state === 'stopped') delete videos[d.id];
        if (typeof vr.onState === 'function') { try { vr.onState(d.state, typeof d.why === 'string' ? d.why : undefined); } catch (err) {} }
      } else if (d.kind === 'frame' && d.bitmap) {
        var vn = d.n, finished = false;
        var release = function () { if (finished) return; finished = true; try { parent.postMessage({ type: V_ACK, id: d.id, n: vn }, '*'); } catch (err) {} };
        if (typeof vr.onFrame === 'function') { try { vr.onFrame(d.bitmap, release); } catch (err) { release(); } }
        else { try { d.bitmap.close(); } catch (err) {} release(); }
      }
      return;
    }
    if (d.type === DATA) { window.youcoded.data = d.data; call(subs, d.data); return; }
    if (d.type === REFRESH) { call(refreshSubs); return; }
    if (d.type === RESULT) {
      var p = waiting[d.id];
      if (!p) return;
      delete waiting[d.id];
      var r = d.result;
      if (r && r.ok) p.resolve({ status: r.status, headers: r.headers, body: r.body });
      else p.reject(new Error((r && r.message) || 'The request was refused.'));
    }
  });
})();`;
}

/** The policy the framed document carries, built from what the page is allowed
 *  to reach (design §6). `connect-src 'none'` on every page, including an open
 *  one: the page's only door is `youcoded.fetch`, which main checks against the
 *  approvals on disk, so the browser's own network is closed either way.
 *
 *  WHY `webrtc 'block'` and the DNS-prefetch meta: ICE gathering and link
 *  prefetching are not `connect-src`, and both reach an attacker's nameserver
 *  (design review 1, finding 9). `'unsafe-inline'` for script and style is not
 *  a hole — the page's own code is the thing being sandboxed, and the frame is
 *  an opaque origin with no app access. */
function pageCsp(connections: readonly { kind: string }[]): string {
  // An open page may SHOW pictures, video and webfonts from the internet
  // (deck Q-open: a reader page is useless without them). It still cannot
  // open a socket of its own.
  const open = connections.some((c) => c.kind === 'open');
  // A recorded clip arrives as a data: link from youcoded.fetch(url, {as:'video'})
  // (spec 2026-10-04, Part 3). WHY only with a device connection: that is the only
  // kind main will fetch a clip for, so no other page needs to play a data: video.
  const device = connections.some((c) => c.kind === 'device');
  return [
    "default-src 'none'",
    "connect-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: blob:${open ? ' https:' : ''}`,
    `font-src data:${open ? ' https:' : ''}`,
    ...(open || device ? [`media-src ${[device ? 'data:' : '', open ? 'https:' : ''].filter(Boolean).join(' ')}`] : []),
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "webrtc 'block'",
  ].join('; ');
}

/** Elements whose content is text, not markup. A `<head>` inside a
 *  `<textarea>` or a `<script>` is characters on the page, and treating it as
 *  the document's head is exactly the class of mistake finding 1 is about. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed', 'noframes', 'noscript', 'iframe']);
const WRAPPER_ELEMENTS = new Set(['html', 'head', 'body']);

interface WrapperTag { name: string; close: boolean; start: number; end: number; attrs: string }

/** Walks the author's document the way a parser would — skipping comments,
 *  declarations and raw-text element contents — and reports where its
 *  `<html>`, `<head>` and `<body>` tags really are. Not a full HTML parser;
 *  just enough that no comment, attribute value or `<textarea>` can pass for
 *  one of the three tags we rewrite. */
function scanWrappers(html: string): { tags: WrapperTag[]; doctypeEnd: number } {
  const lower = html.toLowerCase();
  const tags: WrapperTag[] = [];
  let doctypeEnd = 0;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (lower.startsWith('<!--', lt)) {
      const end = lower.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (lower.startsWith('<!', lt) || lower.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt + 2);
      const stop = end < 0 ? html.length : end + 1;
      // Only a doctype BEFORE any markup is ours to drop; a stray one later is
      // the author's text and stays where it is.
      if (lower.startsWith('<!doctype', lt) && html.slice(0, lt).trim() === '') doctypeEnd = stop;
      i = stop;
      continue;
    }
    const m = /^<(\/?)([a-z][a-z0-9]*)/.exec(lower.slice(lt, lt + 40));
    if (!m) { i = lt + 1; continue; }
    const close = m[1] === '/';
    const name = m[2];
    // The '>' that ends a tag is the first one outside a quoted attribute value.
    let j = lt + m[0].length;
    let quote = '';
    let gt = -1;
    for (; j < html.length; j++) {
      const ch = html[j];
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') { gt = j; break; }
    }
    const tagEnd = gt < 0 ? html.length : gt + 1;
    if (WRAPPER_ELEMENTS.has(name)) {
      // An unterminated tag (no '>' before the end of the document) has no
      // trustworthy attribute text — carrying it over would swallow the rest
      // of the page into an attribute value. Drop it instead.
      const attrs = close || gt < 0 ? '' : html.slice(lt + m[0].length, gt).replace(/\/\s*$/, '').trim();
      tags.push({ name, close, start: lt, end: tagEnd, attrs });
    }
    i = tagEnd;
    if (!close && RAW_TEXT_ELEMENTS.has(name)) {
      const end = lower.indexOf(`</${name}`, i);
      i = end < 0 ? html.length : end; // the close tag itself is scanned normally
    }
  }
  return { tags, doctypeEnd };
}

/** Everything in [from, to) except the spans in `cuts`, which are the author's
 *  wrapper tags and leading doctype — the four bytes we replace with our own. */
function excise(html: string, from: number, to: number, cuts: readonly { start: number; end: number }[]): string {
  let out = '';
  let pos = from;
  for (const c of cuts) {
    if (c.end <= from || c.start >= to) continue;
    const s = Math.max(c.start, from);
    if (s > pos) out += html.slice(pos, s);
    pos = Math.max(pos, Math.min(c.end, to));
  }
  return out + html.slice(pos, to);
}

/** The author's document taken apart: what belonged in its head, what belonged
 *  in its body, and the attributes it put on `<html>` and `<body>` (a page may
 *  style either, so dropping them would change how it draws).
 *
 *  A head section exists only when a real `<head>` has a real end — `</head>`
 *  or the `<body>` that implies it. Anything else, including a document with
 *  no head at all, is all body: a `<style>` there still comes after ours in
 *  document order, so the author's styles still win a tie. */
function splitAuthorDocument(html: string): { head: string; body: string; htmlAttrs: string; bodyAttrs: string } {
  const { tags, doctypeEnd } = scanWrappers(html);
  const first = (name: string, close: boolean) => tags.find((t) => t.name === name && t.close === close) ?? null;
  const htmlOpen = first('html', false);
  const headOpen = first('head', false);
  const headClose = first('head', true);
  const bodyOpen = first('body', false);

  let headFrom = -1, headTo = -1, regionFrom = -1, regionTo = -1;
  if (headOpen) {
    const endsAt = headClose && headClose.start >= headOpen.end ? headClose
      : bodyOpen && bodyOpen.start >= headOpen.end ? bodyOpen
      : null;
    if (endsAt) {
      headFrom = headOpen.end;
      headTo = endsAt.start;
      regionFrom = headOpen.start;
      regionTo = endsAt === headClose ? endsAt.end : endsAt.start;
    }
  }

  const cuts = tags.map((t) => ({ start: t.start, end: t.end }));
  if (doctypeEnd > 0) cuts.unshift({ start: 0, end: doctypeEnd });
  cuts.sort((a, b) => a.start - b.start);

  const head = headFrom >= 0 ? excise(html, headFrom, headTo, cuts) : '';
  const body = regionFrom >= 0
    ? excise(html, 0, regionFrom, cuts) + excise(html, regionTo, html.length, cuts)
    : excise(html, 0, html.length, cuts);
  return {
    head,
    body,
    htmlAttrs: htmlOpen?.attrs ? ` ${htmlOpen.attrs}` : '',
    bodyAttrs: bodyOpen?.attrs ? ` ${bodyOpen.attrs}` : '',
  };
}

/** Builds the document that is framed: OUR shell — the policy, the theme, the
 *  style kit and the bootstrap — with the author's document appended into it.
 *
 *  WHY a shell rather than an injection (design review 1, finding 1): the old
 *  version found the author's `<head>` with a regular expression, so a page
 *  whose first line was `<!-- <head> -->` put the policy, the theme AND the
 *  bootstrap inside a comment, where they did nothing at all and nothing said
 *  so. Our head is emitted first and cannot be moved by anything the author
 *  writes; the author's head content follows it, so their styles still win a
 *  tie. Their own `<meta http-equiv="Content-Security-Policy">`, if they write
 *  one, can only narrow ours — policies combine, they never widen. */
export function prepareHostedDocument(
  html: string,
  themeCss: string,
  kitCss: string,
  data: unknown = null,
  connections: readonly { kind: string; id?: string; address?: string; approved?: boolean }[] = [],
  seeThrough = false,
): string {
  // `</script>` inside the data would end the script early; escape the one
  // sequence that matters in a JSON literal placed in a script.
  const dataJson = JSON.stringify(data ?? null).replace(/<\//g, '<\\/');
  // Each allowed device as `http://<address>`: the page builds its requests
  // on this, and main still refuses anything that is not exactly that device.
  const devices: Record<string, string> = {};
  for (const c of connections) if (c.kind === 'device' && c.approved && c.id && c.address) devices[c.id] = `http://${c.address}`;
  const devicesJson = JSON.stringify(devices).replace(/<\//g, '<\\/');
  const ours =
    `<meta http-equiv="Content-Security-Policy" content="${pageCsp(connections)}">` +
    '<meta http-equiv="x-dns-prefetch-control" content="off">' +
    `<style id="${PAGE_THEME_STYLE_ID}">${themeCss}</style>` +
    `<style id="youcoded-kit">${kitCss}</style>` +
    `<script>${bootstrap(dataJson, devicesJson)}</script>`;
  const a = splitAuthorDocument(html);
  // WHY the attribute is baked in: set from first paint, the page never flashes
  // an opaque canvas before the host's first message arrives.
  const see = seeThrough ? ` ${PAGE_SEE_THROUGH_ATTR}` : '';
  return `<!doctype html><html${a.htmlAttrs}${see}><head>${ours}${a.head}</head><body${a.bodyAttrs}>${a.body}</body></html>`;
}

/** Watches the host document for anything the theme engine touches — the
 *  inline style and data attributes on <html> and <body> — and reports the
 *  fresh CSS plus whether the page should be see-through. Attribute-level, not
 *  a React subscription, so a theme-pack reload or the appearance sliders count
 *  too, not only a theme switch. `wantsSeeThrough` is the person's per-page
 *  switch; the pane being glass is read here, live (wallpaper, chrome style and
 *  Reduced effects all arrive as attribute changes). Returns the unsubscribe
 *  and a `refresh` for when the switch itself flips. */
export function watchThemeCss(
  onChange: (css: string, seeThrough: boolean) => void,
  wantsSeeThrough: () => boolean = () => false,
): { stop: () => void; refresh: () => void } {
  const read = () => {
    const see = wantsSeeThrough() && paneIsGlass();
    return { css: readThemeCss(document.documentElement, see), see };
  };
  let last = read();
  const check = () => {
    const next = read();
    if (next.css !== last.css || next.see !== last.see) { last = next; onChange(next.css, next.see); }
  };
  const mo = new MutationObserver(check);
  mo.observe(document.documentElement, { attributes: true });
  mo.observe(document.body, { attributes: true });
  return { stop: () => mo.disconnect(), refresh: check };
}
