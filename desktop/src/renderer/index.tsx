// Must run before any component import — sets window.__PLATFORM__ synchronously
// so module-level isAndroid()/isRemoteMode() reads in imported files see the
// right value. See platform-bootstrap.ts for why.
import './platform-bootstrap';
import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import App from './App';
import { Button, TextInput } from './components/ui';

// Perf lab startup mark (read over CDP by youcoded-dev/scripts/perf-lab). Free.
// WHY the name says "modules-evaluated" and not "start": ESM hoists EVERY import
// declaration in this file above every statement in the module body, so by the
// time this line runs, React, react-dom, globals.css, App.tsx and the whole
// component graph above have already finished evaluating. This mark is the END
// of bundle evaluation, not the start of it — it is written below the imports so
// the source reads the way it actually executes. The window it used to hide
// (page navigation -> here) is recovered by the rig for free as
// `modulesEvaluated - documentStart`, using performance.timeOrigin.
performance.mark('yc:modules-evaluated');

// A live-candidate pane (?mode=workbench&child=1&view=live) is addressed purely by URL: the
// review deck embeds it from another origin and so cannot reach this origin's localStorage to
// set a theme. Seeding the stored value HERE — above the anti-FOUC read below, which IS the
// first paint, and which reads the same key ThemeProvider's initialiser reads
// (state/theme-context.tsx: STORAGE_KEY / activeSlug) — is what makes a pane arrive already
// wearing its theme instead of flashing the previous one on every step of a review.
//
// WHY not teach the theme system to read ?theme=: that file is the app's real theming on every
// surface, and the remote web UI has real URLs, so a query-string override there would reach
// far outside this dev-only tool. Scoped to this exact three-parameter address instead.
// (The write persists on this origin, so the last theme a pane used becomes the default for a
// plain ?mode=workbench tab on the same port. Dev-only, and the deck always passes a theme.)
const __liveQuery = new URLSearchParams(location.search);
const __liveTheme = __liveQuery.get('theme');
if (__liveTheme && __liveQuery.get('mode') === 'workbench'
    && __liveQuery.get('child') === '1' && __liveQuery.get('view') === 'live') {
  try { localStorage.setItem('youcoded-theme', __liveTheme); } catch { /* private mode */ }
}

// Apply theme before React mounts to prevent FOUC (flash of unstyled content)
const storedTheme = localStorage.getItem('youcoded-theme') || 'midnight';
document.documentElement.setAttribute('data-theme', storedTheme);

// Mark buddy windows on <html> SYNCHRONOUSLY (before first paint) so the
// buddy.css transparency overrides (color-scheme: normal, bg transparent)
// take effect immediately. If we waited for BuddyMascotApp's useEffect to
// set data-mode on body, the browser would paint the first frame using the
// theme's color-scheme: dark (Midnight/Dark) and a dark rectangle would
// flash — and on Electron's transparent:true window that dark canvas
// persists as a visible dark square around the mascot until the effect runs.
// Setting on <html> also means the selector doesn't need :has(), which has
// had subtle ordering bugs with color-scheme in some Chromium versions.
const __buddyMode = new URLSearchParams(location.search).get('mode');
if (
  __buddyMode === 'buddy-mascot' || __buddyMode === 'buddy-chat' || __buddyMode === 'buddy-bar' ||
  // Linux-Wayland single-window overlay (Task 6) — same anti-FOUC reasoning
  // as the three modes above, one more mode string to allow through.
  __buddyMode === 'buddy-overlay'
) {
  document.documentElement.setAttribute('data-mode', __buddyMode);
}

// Mirror document visibility onto <html> so CSS keyframe loops can pause. JS
// drivers gate themselves on visibilitychange directly; CSS animations have no
// equivalent hook, so they key off this attribute (see mascot.css).
const syncDocHidden = () => {
  document.documentElement.setAttribute(
    'data-doc-hidden',
    document.visibilityState === 'visible' ? '0' : '1',
  );
};
document.addEventListener('visibilitychange', syncDocHidden);
syncDocHidden();

// macOS traffic lights need left padding on the header bar.
// In fullscreen the traffic lights disappear, so we remove the inset.
if (navigator.platform === 'MacIntel' || navigator.platform === 'MacPPC') {
  document.body.classList.add('mac-titlebar-inset');
  const claude = (window as any).claude;
  if (claude?.window?.onFullscreenChanged) {
    claude.window.onFullscreenChanged((isFullscreen: boolean) => {
      if (isFullscreen) {
        document.body.classList.remove('mac-titlebar-inset');
      } else {
        document.body.classList.add('mac-titlebar-inset');
      }
    });
  }
}

/** Minimal login screen for remote browser access. */
function LoginScreen({ onLogin }: { onLogin: (password: string) => Promise<void>; }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // WHY the screen asks the host before drawing: a computer with no password set cannot
  // accept ANY password, and this screen used to show the box anyway — you typed a guess,
  // pressed Connect, and only then were told it was never configured. null = we have not
  // heard back yet, and until we do the box behaves exactly as it always has.
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/remote-state', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(state => { if (live && state && typeof state.needsSetup === 'boolean') setNeedsSetup(state.needsSetup); })
      // An older host has no such endpoint. Staying on the password box is the right
      // fallback: it is what this screen did before, not a guess about the host.
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await onLogin(password);
    } catch (err: any) {
      setError(
        err.message === 'no-password-configured'
          ? 'This computer has no remote access password yet. Set one on the computer itself, in Settings \u2192 Remote Access.'
          : 'Invalid password'
      );
      setLoading(false);
    }
  };

  if (needsSetup) {
    // No password on the host: there is nothing to type, so nothing is offered to type
    // into. The one thing that moves this forward happens on the other computer.
    return (
      <div className="flex items-center justify-center h-full bg-panel text-fg">
        <div className="flex flex-col gap-3 w-72 text-center">
          <h1 className="text-xl font-bold mb-2">YouCoded Remote</h1>
          <p className="text-sm text-fg-2">This computer has no remote access password yet.</p>
          <p className="text-xs text-fg-muted">
            On the computer itself, open Settings &rarr; Remote Access and set a password.
            Then reload this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full bg-panel text-fg">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 w-72">
        <h1 className="text-xl font-bold text-center mb-2">YouCoded Remote</h1>
        {/* Was a hand-rolled field with gray focus (`focus:border-fg-muted`) — the
            exact paradigm change 20 retires. Fields focus by accent border now. */}
        <TextInput
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          disabled={loading}
        />
        {/* Was `bg-blue-600 hover:bg-blue-500` — a hardcoded blue that ignored the
            theme entirely. The button sweep missed this file because the remote
            login screen lives in index.tsx, not components/. The button stays
            BELOW the field rather than inside it (change 77): this is a stacked
            submit form, not a field with an inline action. */}
        <Button type="submit" disabled={loading} size="lg" className="justify-center">
          {loading ? 'Connecting...' : 'Connect'}
        </Button>
        {/* Error text was `text-red-400`. Same pixel today (the app remaps
            red-400 to #DD4444), but the token is what community packs can
            restyle. */}
        {error && (
          <p className="text-destructive-fg text-xs text-center">{error}</p>
        )}
      </form>
    </div>
  );
}

/**
 * Wrapper that owns all connection logic. LoginScreen is pure-presentational.
 * This eliminates the race condition where LoginScreen and Root both
 * independently manage connection state.
 */
// Capture before any shim can modify window.claude
const isElectron = !!(window as any).claude;
// Android WebView loads from file:// — always auto-connects, never needs a password screen
const isAndroid = location.protocol === 'file:';

// __PLATFORM__ is already set by platform-bootstrap.ts for electron/android;
// browser/remote path leaves it undefined until remote-shim auth:ok fills it in.

function Root() {
  const [connected, setConnected] = useState(isElectron);
  const [hasConnectedOnce, setHasConnectedOnce] = useState(isElectron);
  const [shimReady, setShimReady] = useState(isElectron);

  // In browser mode: install shim once, attempt token auto-login, listen for state changes
  useEffect(() => {
    if (isElectron) return;
    import('./remote-shim').then(({ installShim, connect, onConnectionStateChange, retryLocalBridge }) => {
      installShim();
      setShimReady(true);

      onConnectionStateChange((state) => {
        const isConnected = state === 'connected';
        setConnected(isConnected);
        if (isConnected) setHasConnectedOnce(true);
      });

      // Android WebView: auto-connect to LocalBridgeServer. If the bridge
      // server isn't listening yet (startup race), retry with backoff.
      if (location.protocol === 'file:') {
        connect('android-local', false).catch((err) => {
          console.error('Android auto-connect failed:', err);
          retryLocalBridge();
        });
        return;
      }

      // Auto-login with stored token
      const storedToken = localStorage.getItem('youcoded-remote-token');
      if (storedToken) {
        connect(storedToken, true).catch(() => {
          localStorage.removeItem('youcoded-remote-token');
        });
      }
    });
  }, [isElectron]);

  const handleLogin = useCallback(async (password: string) => {
    const { connect } = await import('./remote-shim');
    await connect(password);
  }, []);

  // Once connected, keep showing App even during transient disconnections
  if (isElectron || connected || hasConnectedOnce) {
    return <App />;
  }

  if (!shimReady) {
    return <div className="flex items-center justify-center h-full bg-panel text-fg text-sm">Loading...</div>;
  }

  // Android always auto-connects to local bridge — never show the password screen.
  // Fix: wait for connection/auth to complete BEFORE mounting App. shimReady only
  // guarantees window.claude exists, not that auth:ok has fired. IPC calls made
  // during the pre-auth window (theme:list, skills:list, etc.) are dropped by
  // LocalBridgeServer's unauthenticated-client guard (LocalBridgeServer.kt:116),
  // then time out silently after 30s — causing install'd themes/skills to never
  // appear in the UI. The first branch above renders App once `connected` flips;
  // keep this path on a Loading state until then so we never ship IPC pre-auth.
  if (isAndroid) {
    return <div className="flex items-center justify-center h-full bg-panel text-fg text-sm">Connecting...</div>;
  }

  return <LoginScreen onLogin={handleLogin} />;
}

// Workbench boot. `import.meta.env.DEV` is statically replaced with `false` in
// production, so Vite drops this whole branch and never emits the chunk.
//
// WHY it renders <App/> and not <Root/>: Root exists only to own remote
// connection state, and its `isElectron` (line 112) is a module-eval-time
// const — an async mock install lands too late for it, so going through Root
// would mean converting that const to a function and updating its six readers
// in a file every launch goes through. The workbench has no connection state;
// skipping Root costs nothing and touches no production boot code.
//
// It also does NOT route through App.tsx: WorkbenchFrame renders <App/>, so an
// App-side route would recurse and need a `workbenchChild` prop threaded
// through App purely to break it. `?mode=workbench` matches none of App's
// existing buddyMode branches, so <App/> falls through to the main app.
const __mount = createRoot(document.getElementById('root')!);
// @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
// Site mode: the landing page embeds the workbench as a live demo, built with
// `npm run build:site` (VITE_WORKBENCH=1). Any other production build still
// tree-shakes this whole branch — VITE_WORKBENCH is unset, so the condition is
// statically false and the workbench chunks never ship in the app.
if ((import.meta.env.DEV || import.meta.env.VITE_WORKBENCH === '1') && __buddyMode === 'workbench') {
  // `child=1` is the iframe the workbench frame hosts (see WorkbenchFrame.tsx
  // for why it is an iframe): it renders the app itself, at the iframe's own
  // viewport width, so useNarrowViewport() sees a real narrow viewport. The
  // outer document renders the toolbar frame around it.
  const isChild = new URLSearchParams(location.search).get('child') === '1';
  import('./dev/workbench/install-mock').then(async ({ installMock }) => {
    // The mock installs in BOTH documents: the child needs it to run the app,
    // and the parent frame would otherwise fall through to Root's login path if
    // anything there ever reads the bridge.
    installMock();
    if (isChild) {
      // The tool gallery is a separate surface, not part of the app shell, so it
      // renders in place of <App/> rather than inside it. It DOES get a real
      // ThemeProvider — the ?mode=tool-sandbox route it replaces rendered
      // outside the provider tree and so was never themed.
      const __view = new URLSearchParams(location.search).get('view');
      if (__view === 'tools') {
        const [{ ToolGallery }, { ThemeProvider }] = await Promise.all([
          import('./dev/workbench/ToolGallery'),
          import('./state/theme-context'),
        ]);
        __mount.render(<ThemeProvider><ToolGallery /></ThemeProvider>);
        return;
      }
      // Comparison view — same deal as the tool gallery: its own surface, not
      // part of the app shell, so it replaces <App/> rather than mounting
      // inside it. ChatProvider rides along because a candidate may isolate a
      // chat-side component (ToolCard calls useChatDispatch and would crash
      // outside it); it costs nothing for candidates that don't.
      if (__view === 'compare') {
        const [{ CompareView }, { ThemeProvider }, { ChatProvider }] = await Promise.all([
          import('./dev/workbench/CompareView'),
          import('./state/theme-context'),
          import('./state/chat-context'),
        ]);
        __mount.render(<ThemeProvider><ChatProvider><CompareView /></ChatProvider></ThemeProvider>);
        return;
      }
      // ONE candidate from the compare registry, alone and chrome-free — what a review
      // deck embeds as a live pane (?view=live&surface=…&round=…&candidate=…), and with no
      // ?surface an index of every candidate there is. Both providers for the same reason
      // view=compare documents: a candidate may borrow a real chat component and would
      // crash outside ChatProvider.
      if (__view === 'live') {
        const [{ LiveCandidate }, { ThemeProvider }, { ChatProvider }] = await Promise.all([
          import('./dev/workbench/LiveCandidate'),
          import('./state/theme-context'),
          import('./state/chat-context'),
        ]);
        __mount.render(<ThemeProvider><ChatProvider><LiveCandidate /></ChatProvider></ThemeProvider>);
        return;
      }
      // Attachment-chip page (dev/workbench/mockups/AttachmentChips.tsx) — the
      // two unpicked mock-ups (A, B) beside the SHIPPING card (C, the real
      // AttachmentChip) over the same sample files, so the page can't drift
      // from the composer. Own surface like the two above; ThemeProvider so it
      // reads correctly in all six themes, no ChatProvider because nothing in
      // it touches chat state.
      if (__view === 'attachments') {
        const [{ AttachmentChipsMockup }, { ThemeProvider }] = await Promise.all([
          import('./dev/workbench/mockups/AttachmentChips'),
          import('./state/theme-context'),
        ]);
        __mount.render(<ThemeProvider><AttachmentChipsMockup /></ThemeProvider>);
        return;
      }
      // Session status-pill page (dev/workbench/mockups/SessionStatusPills.tsx)
      // — the five states of the All Sessions menu's pill and what each means,
      // rendering the shipping pill so the words cannot drift from the menu.
      if (__view === 'session-pills') {
        const [{ SessionStatusPillsMockup }, { ThemeProvider }] = await Promise.all([
          import('./dev/workbench/mockups/SessionStatusPills'),
          import('./state/theme-context'),
        ]);
        __mount.render(<ThemeProvider><SessionStatusPillsMockup /></ThemeProvider>);
        return;
      }
      // App is already statically imported above (Root renders it).
      __mount.render(<App />);
      return;
    }
    const { WorkbenchFrame } = await import('./dev/workbench/WorkbenchFrame');
    __mount.render(<WorkbenchFrame />);
  });
} else {
  // Perf lab: last renderer-side mark before the root component tree renders.
  performance.mark('yc:root-render');
  __mount.render(<Root />);
}
