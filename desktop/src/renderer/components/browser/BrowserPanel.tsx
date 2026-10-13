// The Browser panel — the chat's right-side slot showing what the assistant's
// browser is doing (spec docs/active/specs/2026-10-13-assistant-browser-design.md §2 Screens).
//
// The picture is VIEW-ONLY on purpose (design review 1 #8): signing in and
// captchas happen in a real window ("Show window"), where password managers,
// passkeys and 2FA work. Clicking through a screencast was cut.
//
// Hidden means idle (performance rule 2): this component is mounted only while
// the panel is open AND its chat is the visible one (ChatView renders the slot
// only when `visible`), it asks for pictures only while mounted and the app
// window isn't hidden, and each picture is written straight to the <img> — no
// React state per frame — then acknowledged so the next one may come.
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserInfo, BrowserSessionState } from '../../../shared/browser-types';
import { closeBrowserPane, useBrowserState } from '../../state/browser-store';
import { Button, Callout, CloseButton, Dialog, EmptyState, ErrorState, LoadingState } from '../ui';
import { GlobeIcon } from '../Icons';
import { ScreenMark } from '../../shoot-mode';
import { ContextMenu } from '../context-menu/ContextMenu';

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

/** The live picture of the chat's current tab. */
const LivePicture = memo(function LivePicture({ sessionId, title }: { sessionId: string; title: string }) {
  const img = useRef<HTMLImageElement>(null);
  const [hasFrame, setHasFrame] = useState(false);

  useEffect(() => {
    const b = bridge();
    let watching = false;
    const start = () => { if (!watching && !document.hidden) { watching = true; void b.watch(sessionId).catch(() => { watching = false; }); } };
    const stop = () => { if (watching) { watching = false; void b.unwatch(sessionId).catch(() => {}); } };
    // A minimized/hidden app window stops the stream (hidden means idle).
    const onVis = () => (document.hidden ? stop() : start());
    const off = b.onFrame((f: { sessionId: string; data: string }) => {
      if (f.sessionId !== sessionId || !img.current) return;
      img.current.src = `data:image/jpeg;base64,${f.data}`;
      setHasFrame(true); // a no-op after the first frame (same value)
    });
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => { off(); stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [sessionId]);

  // Ack after the picture is drawn, so a busy screen slows the stream instead of queueing.
  const onLoad = useCallback(() => { bridge().ackFrame(sessionId); }, [sessionId]);

  return (
    <div className="relative flex-1 min-h-0 flex items-start justify-center overflow-hidden rounded-md">
      <img
        ref={img}
        onLoad={onLoad}
        alt={title ? `What the assistant's browser shows: ${title}` : "What the assistant's browser shows"}
        className={`w-full h-auto max-h-full object-contain object-top ${hasFrame ? '' : 'hidden'}`}
        draggable={false}
      />
      {!hasFrame && <LoadingState what="the picture" verb="Waiting for" variant="inline" className="py-6" />}
      {/* Photo-only build: the panel counts as showing once a picture is drawn. */}
      {hasFrame && <ScreenMark name="chat/browser" />}
    </div>
  );
});

export default function BrowserPanel({ sessionId }: { sessionId: string }) {
  const state = useBrowserState(sessionId);
  const [info, setInfo] = useState<BrowserInfo | null>(null);
  const [confirmRestart, setConfirmRestart] = useState<null | boolean>(null);
  const [switching, setSwitching] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => { void bridge().info().then((i: BrowserInfo) => { if (live) setInfo(i); }).catch(() => {}); };
    load();
    const off = bridge().onInfoChanged(load);
    return () => { live = false; off(); };
  }, []);

  const active = state?.tabs.find((t) => t.active) ?? null;
  const host = active ? hostOf(active.url) : '';
  const status = browserStatusWord(state);
  const windowShown = state?.windowShown ?? info?.settings.showWindow ?? false;
  const myChrome = state?.myChrome ?? info?.settings.useMyChrome ?? false;

  const applyWindow = useCallback(async (show: boolean) => {
    setConfirmRestart(null);
    setSwitching(true);
    try { setInfo(await bridge().setShowWindow(show)); } catch { /* the state push says what happened */ }
    setSwitching(false);
  }, []);

  // A restart reopens pages but loses unsent typing; ask first when anything is open.
  const onWindowButton = useCallback(() => {
    const show = !windowShown;
    if ((state?.tabs.length ?? 0) > 0 || (info?.sessionsWithTabs ?? 0) > 0) setConfirmRestart(show);
    else void applyWindow(show);
  }, [windowShown, state, info, applyWindow]);

  const dismissExplainer = useCallback(async () => {
    try { setInfo(await bridge().updateSettings({ explainerSeen: true })); } catch { /* stays visible; harmless */ }
  }, []);

  const otherChats = Math.max(0, (info?.sessionsWithTabs ?? 0) - ((state?.tabs.length ?? 0) > 0 ? 1 : 0));

  let body: React.ReactNode;
  let showingPicture = false;
  if (state?.run === 'error' && state.error) {
    body = <ErrorState className="m-3" message={state.error} onRetry={() => { void bridge().stop(); }} />;
  } else if (state?.run === 'starting' || switching) {
    body = <LoadingState what="the browser" verb="Starting" />;
  } else if (!state || state.tabs.length === 0 || state.run !== 'running') {
    body = <EmptyState message="The assistant isn't using the browser in this conversation right now." />;
  } else {
    showingPicture = true;
    body = (
      <div className="flex-1 min-h-0 flex flex-col gap-2 p-2">
        {myChrome && <p className="text-2xs text-fg-muted px-1">Working in your Chrome. You can watch it there too.</p>}
        <LivePicture sessionId={sessionId} title={active?.title ?? ''} />
        {state.tabs.length > 1 && (
          <ul className="text-2xs text-fg-muted px-1 space-y-0.5" aria-label="This conversation's tabs">
            {state.tabs.map((t) => (
              <li key={t.index} className={`truncate ${t.active ? 'text-fg-2 font-medium' : ''}`}>{t.title || hostOf(t.url)}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="browser-panel relative h-full flex flex-col overflow-hidden bg-inset select-none">
      {!showingPicture && <ScreenMark name="chat/browser" />}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
        <GlobeIcon className="w-4 h-4 text-fg-muted shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg truncate">{active?.title || 'Browser'}</div>
        </div>
        <span className="text-2xs text-fg-muted shrink-0" aria-live="polite">{status}</span>
        <CloseButton label="Close the Browser panel" onClick={() => closeBrowserPane(sessionId)} />
      </div>
      <div className="flex items-center gap-2 px-3 pb-2">
        <div className="min-w-0 flex-1 text-2xs text-fg-muted truncate select-text" title={active?.url}>
          {active ? <><span className="text-fg-2 font-medium">{host}</span>{active.url.slice(active.url.indexOf(host) + host.length)}</> : ' '}
        </div>
        {!myChrome && (
          <Button variant="secondary" size="sm" onClick={onWindowButton} disabled={switching}>
            {windowShown ? 'Hide window' : 'Show window'}
          </Button>
        )}
        <Button
          variant="ghost" size="icon-sm" aria-label="More browser actions" aria-haspopup="menu"
          onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenuAt({ x: r.right - 180, y: r.bottom + 4 }); }}
        >
          <span aria-hidden className="text-fg-muted">•••</span>
        </Button>
      </div>
      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          onClose={() => setMenuAt(null)}
          entries={[
            { type: 'item', id: 'copy-address', label: 'Copy address', icon: 'link', disabled: !active, run: () => { if (active) void navigator.clipboard?.writeText(active.url).catch(() => {}); } },
            { type: 'item', id: 'stop-chat', label: 'Stop for this chat', icon: 'stop', disabled: !state?.tabs.length, run: () => { void bridge().closeSession(sessionId); } },
          ]}
        />
      )}
      {info && !info.settings.explainerSeen && (
        <Callout className="mx-3 mb-2" title="The assistant's own browser">
          <p>It's private: separate from your own browser, your other tabs and your sign-ins. Anything you sign into here is remembered for next time. Use Show window if you'd like to watch it in a real window.</p>
          <div className="flex justify-end mt-2">
            <Button variant="secondary" size="sm" onClick={dismissExplainer}>Got it</Button>
          </div>
        </Callout>
      )}
      {body}
      <Dialog
        open={confirmRestart !== null}
        onClose={() => setConfirmRestart(null)}
        title={confirmRestart ? 'Show the browser window?' : 'Hide the browser window?'}
        size="prompt"
        noScreen="a two-button confirm inside the Browser panel; its wording is pinned by BrowserPanel.test.tsx"
      >
        <p className="text-sm text-fg-2">
          {confirmRestart ? 'Showing' : 'Hiding'} the window restarts the browser. Pages reopen where they were, but anything typed and not yet sent is lost.
          {otherChats > 0 ? ` This also affects ${otherChats} other chat${otherChats === 1 ? '' : 's'} using the browser.` : ''}
        </p>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" onClick={() => setConfirmRestart(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => void applyWindow(!!confirmRestart)}>{confirmRestart ? 'Restart and show' : 'Restart and hide'}</Button>
        </div>
      </Dialog>
    </div>
  );
}
