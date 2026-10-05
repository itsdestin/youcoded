// @vitest-environment jsdom
// The document a page is framed in is the first of the two things that keep
// Phase 2's promise ("a page reaches exactly what its approval lists"), so what
// is pinned here is that OUR shell always wins: the policy, the theme and the
// bootstrap cannot be moved, commented out or faked by anything the page's
// author writes, and the bootstrap only believes the host.
import { afterEach, describe, expect, it } from 'vitest';
import { prepareHostedDocument } from '../src/renderer/components/pages/page-theme';

const THEME = ':root { --canvas: #fff; }';
const KIT = 'body { margin: 0; }';
const doc = (html: string, connections: { kind: string }[] = []) =>
  prepareHostedDocument(html, THEME, KIT, null, connections);

/** What our shell put in the head, up to the author's first byte. */
const cspOf = (out: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(out)?.[1] ?? '';
const headOf = (out: string) => out.slice(out.indexOf('<head>') + 6, out.indexOf('</head>'));
const bodyOf = (out: string) => out.slice(out.indexOf('</head>') + 7);

describe('the framed page document', () => {
  it('is our own shell, with the policy before anything else', () => {
    const out = doc('<html><head><title>T</title></head><body><p>hi</p></body></html>');
    expect(out.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
    const head = headOf(out);
    expect(head.indexOf('x-dns-prefetch-control')).toBeGreaterThan(head.indexOf('Content-Security-Policy'));
    expect(head.indexOf('youcoded-theme')).toBeGreaterThan(head.indexOf('x-dns-prefetch-control'));
    expect(head.indexOf('youcoded-kit')).toBeGreaterThan(head.indexOf('youcoded-theme'));
    expect(head.indexOf('<script>')).toBeGreaterThan(head.indexOf('youcoded-kit'));
    // The author's own head content survives, after ours.
    expect(head.indexOf('<title>T</title>')).toBeGreaterThan(head.indexOf('<script>'));
    expect(bodyOf(out)).toContain('<p>hi</p>');
  });

  it('is not fooled by a commented-out head on the first line', () => {
    const out = doc('<!-- <head> -->\n<style>p{color:red}</style>\n<p>hi</p>');
    // The whole point: nothing of ours is inside the comment.
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<!--'));
    expect(out.indexOf('<!--')).toBeGreaterThan(out.indexOf('</head>'));
    expect(out).toContain('<!-- <head> -->');
    // The author's style still comes after the kit, so a tie still goes to them.
    expect(out.indexOf('p{color:red}')).toBeGreaterThan(out.indexOf('youcoded-kit'));
  });

  it('is not fooled by a head inside a textarea', () => {
    const out = doc('<html><head><style>h1{color:blue}</style></head><body><textarea><head>typed</head></textarea></body></html>');
    expect(headOf(out)).toContain('h1{color:blue}');
    expect(headOf(out)).not.toContain('typed');
    // The field's contents are characters on the page and are left alone.
    expect(bodyOf(out)).toContain('<textarea><head>typed</head></textarea>');
  });

  it('is not fooled by a head written inside a script, before the real one', () => {
    const out = doc('<script src="/a.js"></script><script>var a = "<head>";</script><html><head><meta name="x" content="y"></head><body><p>p</p></body></html>');
    expect(headOf(out)).toContain('<meta name="x" content="y">');
    expect(headOf(out)).not.toContain('var a');
    expect(bodyOf(out)).toContain('<script src="/a.js"></script>');
    expect(bodyOf(out)).toContain('var a = "<head>";');
    expect(bodyOf(out)).toContain('<p>p</p>');
  });

  it('wraps a document that has no head, and one that is a fragment', () => {
    const out = doc('<div id="app">x</div>');
    expect(cspOf(out)).toContain("default-src 'none'");
    expect(bodyOf(out)).toContain('<div id="app">x</div>');
    expect(headOf(out)).not.toContain('<div');

    const noBody = doc('<!DOCTYPE html>\n<html lang="en"><head><style>a{}</style></head>\n<p>loose</p></html>');
    expect(headOf(noBody)).toContain('a{}');
    expect(bodyOf(noBody)).toContain('<p>loose</p>');
    // The author's own wrapper tags are gone; only our shell's remain.
    expect(noBody.match(/<\/html>/g) ?? []).toHaveLength(1);
    expect(noBody.match(/<html/g) ?? []).toHaveLength(1);
  });

  it('keeps the attributes the author put on html and body', () => {
    const out = doc('<html lang="en" class="dark"><head></head><body data-x="1" class="p"><p>hi</p></body></html>');
    expect(out).toContain('<html lang="en" class="dark"><head>');
    expect(out).toContain('<body data-x="1" class="p">');
    // …but not a tag the author never closed, whose "attributes" are the rest
    // of the document.
    const unterminated = doc('<body class="x');
    expect(unterminated).toContain('<body>');
  });

  it('carries the page data into the frame, escaped so it cannot end the script', () => {
    const out = prepareHostedDocument('<p>hi</p>', THEME, KIT, { note: '</script><img>' });
    expect(out).toContain('<\\/script>');
    expect(out.match(/<\/script>/g) ?? []).toHaveLength(1);
  });
});

describe('the policy the document carries', () => {
  it('closes the network on a page with no connections', () => {
    const csp = cspOf(doc('<p>hi</p>'));
    for (const directive of [
      "default-src 'none'", "connect-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
      'img-src data: blob:', 'font-src data:', "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "webrtc 'block'",
    ]) expect(csp).toContain(directive);
    expect(csp).not.toContain('https:');
  });

  it("leaves the browser's own network closed for a page that has a key", () => {
    const csp = cspOf(doc('<p>hi</p>', [{ kind: 'key' }, { kind: 'public' }]));
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('https:');
  });

  it('lets only a page with a device connection play a data: video clip', () => {
    expect(cspOf(doc('<p>hi</p>', [{ kind: 'device' }]))).toContain('media-src data:');
    expect(cspOf(doc('<p>hi</p>', [{ kind: 'device' }]))).not.toContain('media-src data: https:');
    for (const none of [[], [{ kind: 'key' }], [{ kind: 'public' }]]) expect(cspOf(doc('<p>hi</p>', none))).not.toContain('media-src');
    // An open page keeps https video; adding a device adds data: beside it.
    expect(cspOf(doc('<p>hi</p>', [{ kind: 'open' }, { kind: 'device' }]))).toContain('media-src data: https:');
  });

  it('lets a whole-internet page show pictures, video and webfonts, but not open a socket', () => {
    const csp = cspOf(doc('<p>hi</p>', [{ kind: 'open' }]));
    expect(csp).toContain('img-src data: blob: https:');
    expect(csp).toContain('media-src https:');
    expect(csp).toContain('font-src data: https:');
    expect(csp).toContain("connect-src 'none'");
  });
});

/** Runs the bootstrap the way the frame does, with a fake host window, so what
 *  is tested is the code the page actually receives. */
function runBootstrap(html = '<p>hi</p>') {
  const src = /<script>([\s\S]*?)<\/script>/.exec(prepareHostedDocument(html, THEME, KIT, { seed: 1 }))?.[1] ?? '';
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const win = { addEventListener: (t: string, fn: (e: unknown) => void) => { (listeners[t] ??= []).push(fn); } } as Record<string, unknown>;
  const posted: Record<string, unknown>[] = [];
  const parent = { postMessage: (m: Record<string, unknown>) => { posted.push(m); } };
  const documentStub = { getElementById: () => null, createElement: () => ({}), head: { appendChild: () => {} } };
  new Function('window', 'document', 'parent', src)(win, documentStub, parent);
  const deliver = (data: unknown, source: unknown = parent) => {
    for (const fn of listeners.message ?? []) fn({ data, source });
  };
  return { yc: win.youcoded as Record<string, (...a: unknown[]) => unknown>, posted, deliver };
}

describe('what a page can call', () => {
  it('asks the host for a fetch and resolves with its answer', async () => {
    const { yc, posted, deliver } = runBootstrap();
    const p = yc.fetch('https://api.example.com/x', { method: 'GET' }) as Promise<{ status: number; body: string }>;
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'youcoded:fetch', url: 'https://api.example.com/x', method: 'GET' });
    const id = posted[0].id;
    deliver({ type: 'youcoded:fetch:result', id, result: { ok: true, status: 200, headers: {}, body: '{}' } });
    await expect(p).resolves.toMatchObject({ status: 200, body: '{}' });
  });

  it('rejects with the sentence the app returned, and never invents one', async () => {
    const { yc, posted, deliver } = runBootstrap();
    const p = yc.fetch('https://nope.example.com/') as Promise<unknown>;
    deliver({ type: 'youcoded:fetch:result', id: posted[0].id, result: { ok: false, reason: 'not-approved', message: 'This page is not allowed to reach nope.example.com.' } });
    await expect(p).rejects.toThrow('This page is not allowed to reach nope.example.com.');
  });

  it('ignores an answer that did not come from the host', async () => {
    const { yc, posted, deliver } = runBootstrap();
    let settled = false;
    const p = yc.fetch('https://api.example.com/x') as Promise<unknown>;
    void p.then(() => { settled = true; }, () => { settled = true; });
    // A window the page opened holds `opener` and can post back through it.
    deliver({ type: 'youcoded:fetch:result', id: posted[0].id, result: { ok: true, status: 200, headers: {}, body: 'forged' } }, { name: 'popup' });
    // …and an answer from the host carrying somebody else's id is not ours.
    deliver({ type: 'youcoded:fetch:result', id: 'f999', result: { ok: true, status: 200, headers: {}, body: 'wrong id' } });
    await Promise.resolve();
    expect(settled).toBe(false);
    deliver({ type: 'youcoded:fetch:result', id: posted[0].id, result: { ok: true, status: 200, headers: {}, body: 'real' } });
    await expect(p).resolves.toMatchObject({ body: 'real' });
  });

  it('hands the page a live socket handle and hears only events for its own ids', () => {
    const { yc, posted, deliver } = runBootstrap();
    const states: unknown[][] = [];
    const messages: string[][] = [];
    const sock = (yc.socket as (u: string, o: unknown) => { send(t: unknown): boolean; close(): void })('http://ha.local:8123/api/websocket', {
      onState: (...a: unknown[]) => states.push(a), onMessages: (t: string[]) => messages.push(t),
    });
    expect(posted[0]).toMatchObject({ type: 'youcoded:socket:open', id: 's1', url: 'http://ha.local:8123/api/websocket' });
    // Refused unless 'open': nothing is posted.
    expect(sock.send('{"type":"ping"}')).toBe(false);
    expect(posted).toHaveLength(1);
    deliver({ type: 'youcoded:socket:event', id: 's1', kind: 'state', state: 'open' });
    expect(sock.send('{"type":"ping"}')).toBe(true);
    expect(sock.send(42)).toBe(false); // strings only
    expect(posted[1]).toMatchObject({ type: 'youcoded:socket:send', id: 's1', text: '{"type":"ping"}' });
    deliver({ type: 'youcoded:socket:event', id: 's1', kind: 'messages', texts: ['a', 7, 'b'] });
    expect(messages).toEqual([['a', 'b']]);
    // A forged event: from another window, or for an id this page never made.
    deliver({ type: 'youcoded:socket:event', id: 's1', kind: 'messages', texts: ['forged'] }, { name: 'popup' });
    deliver({ type: 'youcoded:socket:event', id: 's99', kind: 'messages', texts: ['wrong id'] });
    deliver({ type: 'youcoded:socket:event', id: 's99', kind: 'state', state: 'open' });
    expect(messages).toEqual([['a', 'b']]);
    expect(states).toEqual([['open', undefined]]);
    // Closing tells the host once, and later events resolve nothing.
    sock.close();
    expect(posted.at(-1)).toMatchObject({ type: 'youcoded:socket:close', id: 's1' });
    deliver({ type: 'youcoded:socket:event', id: 's1', kind: 'messages', texts: ['late'] });
    expect(messages).toHaveLength(1);
  });

  it('hands the page a video handle: pictures arrive with an ack, only for its own ids, and a picture nobody wants is closed', () => {
    const { yc, posted, deliver } = runBootstrap();
    const states: unknown[][] = [];
    const frames: Array<{ bitmap: unknown; ack: () => void }> = [];
    const v = (yc.video as (c: string, t: string, o: unknown) => { stop(): void })('ha', 'camera.living_room', {
      onState: (...a: unknown[]) => states.push(a), onFrame: (bitmap: unknown, ack: () => void) => frames.push({ bitmap, ack }),
    });
    expect(posted[0]).toEqual({ type: 'youcoded:video:start', id: 'v1', connection: 'ha', target: 'camera.living_room' });
    deliver({ type: 'youcoded:video:event', id: 'v1', kind: 'state', state: 'playing' });
    const bitmap = { close: () => {} };
    deliver({ type: 'youcoded:video:event', id: 'v1', kind: 'frame', n: 7, bitmap });
    expect(frames[0].bitmap).toBe(bitmap);
    frames[0].ack(); frames[0].ack(); // acking twice asks once
    expect(posted.filter((m) => (m as { type: string }).type === 'youcoded:video:ack')).toEqual([{ type: 'youcoded:video:ack', id: 'v1', n: 7 }]);
    // A forged event (another window, an id never made) resolves nothing; its picture is closed.
    let closed = 0;
    deliver({ type: 'youcoded:video:event', id: 'v1', kind: 'frame', n: 8, bitmap }, { name: 'popup' });
    deliver({ type: 'youcoded:video:event', id: 'v9', kind: 'frame', n: 1, bitmap: { close: () => { closed++; } } });
    deliver({ type: 'youcoded:video:event', id: 'v9', kind: 'state', state: 'playing' });
    expect(frames).toHaveLength(1);
    expect(closed).toBe(1);
    expect(states).toEqual([['playing', undefined]]);
    v.stop();
    expect(posted.at(-1)).toEqual({ type: 'youcoded:video:stop', id: 'v1' });
    let late = 0;
    deliver({ type: 'youcoded:video:event', id: 'v1', kind: 'frame', n: 9, bitmap: { close: () => { late++; } } });
    expect(frames).toHaveLength(1);
    expect(late).toBe(1);
  });

  it('hears the refresh button and a data change, from the host only', () => {
    const { yc, deliver } = runBootstrap();
    let refreshes = 0;
    const seen: unknown[] = [];
    yc.onRefresh(() => { refreshes++; });
    yc.onData((d: unknown) => { seen.push(d); });

    deliver({ type: 'youcoded:refresh' }, { name: 'popup' });
    expect(refreshes).toBe(0);
    deliver({ type: 'youcoded:refresh' });
    expect(refreshes).toBe(1);

    deliver({ type: 'youcoded:data', data: { seed: 2 } });
    expect(seen).toEqual([{ seed: 2 }]);
    expect((yc as unknown as { data: unknown }).data).toEqual({ seed: 2 });
  });
});

// ── See-through (owner, 2026-10-05: "peek through to the real theme background") ──────────────
// A page turns see-through ONLY when the app's page pane is glass AND the person has the page's
// switch on. These pin the three places that decide it: the pane test, the first-paint document,
// and the live message the page's own bootstrap obeys.
import { paneIsGlass, readThemeCss, watchThemeCss, PAGE_SEE_THROUGH_ATTR } from '../src/renderer/components/pages/page-theme';
import { PAGE_KIT_CSS } from '../src/renderer/components/pages/page-kit';

function setPane(wallpaper: boolean, chrome: string | null) {
  const root = document.documentElement;
  if (wallpaper) root.setAttribute('data-wallpaper', ''); else root.removeAttribute('data-wallpaper');
  if (chrome) document.body.setAttribute('data-chrome-style', chrome); else document.body.removeAttribute('data-chrome-style');
}

describe('when the page pane is glass', () => {
  afterEach(() => setPane(false, null));
  it('needs a wallpaper AND a floating or float chrome style (the same condition globals.css and float-chrome.css use)', () => {
    setPane(true, 'floating'); expect(paneIsGlass()).toBe(true);
    setPane(true, 'float'); expect(paneIsGlass()).toBe(true);
    setPane(true, 'default'); expect(paneIsGlass()).toBe(false); // framed: the pane is an opaque canvas card
    setPane(true, null); expect(paneIsGlass()).toBe(false);
    setPane(false, 'floating'); expect(paneIsGlass()).toBe(false); // a plain theme has nothing behind to show
    setPane(false, 'float'); expect(paneIsGlass()).toBe(false);
  });
});

describe('the framed document carries the see-through flag', () => {
  it('is baked into <html> from first paint only when asked', () => {
    expect(prepareHostedDocument('<p>x</p>', THEME, KIT, null, [], true).startsWith(`<!doctype html><html ${PAGE_SEE_THROUGH_ATTR}><head>`)).toBe(true);
    expect(prepareHostedDocument('<p>x</p>', THEME, KIT, null, [], false)).not.toContain(PAGE_SEE_THROUGH_ATTR + '>');
    expect(prepareHostedDocument('<p>x</p>', THEME, KIT)).not.toContain(`<html ${PAGE_SEE_THROUGH_ATTR}`);
  });
  it('hands over the glass density only while see-through', () => {
    document.documentElement.style.setProperty('--panels-opacity', '0.72');
    try {
      expect(readThemeCss(document.documentElement, true)).toContain('--panels-opacity: 0.72;');
      expect(readThemeCss(document.documentElement, false)).not.toContain('panels-opacity');
      expect(readThemeCss()).not.toContain('panels-opacity');
    } finally { document.documentElement.style.removeProperty('--panels-opacity'); }
  });
  it('the kit paints no backdrop of its own behind that flag, and a plain page still paints the canvas', () => {
    expect(PAGE_KIT_CSS).toMatch(/body \{[^}]*background: var\(--canvas\)/);
    expect(PAGE_KIT_CSS).toMatch(/:root\[data-yc-see-through\] body \{ background: transparent; \}/);
  });
});

describe('the page obeys the host\'s live message', () => {
  function run() {
    const src = /<script>([\s\S]*?)<\/script>/.exec(prepareHostedDocument('<p>hi</p>', THEME, KIT))?.[1] ?? '';
    const listeners: ((e: unknown) => void)[] = [];
    const attrs = new Set<string>();
    const el = { textContent: '' };
    const documentStub = {
      getElementById: () => el, createElement: () => ({}), head: { appendChild: () => {} },
      documentElement: { toggleAttribute: (n: string, on: boolean) => { if (on) attrs.add(n); else attrs.delete(n); } },
    };
    const parent = { postMessage: () => {} };
    new Function('window', 'document', 'parent', src)({ addEventListener: (_t: string, fn: (e: unknown) => void) => listeners.push(fn) }, documentStub, parent);
    return { attrs, el, deliver: (data: unknown, source: unknown = parent) => listeners.forEach((fn) => fn({ data, source })) };
  }
  it('turns see-through on and off with the message, and ignores anything not from the host', () => {
    const { attrs, el, deliver } = run();
    deliver({ type: 'youcoded:theme', css: ':root{--a:1}', seeThrough: true });
    expect(attrs.has(PAGE_SEE_THROUGH_ATTR)).toBe(true);
    expect(el.textContent).toBe(':root{--a:1}');
    deliver({ type: 'youcoded:theme', css: ':root{--a:2}', seeThrough: false });
    expect(attrs.has(PAGE_SEE_THROUGH_ATTR)).toBe(false);
    deliver({ type: 'youcoded:theme', css: 'x', seeThrough: true }, { name: 'popup' });
    expect(attrs.has(PAGE_SEE_THROUGH_ATTR)).toBe(false);
    deliver({ type: 'youcoded:theme', css: ':root{--a:3}' }); // an older host sends no flag: solid, as before
    expect(attrs.has(PAGE_SEE_THROUGH_ATTR)).toBe(false);
  });
});

describe('the watcher', () => {
  afterEach(() => setPane(false, null));
  it('reports a wallpaper or chrome-style change live, and never see-through when the switch is off', async () => {
    setPane(false, 'floating');
    let want = true;
    const seen: boolean[] = [];
    const w = watchThemeCss((_css, see) => seen.push(see), () => want);
    setPane(true, 'floating');
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.at(-1)).toBe(true);
    want = false; w.refresh();
    expect(seen.at(-1)).toBe(false);
    want = true; w.refresh();
    setPane(true, 'default');
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.at(-1)).toBe(false);
    w.stop();
  });
});
