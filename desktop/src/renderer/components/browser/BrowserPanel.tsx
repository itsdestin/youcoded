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
import { Button, Callout, EmptyState, ErrorState, LoadingState, TextInput } from '../ui';
import { PanelIconButton } from '../panel-icon-button';
import { BackIcon, ForwardIcon, GlobeIcon, ReloadIcon } from '../Icons';
import { ScreenMark } from '../../shoot-mode';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
import BrowserAskCard from './BrowserAskCard';

function bridge() { return (window as any).claude.browser; }

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

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
 *  Ctrl/Cmd+V (the page gets the clipboard's text), null to ignore. */
export function keyEventFor(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): BrowserInputEvent | 'paste' | null {
  const cmd = e.ctrlKey || e.metaKey;
  if (cmd && !e.altKey && e.key.toLowerCase() === 'v') return 'paste';
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

/** The live picture of the chat's current tab — also the person's way to use it. */
const LivePicture = memo(function LivePicture({ sessionId, title }: { sessionId: string; title: string }) {
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

  const onClick = (e: React.MouseEvent, button: 'left' | 'right') => {
    const p = point(e);
    if (p) send({ type: 'click', x: p.x, y: p.y, clickCount: Math.max(1, e.detail || 1), button });
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
    if (ev === 'paste') {
      void navigator.clipboard?.readText().then((text) => { if (text) send({ type: 'text', text: text.slice(0, 10_000) }); }).catch(() => {});
      return;
    }
    send(ev);
  };

  return (
    <div
      ref={box}
      tabIndex={0}
      role="application"
      aria-label="The page. Click to use it; while it's selected, typing goes to the page."
      data-keyboard-owner
      onKeyDown={onKeyDown}
      className="relative flex-1 min-h-0 flex items-start justify-center overflow-hidden rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
    >
      <img
        ref={img}
        onLoad={onLoad}
        onError={onLoad}
        // Focus the picture on press so typing goes to the page; no image drag.
        onMouseDown={(e) => { e.preventDefault(); box.current?.focus({ preventScroll: true }); }}
        // A tap was already sent by onPointerUp; its follow-on click is not a second one.
        onClick={(e) => { if (!lastPointerWasTouch.current) onClick(e, 'left'); }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { touch.current = null; }}
        onContextMenu={(e) => { e.preventDefault(); onClick(e, 'right'); }}
        onWheel={onWheel}
        alt={title ? `What the assistant's browser shows: ${title}` : "What the assistant's browser shows"}
        className={`w-full h-auto max-h-full object-contain object-top cursor-default touch-none ${hasFrame ? '' : 'hidden'}`}
        draggable={false}
      />
      {!hasFrame && <div className="my-6"><LoadingState what="the picture" verb="Waiting for" variant="inline" /></div>}
      {/* Photo-only build: the panel counts as showing once a picture is drawn. */}
      {hasFrame && <ScreenMark name="chat/browser" />}
    </div>
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
  const go = useCallback(async (req: { address: string } | { nav: 'back' | 'forward' | 'reload' }) => {
    setOpenError(null);
    try {
      const r = await bridge().open({ sessionId, ...req });
      if (!r?.ok) setOpenError(r?.error ?? "That page couldn't be opened.");
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : "That page couldn't be opened.");
    }
  }, [sessionId]);
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
      <div className="flex-1 min-h-0 flex flex-col gap-2 p-2">
        {myChrome && <p className="text-2xs text-fg-muted px-1">Working in your Chrome. You can watch it there too.</p>}
        <LivePicture sessionId={sessionId} title={active?.title ?? ''} />
        {state.tabs.length > 1 && (
          <ul className="text-2xs text-fg-muted px-1 space-y-0.5" aria-label="This conversation's tabs">
            <li className="font-medium uppercase tracking-wide">Tabs {state.tabs.length}</li>
            {state.tabs.map((t) => (
              <li key={t.index} className={`truncate ${t.active ? 'text-fg-2 font-medium' : ''}`}>{t.title || hostOf(t.url)}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full flex flex-col overflow-hidden bg-inset select-none">
      {!showingPicture && <ScreenMark name="chat/browser" />}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-edge shrink-0">
        <GlobeIcon className="w-4 h-4 text-fg-muted shrink-0 mx-1" />
        <div className="min-w-0 flex-1 text-sm-tight font-semibold text-fg truncate">{active?.title || 'Browser'}</div>
        <span className="text-2xs text-fg-muted shrink-0 mr-1" aria-live="polite">{status}</span>
        {webPage && <PanelIconButton name="external" title="Open in your own browser" onClick={openInMyBrowser} />}
        {active && <PanelIconButton name={copied ? 'check' : 'link'} title={copied ? 'Copied' : 'Copy link'} onClick={copyLink} />}
        {/* Expand is a no-op at phone width — the panel is already the whole screen. */}
        {!narrow && (
          <PanelIconButton name={expanded ? 'shrink' : 'expand'} title={expanded ? 'Shrink panel' : 'Expand panel'} active={expanded} onClick={() => toggleBrowserExpanded(sessionId)} />
        )}
        <PanelIconButton name="close" title="Close" onClick={() => closeBrowserPane(sessionId)} />
      </div>
      <div className="flex items-center gap-1 px-3 py-2">
        <Button variant="ghost" size="icon-sm" aria-label="Back" disabled={!hasTabs} onClick={() => void go({ nav: 'back' })}><BackIcon /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Forward" disabled={!hasTabs} onClick={() => void go({ nav: 'forward' })}><ForwardIcon /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Reload" disabled={!hasTabs} onClick={() => void go({ nav: 'reload' })}><ReloadIcon /></Button>
        <TextInput
          size="sm"
          className="min-w-0 flex-1"
          aria-label="Address or search"
          placeholder="Type an address or search"
          spellCheck={false}
          value={draft ?? active?.url ?? ''}
          onFocus={(e) => { setDraft(e.currentTarget.value); e.currentTarget.select(); }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={onAddressKey}
        />
      </div>
      {openError && <p role="alert" className="text-2xs text-fg-muted px-3 pb-2">{openError}</p>}
      {info && !info.settings.explainerSeen && (
        <Callout className="mx-3 mb-2" title="The assistant's own browser">
          <p>Private: separate from your own browser and sign-ins. Sites you sign into here stay signed in until you sign out. You can click, scroll and type in the page yourself.</p>
          <div className="flex justify-end mt-2">
            <Button variant="secondary" size="sm" onClick={dismissExplainer}>Got it</Button>
          </div>
        </Callout>
      )}
      {narrow && state?.prompt && <BrowserAskCard sessionId={sessionId} />}
      {body}
    </div>
  );
}
