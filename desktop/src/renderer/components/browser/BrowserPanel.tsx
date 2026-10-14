// The Browser panel — the chat's right-side slot showing what the assistant's
// browser is doing (spec docs/active/specs/2026-10-13-assistant-browser-design.md §2 Screens).
//
// The person can browse here too (Destin, 2026-10-13): an address box with
// back/forward/reload, and the picture passes clicks, scrolling and typing on to
// the page. Signing in is still steered to a real window ("Show window"), where
// password managers, passkeys and 2FA work. A hidden browser lays its pages out
// to the picture's size, so the page fits the panel instead of shrinking.
//
// Hidden means idle (performance rule 2): this component is mounted only while
// the panel is open AND its chat is the visible one (ChatView renders the slot
// only when `visible`), it asks for pictures only while mounted and the app
// window isn't hidden, and each picture is written straight to the <img> — no
// React state per frame — then acknowledged so the next one may come.
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserInfo, BrowserInputEvent, BrowserSessionState } from '../../../shared/browser-types';
import { closeBrowserPane, toggleBrowserExpanded, useBrowserExpanded, useBrowserState } from '../../state/browser-store';
import { Button, Callout, DocumentTabs, EmptyState, ErrorState, FieldError, LoadingState, TextInput } from '../ui';
import { PanelIconButton } from '../panel-icon-button';
import { BackIcon, ForwardIcon, GlobeIcon, ReloadIcon, StopIcon } from '../Icons';
import BrailleSpinner from '../BrailleSpinner';
import { ScreenMark } from '../../shoot-mode';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
import BrowserAskCard from './BrowserAskCard';
import { ContextMenu } from '../context-menu/ContextMenu';

function bridge() { return (window as any).claude.browser; }

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

/** A tab's name in the strip and header: its title, else its site, else "New tab". */
function tabLabel(t: { title: string; url: string }): string {
  if (!t.url || t.url === 'about:blank') return 'New tab';
  return (t.title && t.title !== t.url ? t.title : '') || hostOf(t.url) || t.url;
}

/** A browser shortcut on the picture that the panel does itself, as in Chrome. */
export type PanelKey = 'new-tab' | 'close-tab' | 'next-tab' | 'prev-tab' | 'address' | 'back' | 'forward' | 'reload';

/** One word for what the browser is doing for this chat (spec glossary). */
export function browserStatusWord(s: BrowserSessionState | null): string {
  if (!s) return 'Idle';
  if (s.prompt) return 'Waiting for you';
  if (s.run === 'starting') return 'Starting';
  if (s.run === 'error') return 'Stopped';
  if (s.busy) return 'Working';
  return s.tabs.length ? 'Idle' : 'Not open';
}

const SPECIAL_KEY = /^(F\d{1,2}|Enter|Backspace|Tab|Escape|Delete|Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown|Insert)$/;

/** A key pressed on the picture, as what the page should receive: text for a
 *  plain character, a named key (with modifiers) otherwise, 'paste' for
 *  Ctrl/Cmd+V (the page gets the clipboard's text), 'copy'/'cut' for Ctrl/Cmd+C/X
 *  (the page's highlight goes to the clipboard), null to ignore. */
export function keyEventFor(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): BrowserInputEvent | 'paste' | 'copy' | 'cut' | { panel: PanelKey } | null {
  const cmd = e.ctrlKey || e.metaKey;
  // WHY the app does these three: a hidden browser's clipboard is its own, not
  // the computer's, so the page's own Ctrl+C would copy into nowhere.
  if (cmd && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'v') return 'paste';
    if (k === 'c') return 'copy';
    if (k === 'x') return 'cut';
    // Chrome's tab and address shortcuts — a hidden browser has no tab strip
    // or address bar of its own, so the panel's do the job.
    if (k === 't' && !e.shiftKey) return { panel: 'new-tab' };
    if (k === 'w') return { panel: 'close-tab' };
    if (k === 'l') return { panel: 'address' };
    if (k === 'r') return { panel: 'reload' };
    if (e.key === 'Tab') return { panel: e.shiftKey ? 'prev-tab' : 'next-tab' };
    if (e.key === 'PageDown') return { panel: 'next-tab' };
    if (e.key === 'PageUp') return { panel: 'prev-tab' };
  }
  if (e.altKey && !cmd && e.key === 'ArrowLeft') return { panel: 'back' };
  if (e.altKey && !cmd && e.key === 'ArrowRight') return { panel: 'forward' };
  if (e.key === 'F5') return { panel: 'reload' };
  const single = [...e.key].length === 1;
  if (single && !cmd && !e.altKey) return { type: 'text', text: e.key };
  if (!single && !SPECIAL_KEY.test(e.key)) return null; // Shift alone, Dead, Process…
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.metaKey && 'Meta', e.shiftKey && !single && 'Shift'].filter(Boolean);
  return { type: 'key', key: [...mods, e.key].join('+') };
}

/** Where a point on the drawn picture is on the page (CSS px), or null outside it.
 *  The picture is drawn contained, centred across and pinned to the top. */
export function pagePoint(rect: { left: number; top: number; width: number; height: number }, frame: { w: number; h: number }, clientX: number, clientY: number): { x: number; y: number } | null {
  const scale = Math.min(rect.width / frame.w, rect.height / frame.h);
  if (!(scale > 0)) return null;
  const left = rect.left + (rect.width - frame.w * scale) / 2;
  const x = (clientX - left) / scale;
  const y = (clientY - rect.top) / scale;
  if (x < 0 || y < 0 || x > frame.w || y > frame.h) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Like pagePoint, but a point off the picture is pulled to its nearest edge —
 *  a highlight dragged past the picture keeps following the pointer. */
function pagePointClamped(rect: { left: number; top: number; width: number; height: number }, frame: { w: number; h: number }, clientX: number, clientY: number): { x: number; y: number } | null {
  const scale = Math.min(rect.width / frame.w, rect.height / frame.h);
  if (!(scale > 0)) return null;
  const left = rect.left + (rect.width - frame.w * scale) / 2;
  const x = Math.min(frame.w, Math.max(0, (clientX - left) / scale));
  const y = Math.min(frame.h, Math.max(0, (clientY - rect.top) / scale));
  return { x: Math.round(x), y: Math.round(y) };
}

/** The live picture of the chat's current tab — also the person's way to use it. */
const LivePicture = memo(function LivePicture({ sessionId, title, onPanelKey }: { sessionId: string; title: string; onPanelKey: (k: PanelKey) => void }) {
  const img = useRef<HTMLImageElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [hasFrame, setHasFrame] = useState(false);
  /** The page size the current picture shows (CSS px) — clicks map onto it. */
  const frame = useRef({ w: 1280, h: 800 });

  useEffect(() => {
    const b = bridge();
    let watching = false;
    const start = () => { if (!watching && !document.hidden) { watching = true; void b.watch(sessionId).catch(() => { watching = false; }); } };
    const stop = () => { if (watching) { watching = false; void b.unwatch(sessionId).catch(() => {}); } };
    // A minimized/hidden app window stops the stream (hidden means idle).
    const onVis = () => (document.hidden ? stop() : start());
    const off = b.onFrame((f: { sessionId: string; data: string; width: number; height: number }) => {
      if (f.sessionId !== sessionId || !img.current) return;
      frame.current = { w: f.width, h: f.height };
      const src = `data:image/jpeg;base64,${f.data}`;
      // WHY ack at once when unchanged: an identical picture (a still page) sets
      // the same src, which fires no load event — waiting for one stalled the
      // whole stream on the first repeat (seen in the dev app, 2026-10-13).
      if (img.current.src === src) b.ackFrame(sessionId);
      else img.current.src = src;
      setHasFrame(true); // a no-op after the first frame (same value)
    });
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => { off(); stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [sessionId]);

  // Tell the browser the picture area's size, so a hidden browser lays the
  // page out to fit it. Debounced: dragging the panel edge relayouts once.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let size = { w: 0, h: 0 };
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (!r || r.width <= 0 || r.height <= 0) return;
      size = { w: r.width, h: r.height };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; bridge().viewSize(sessionId, size.w, size.h); }, 200);
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, [sessionId]);

  // Ack after the picture is drawn, so a busy screen slows the stream instead of queueing.
  const onLoad = useCallback(() => { bridge().ackFrame(sessionId); }, [sessionId]);

  const point = (e: { clientX: number; clientY: number }) => (img.current ? pagePoint(img.current.getBoundingClientRect(), frame.current, e.clientX, e.clientY) : null);
  const send = useCallback((ev: BrowserInputEvent) => bridge().input(sessionId, ev), [sessionId]);

  // A mouse sends press, drag and release as separate steps, so a drag
  // highlights text the way it does in any browser (a click is press + release).
  // The drag is followed on the window only while the button is down, so it
  // keeps going past the picture's edge; moves go at most once a frame.
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); // no image drag, no app text selection
    box.current?.focus({ preventScroll: true });
    // A tap was already sent by onPointerUp; its follow-on mouse events are not a second one.
    if (lastPointerWasTouch.current || e.button !== 0) return;
    const p = point(e);
    if (!p) return;
    endDrag.current?.();
    const clickCount = Math.max(1, Math.min(3, e.detail || 1));
    send({ type: 'mouse', action: 'down', x: p.x, y: p.y, clickCount });
    let last = { x: e.clientX, y: e.clientY };
    let raf: number | null = null;
    const at = (cx: number, cy: number) => (img.current ? pagePointClamped(img.current.getBoundingClientRect(), frame.current, cx, cy) : null);
    const move = (m: MouseEvent) => {
      last = { x: m.clientX, y: m.clientY };
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const q = at(last.x, last.y);
        if (q) send({ type: 'mouse', action: 'move', x: q.x, y: q.y, clickCount });
      });
    };
    const finish = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (raf !== null) cancelAnimationFrame(raf);
      endDrag.current = null;
    };
    const up = (m: MouseEvent) => {
      finish();
      const q = at(m.clientX, m.clientY) ?? p;
      send({ type: 'mouse', action: 'up', x: q.x, y: q.y, clickCount });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    endDrag.current = finish;
  };

  // Hovering: the pointer's place goes to the page too (no button held), so
  // menus that open on hover open, and links and buttons light up. At most
  // once a frame; the browser keeps only the newest point while busy.
  const hover = useRef<{ x: number; y: number; raf: number | null }>({ x: 0, y: 0, raf: null });
  useEffect(() => () => { if (hover.current.raf !== null) cancelAnimationFrame(hover.current.raf); }, []);
  const onHover = (e: React.MouseEvent) => {
    if (endDrag.current) return; // a drag sends its own moves
    const h = hover.current;
    h.x = e.clientX; h.y = e.clientY;
    if (h.raf !== null) return;
    h.raf = requestAnimationFrame(() => {
      h.raf = null;
      const p = point({ clientX: h.x, clientY: h.y });
      if (p) send({ type: 'mouse', action: 'move', x: p.x, y: p.y, clickCount: 1 });
    });
  };

  // Copy, cut and paste between the page and the computer's clipboard.
  const copy = useCallback(async (): Promise<string> => {
    const text = await bridge().selection(sessionId).catch(() => '');
    if (text) await navigator.clipboard?.writeText(text).catch(() => {});
    return text;
  }, [sessionId]);
  const paste = useCallback(() => {
    void navigator.clipboard?.readText().then((text) => { if (text) send({ type: 'text', text: text.slice(0, 10_000) }); }).catch(() => {});
  }, [send]);

  // Right-click opens the app's own small menu: a hidden browser shows no menu
  // of its own, and Copy/Paste are what a right-click is for on a page.
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const at = { x: e.clientX, y: e.clientY };
    void bridge().selection(sessionId).catch(() => '').then((text: string) => setMenu({ ...at, text }));
  };

  // Scrolling is gathered per frame: a trackpad sends dozens of tiny steps.
  const wheel = useRef<{ x: number; y: number; dx: number; dy: number; raf: number | null }>({ x: 0, y: 0, dx: 0, dy: 0, raf: null });
  useEffect(() => () => { if (wheel.current.raf !== null) cancelAnimationFrame(wheel.current.raf); }, []);
  /** Add a scroll (page px) to this frame's batch. */
  const queueWheel = (p: { x: number; y: number }, dx: number, dy: number) => {
    const w = wheel.current;
    w.x = p.x; w.y = p.y; w.dx += dx; w.dy += dy;
    if (w.raf === null) {
      w.raf = requestAnimationFrame(() => {
        w.raf = null;
        if (w.dx || w.dy) send({ type: 'wheel', x: w.x, y: w.y, dx: Math.round(w.dx), dy: Math.round(w.dy) });
        w.dx = 0; w.dy = 0;
      });
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = point(e);
    if (!p) return;
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    queueWheel(p, e.deltaX * k, e.deltaY * k);
  };

  // Touch (and pen): a drag scrolls the page, a tap clicks, a flick glides on
  // and slows down, like a phone. The page itself gets plain scrolls and
  // clicks, so this works on every site. (A mouse keeps onClick below.)
  const touch = useRef<{
    id: number; startX: number; startY: number; lastX: number; lastY: number;
    dragging: boolean; samples: Array<{ t: number; x: number; y: number }>;
  } | null>(null);
  const glide = useRef<number | null>(null);
  const lastPointerWasTouch = useRef(false);
  const stopGlide = () => { if (glide.current !== null) { cancelAnimationFrame(glide.current); glide.current = null; } };
  useEffect(() => stopGlide, []);
  /** Screen px → page px for the drawn picture. */
  const pageScale = () => {
    const r = img.current?.getBoundingClientRect();
    if (!r) return 1;
    const scale = Math.min(r.width / frame.current.w, r.height / frame.current.h);
    return scale > 0 ? 1 / scale : 1;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    lastPointerWasTouch.current = e.pointerType !== 'mouse';
    if (e.pointerType === 'mouse') return;
    stopGlide();
    box.current?.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    touch.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, dragging: false, samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }] };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') { onHover(e); return; }
    const t = touch.current;
    if (!t || t.id !== e.pointerId) return;
    // A finger wobbles: under 8 px of travel it is still a tap.
    if (!t.dragging && Math.hypot(e.clientX - t.startX, e.clientY - t.startY) < 8) return;
    t.dragging = true;
    const k = pageScale();
    const p = point({ clientX: t.startX, clientY: t.startY }) ?? { x: 0, y: 0 };
    // Finger moves up → page scrolls down.
    queueWheel(p, (t.lastX - e.clientX) * k, (t.lastY - e.clientY) * k);
    t.lastX = e.clientX; t.lastY = e.clientY;
    t.samples = [...t.samples.filter((s) => e.timeStamp - s.t < 100), { t: e.timeStamp, x: e.clientX, y: e.clientY }];
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const t = touch.current;
    if (!t || t.id !== e.pointerId) return;
    touch.current = null;
    if (!t.dragging) {
      const p = point(e);
      if (p) send({ type: 'click', x: p.x, y: p.y, clickCount: 1, button: 'left' });
      return;
    }
    // Flick: keep going at the finger's last speed, slowing each frame.
    const first = t.samples[0];
    const dt = e.timeStamp - first.t;
    if (dt <= 0) return;
    const k = pageScale();
    let vx = ((first.x - e.clientX) / dt) * k; // page px per ms
    let vy = ((first.y - e.clientY) / dt) * k;
    const p = point({ clientX: t.startX, clientY: t.startY }) ?? { x: 0, y: 0 };
    let last = performance.now();
    const step = (now: number) => {
      const ms = Math.min(50, now - last);
      last = now;
      queueWheel(p, vx * ms, vy * ms);
      const decay = Math.pow(0.995, ms); // ~half speed every 140 ms
      vx *= decay; vy *= decay;
      glide.current = Math.hypot(vx, vy) > 0.05 ? requestAnimationFrame(step) : null;
    };
    if (Math.hypot(vx, vy) > 0.3) glide.current = requestAnimationFrame(step);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const ev = keyEventFor(e);
    if (!ev) return;
    // Every key belongs to the page while the picture has focus — none may
    // reach the app's shortcuts (Escape would stop the assistant).
    e.preventDefault();
    e.stopPropagation();
    if (typeof ev === 'object' && 'panel' in ev) { onPanelKey(ev.panel); return; }
    if (ev === 'paste') { paste(); return; }
    if (ev === 'copy') { void copy(); return; }
    if (ev === 'cut') {
      // The highlight is removed only once it is safely on the clipboard.
      void copy().then((text) => { if (text) send({ type: 'key', key: 'Delete' }); });
      return;
    }
    send(ev);
  };

  return (
    <>
    <div
      ref={box}
      tabIndex={0}
      role="application"
      aria-label="The page. Click to use it; while it's selected, typing goes to the page."
      data-keyboard-owner
      onKeyDown={onKeyDown}
      // WHY no focus ring (Destin, 2026-10-14): it framed the page in the accent
      // colour whenever it was clicked; the page's own caret shows where typing goes.
      className="relative flex-1 min-h-0 flex items-start justify-center overflow-hidden focus:outline-none"
    >
      <img
        ref={img}
        onLoad={onLoad}
        onError={onLoad}
        // Focus the picture on press so typing goes to the page.
        onMouseDown={onMouseDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { touch.current = null; }}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
        alt={title ? `What the assistant's browser shows: ${title}` : "What the assistant's browser shows"}
        className={`w-full h-auto max-h-full object-contain object-top cursor-default touch-none ${hasFrame ? '' : 'hidden'}`}
        draggable={false}
      />
      {!hasFrame && <div className="my-6"><LoadingState what="the picture" verb="Waiting for" variant="inline" /></div>}
      {/* Photo-only build: the panel counts as showing once a picture is drawn. */}
      {hasFrame && <ScreenMark name="chat/browser" />}
    </div>
      {/* Outside the picture's box: React passes a portal's keys up its parents,
          and the box would send the menu's arrow keys on to the page. */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => { setMenu(null); box.current?.focus({ preventScroll: true }); }}
          entries={[
            { type: 'item', id: 'copy', label: 'Copy', icon: 'copy', disabled: !menu.text, run: () => { void navigator.clipboard?.writeText(menu.text).catch(() => {}); } },
            { type: 'item', id: 'paste', label: 'Paste', icon: 'paste', run: paste },
            { type: 'item', id: 'select-all', label: 'Select all', icon: 'select-all', run: () => send({ type: 'key', key: 'ControlOrMeta+a' }) },
          ]}
        />
      )}
    </>
  );
});

export default function BrowserPanel({ sessionId }: { sessionId: string }) {
  const state = useBrowserState(sessionId);
  const expanded = useBrowserExpanded(sessionId);
  const [info, setInfo] = useState<BrowserInfo | null>(null);
  const [copied, setCopied] = useState(false);
  // On a narrow screen the panel covers the chat, so the browser's question is
  // repeated here or it could never be seen (UX review 2, U1).
  const narrow = useNarrowViewport();

  useEffect(() => {
    let live = true;
    const load = () => { void bridge().info().then((i: BrowserInfo) => { if (live) setInfo(i); }).catch(() => {}); };
    load();
    const off = bridge().onInfoChanged(load);
    return () => { live = false; off(); };
  }, []);

  const active = state?.tabs.find((t) => t.active) ?? null;
  const status = browserStatusWord(state);
  // A running browser says what it IS; a stopped one is whatever the settings say it will start as.
  const running = state?.run === 'running';
  const myChrome = (running ? state?.myChrome : info?.settings.useMyChrome) ?? false;
  const webPage = !!active && /^https?:/i.test(active.url);

  const dismissExplainer = useCallback(async () => {
    try { setInfo(await bridge().updateSettings({ explainerSeen: true })); } catch { /* stays visible; harmless */ }
  }, []);

  // The header's buttons match Session Files' (Destin, 2026-10-13): open
  // elsewhere, copy, expand, close. The window and per-chat controls moved
  // out of the panel — Settings → Browser has Show a browser window.
  const copyLink = useCallback(() => {
    if (!active) return;
    navigator.clipboard?.writeText(active.url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [active]);
  const openInMyBrowser = useCallback(() => {
    if (active && webPage) void (window.claude as any).shell?.openExternal?.(active.url);
  }, [active, webPage]);

  // The address box: the page's address until the person edits it. Its text
  // lives here, in the panel — not in any shared store (performance rule 5).
  const [draft, setDraft] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const addressBox = useRef<HTMLInputElement>(null);
  const go = useCallback(async (req: { address: string } | { nav: 'back' | 'forward' | 'reload' | 'stop' } | { tab: 'new' | 'select' | 'close'; index?: number }) => {
    setOpenError(null);
    try {
      const r = await bridge().open({ sessionId, ...req });
      if (!r?.ok) setOpenError(r?.error ?? "That page couldn't be opened.");
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : "That page couldn't be opened.");
    }
  }, [sessionId]);
  // A new tab is empty: the address box takes the typing straight away, as in Chrome.
  const newTab = useCallback(async () => {
    await go({ tab: 'new' });
    addressBox.current?.focus();
  }, [go]);

  // Chrome's shortcuts pressed on the page. Through a ref, so the picture's
  // handler stays one stable function (it is a memo'd component).
  const tabsNow = useRef({ tabs: state?.tabs ?? [], active });
  tabsNow.current = { tabs: state?.tabs ?? [], active };
  const onPanelKey = useCallback((k: PanelKey) => {
    const { tabs, active: cur } = tabsNow.current;
    switch (k) {
      case 'new-tab': void newTab(); return;
      case 'close-tab': if (cur) void go({ tab: 'close', index: cur.index }); return;
      case 'next-tab':
      case 'prev-tab':
        if (cur && tabs.length > 1) void go({ tab: 'select', index: (cur.index + (k === 'next-tab' ? 1 : -1) + tabs.length) % tabs.length });
        return;
      case 'address': addressBox.current?.focus(); return;
      default: void go({ nav: k });
    }
  }, [go, newTab]);
  const onAddressKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && draft?.trim()) {
      e.preventDefault();
      void go({ address: draft });
      setDraft(null);
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      // Escape here only leaves the box — it must not stop the assistant.
      e.preventDefault();
      e.stopPropagation();
      setDraft(null);
      e.currentTarget.blur();
    }
  };
  const hasTabs = state?.run === 'running' && (state?.tabs.length ?? 0) > 0;
  const blank = !active || active.url === 'about:blank';

  let body: React.ReactNode;
  let showingPicture = false;
  if (state?.run === 'error' && state.error) {
    body = <ErrorState className="m-3" message={state.error} onRetry={() => { void bridge().stop(); }} />;
  } else if (state?.run === 'starting') {
    body = <LoadingState what="the browser" verb="Starting" />;
  } else if (!state || state.tabs.length === 0 || state.run !== 'running') {
    body = <EmptyState message="Nothing is open. Type an address or a search above to browse, or ask the assistant to use the browser." />;
  } else {
    showingPicture = true;
    body = (
      // WHY a framed page (Destin, 2026-10-14: "frame the browser better with
      // rounded edges"): an outlined, rounded window inset from the panel's
      // edges reads as the page, apart from the panel's own controls.
      <div className="flex-1 min-h-0 flex flex-col px-2 pb-2">
        {myChrome && <p className="text-2xs text-fg-muted px-1 pb-1.5">Working in your Chrome. You can watch it there too.</p>}
        {/* A new tab is a white page: say what to do instead (the picture is
            still drawn underneath it, so the stream stays warm). */}
        <div className="relative flex-1 min-h-0 flex flex-col rounded-lg border border-edge bg-panel overflow-hidden shadow-sm">
          <LivePicture sessionId={sessionId} title={active?.title ?? ''} onPanelKey={onPanelKey} />
          {blank && !active?.loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-panel pointer-events-none">
              <EmptyState message="Type an address or a search above." />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full flex flex-col overflow-hidden bg-inset select-none">
      {!showingPicture && <ScreenMark name="chat/browser" />}
      {/* WHY one top row (Destin, 2026-10-14, "styling and fit"): the tabs sit
          beside the panel's buttons, as in Chrome. A separate title row only
          repeated the current tab's title and cost the page a row. */}
      <div className="flex items-center gap-1 px-2 pt-1.5 pb-1 shrink-0">
        {hasTabs ? (
          <>
            <DocumentTabs
              label="Tabs"
              className="flex-1"
              shrink
              boxed
              activeId={String(active?.index ?? -1)}
              tabs={state!.tabs.map((t) => ({
                id: String(t.index),
                label: tabLabel(t),
                icon: t.loading ? <BrailleSpinner /> : <GlobeIcon className="w-3.5 h-3.5 text-fg-muted" />,
              }))}
              onSelect={(id) => void go({ tab: 'select', index: Number(id) })}
              onClose={(id) => void go({ tab: 'close', index: Number(id) })}
            />
            <PanelIconButton name="plus" title="New tab" onClick={() => void newTab()} />
            <div className="w-px h-4 bg-edge shrink-0 mx-1" aria-hidden="true" />
          </>
        ) : (
          <>
            <GlobeIcon className="w-4 h-4 text-fg-muted shrink-0 mx-1" />
            <div className="min-w-0 flex-1 text-sm-tight font-semibold text-fg truncate">Browser</div>
          </>
        )}
        <span className="text-2xs text-fg-muted shrink-0 mx-1" aria-live="polite">{status}</span>
        {webPage && <PanelIconButton name="external" title="Open in your own browser" onClick={openInMyBrowser} />}
        {active && <PanelIconButton name={copied ? 'check' : 'link'} title={copied ? 'Copied' : 'Copy link'} onClick={copyLink} />}
        {/* Expand is a no-op at phone width — the panel is already the whole screen. */}
        {!narrow && (
          <PanelIconButton name={expanded ? 'shrink' : 'expand'} title={expanded ? 'Shrink panel' : 'Expand panel'} active={expanded} onClick={() => toggleBrowserExpanded(sessionId)} />
        )}
        <PanelIconButton name="close" title="Close" onClick={() => closeBrowserPane(sessionId)} />
      </div>
      <div className="flex items-center gap-1 px-2 pb-2 shrink-0">
        {/* Greyed out with nowhere to go, like any browser. */}
        <Button variant="ghost" size="icon-sm" aria-label="Back" disabled={!hasTabs || !active?.canGoBack} onClick={() => void go({ nav: 'back' })}><BackIcon /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Forward" disabled={!hasTabs || !active?.canGoForward} onClick={() => void go({ nav: 'forward' })}><ForwardIcon /></Button>
        {active?.loading
          ? <Button variant="ghost" size="icon-sm" aria-label="Stop loading" onClick={() => void go({ nav: 'stop' })}><StopIcon /></Button>
          : <Button variant="ghost" size="icon-sm" aria-label="Reload" disabled={!hasTabs || blank} onClick={() => void go({ nav: 'reload' })}><ReloadIcon /></Button>}
        <TextInput
          ref={addressBox}
          size="sm"
          className="min-w-0 flex-1"
          aria-label="Address or search"
          placeholder="Type an address or search"
          spellCheck={false}
          value={draft ?? (blank ? '' : active?.url ?? '')}
          onFocus={(e) => { setDraft(e.currentTarget.value); e.currentTarget.select(); }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={onAddressKey}
        />
      </div>
      {/* WHY the short error line (FieldError), not grey text (guide "Status and notices": a short
          error on an item is the notice box in miniature; never an error that reads as a hint). */}
      {openError && <div className="px-3 py-1.5"><FieldError as="p">{openError}</FieldError></div>}
      {info && !info.settings.explainerSeen && (
        // The notice's own button goes inside it through the shared box's actions (guide "Status
        // and notices"), not a hand-placed row under its words.
        <Callout className="mx-3 my-2" title="The assistant's own browser" actionsPlacement="below"
          actions={<Button variant="secondary" size="sm" onClick={dismissExplainer}>Got it</Button>}>
          <p>Private: separate from your own browser and sign-ins. Sites you sign into here stay signed in until you sign out. You can click, scroll and type in the page yourself.</p>
        </Callout>
      )}
      {narrow && state?.prompt && <BrowserAskCard sessionId={sessionId} />}
      {body}
    </div>
  );
}
