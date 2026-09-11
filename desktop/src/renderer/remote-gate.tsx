// What a browser shows before the app, when the page reaches its computer through the shim.
//
// WHY its own module (Destin, 2026-09-11, phone pass of remote access batches 2/3: "password
// screen occasionally flickering before loading back into the thing without actually needing
// a password"): this lived in index.tsx, where the password screen was the answer to every "not
// connected yet", including the second or two a SAVED key takes to sign in, which happens each
// time a phone's browser reloads the tab after sleep. The rule now: the password box shows only
// when a password is actually needed. Out here it can be tested (tests/remote-gate.test.tsx).
//
// Only TYPES come from remote-shim. The caller loads the shim with a dynamic import, so the
// desktop bundle never evaluates it (the same reason remote-events.ts exists).
import React, { useCallback, useEffect, useState } from 'react';
import { Button, TextInput } from './components/ui';
import type { RemoteConnectionState, SavedKeySignInEvent, SignInFailure } from './remote-shim';

/** The part of the shim this screen drives. */
export interface RemoteGateShim {
  installShim(): void;
  connect(passwordOrToken: string, isToken?: boolean): Promise<string>;
  onConnectionStateChange(cb: (state: RemoteConnectionState) => void): void;
  retryLocalBridge(): void;
  startSavedKeySignIn(listener: (e: SavedKeySignInEvent) => void): boolean;
  retrySavedKeyNow(): void;
  stopSavedKeySignIn(): void;
}

type Trouble = Exclude<SignInFailure['kind'], 'refused'>;

/** Plain words for a sign-in that did not finish. Each says only what the failure proves. */
export function troubleText(kind: Trouble): string {
  switch (kind) {
    case 'unreachable': return "Can't reach your computer.";
    case 'rate-limited': return 'Your computer paused sign-ins after too many failed attempts.';
    default: return 'Your computer closed the connection before sign-in finished.';
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
      const failure: SignInFailure | undefined = err?.signInFailure;
      // WHY not "Invalid password" for everything (it was): a phone with no signal typing the
      // right password was told it was wrong, and tried other passwords.
      setError(
        failure?.kind === 'refused' && failure.reason === 'no-password-configured'
          ? 'This computer has no remote access password yet. Set one on the computer itself, in Settings → Remote Access.'
          : failure && failure.kind !== 'refused'
            ? troubleText(failure.kind)
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
            theme entirely. The button stays BELOW the field rather than inside it
            (change 77): this is a stacked submit form, not a field with an inline action. */}
        <Button type="submit" disabled={loading} size="lg" className="justify-center">
          {loading ? 'Connecting...' : 'Connect'}
        </Button>
        {/* The token, not `text-red-400`, is what community packs can restyle. */}
        {error && (
          <p className="text-destructive-fg text-xs text-center">{error}</p>
        )}
      </form>
    </div>
  );
}

/** The saved key is signing in, or trying to. No password box: none is needed yet. */
function SavedKeyScreen({ trouble, onTryNow, onPassword }: {
  trouble: Trouble | null;
  onTryNow: () => void;
  onPassword: () => void;
}) {
  return (
    <div className="flex items-center justify-center h-full bg-panel text-fg">
      <div className="flex flex-col gap-3 w-72 text-center">
        <h1 className="text-xl font-bold mb-2">YouCoded Remote</h1>
        {trouble ? (
          <>
            <p className="text-sm text-fg-2" role="status">{troubleText(trouble)}</p>
            <p className="text-xs text-fg-muted">Trying again…</p>
            <Button size="lg" className="justify-center" onClick={onTryNow}>Try now</Button>
            {/* The way out when the computer is gone for good, or this browser should pair
                again. The saved key is kept: a reload tries it once more. */}
            <Button variant="ghost" className="justify-center" onClick={onPassword}>Enter password instead</Button>
          </>
        ) : (
          <p className="text-sm text-fg-2" role="status">Connecting to your computer…</p>
        )}
      </div>
    </div>
  );
}

/** `pending` until the shim has loaded; then whether a saved key is being tried, and how it went. */
type SavedKey = 'pending' | 'none' | 'connecting' | Trouble;

/**
 * Owns the connection state before the app exists. Once connected the app stays on screen
 * through any later drop — the strip inside it reports those.
 */
export function RemoteGate({ isAndroid, loadShim, renderApp }: {
  isAndroid: boolean;
  loadShim: () => Promise<RemoteGateShim>;
  renderApp: () => React.ReactNode;
}) {
  const [shim, setShim] = useState<RemoteGateShim | null>(null);
  const [connected, setConnected] = useState(false);
  const [hasConnectedOnce, setHasConnectedOnce] = useState(false);
  const [savedKey, setSavedKey] = useState<SavedKey>('pending');

  useEffect(() => {
    void loadShim().then((s) => {
      s.installShim();
      s.onConnectionStateChange((state) => {
        const isConnected = state === 'connected';
        setConnected(isConnected);
        if (isConnected) setHasConnectedOnce(true);
      });
      setShim(s);
      // Android WebView: auto-connect to LocalBridgeServer. If the bridge server isn't
      // listening yet (startup race), retry with backoff.
      if (isAndroid) {
        s.connect('android-local', false).catch((err) => {
          console.error('Android auto-connect failed:', err);
          s.retryLocalBridge();
        });
        setSavedKey('none');
        return;
      }
      const started = s.startSavedKeySignIn((e) => setSavedKey(e.type === 'refused' ? 'none' : e.kind));
      setSavedKey(started ? 'connecting' : 'none');
    });
    // Once, for the page's life: the shim is a module-level singleton.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogin = useCallback(async (password: string) => {
    if (!shim) return;
    await shim.connect(password);
  }, [shim]);

  // Once connected, keep showing the app even during transient disconnections.
  if (connected || hasConnectedOnce) return <>{renderApp()}</>;

  if (!shim || savedKey === 'pending') {
    return <div className="flex items-center justify-center h-full bg-panel text-fg text-sm">Loading...</div>;
  }

  // Android always auto-connects to local bridge — never show the password screen.
  // Fix: wait for connection/auth to complete BEFORE mounting App. IPC calls made during the
  // pre-auth window (theme:list, skills:list, etc.) are dropped by LocalBridgeServer's
  // unauthenticated-client guard (LocalBridgeServer.kt:116), then time out silently after 30s.
  if (isAndroid) {
    return <div className="flex items-center justify-center h-full bg-panel text-fg text-sm">Connecting...</div>;
  }

  if (savedKey !== 'none') {
    return (
      <SavedKeyScreen
        trouble={savedKey === 'connecting' ? null : savedKey}
        onTryNow={() => shim.retrySavedKeyNow()}
        onPassword={() => { shim.stopSavedKeySignIn(); setSavedKey('none'); }}
      />
    );
  }

  return <LoginScreen onLogin={handleLogin} />;
}
