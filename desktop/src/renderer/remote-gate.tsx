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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, FieldError, TextInput } from './components/ui';
import { BrandWordmark } from './components/brand/BrandLockup';
import BrailleSpinner from './components/BrailleSpinner';
import type { RemoteConnectionState, SavedKeySignInEvent, SignInFailure } from './remote-shim';

/**
 * Every screen before the app: the brand surface setup wears — lavender, the stacked name, Outfit, one white card.
 * WHY (phone-reliability review, P-3/P-5, Destin: "style this properly w brand material", "this breaks a bunch of design
 * guide principles"): these were bare centred lines and buttons on the theme's panel, a title in plain bold type, a
 * borderless "Use this phone only" that read as loose text, and a password box under a notice that no password could fix.
 * They are sign-in screens, and the guide gives sign-in screens setup's look.
 */
function GateShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="brand-surface absolute inset-0">
      <div className="scroll-mask absolute inset-0 overflow-y-auto">
        <div className="brand-stage">
          <BrandWordmark size="clamp(40px, min(8vh, 14vw), 64px)" tagline="stack" />
          <div className="flex flex-col items-center gap-4 w-full max-w-sm">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** One white card: a heading, its plain sentence, then whatever acts on it, stacked full width. */
function GateCard({ heading, line, children, role }: { heading: string; line?: React.ReactNode; children?: React.ReactNode; role?: string }) {
  return (
    <section className="brand-card w-full p-6 flex flex-col gap-4" role={role}>
      <div className="text-center">
        <h2 className="brand-heading text-xl text-fg">{heading}</h2>
        {line && <p className="mt-1 text-sm text-fg-dim">{line}</p>}
      </div>
      {children}
    </section>
  );
}

/** A full-width button on the gate: the one filled action in the name's gradient, anything else outlined under it. */
function GateButton({ main, ...rest }: { main?: boolean } & React.ComponentProps<typeof Button>) {
  return main
    ? <Button variant="primary" size="lg" {...rest} className="brand-primary w-full justify-center" />
    : <Button variant="secondary" size="lg" {...rest} className="w-full justify-center" />;
}

/** The part of the shim this screen drives. */
export interface RemoteGateShim {
  installShim(): void;
  connect(passwordOrToken: string, isToken?: boolean): Promise<string>;
  onConnectionStateChange(cb: (state: RemoteConnectionState) => void): void;
  retryLocalBridge(): void;
  startSavedKeySignIn(listener: (e: SavedKeySignInEvent) => void): boolean;
  retrySavedKeyNow(): void;
  stopSavedKeySignIn(): void;
  onCredentialRefused(cb: (reason: string) => void): void;
  connectToHost(host: string, port: number, password: string): Promise<void>;
  disconnectFromHost(): Promise<void>;
}

/** Refusals that mean the computer will not take this device's key again. */
/** Why the gate is showing instead of the app, after the computer closed this page's connection. */
type Notice =
  // A reload of this tab is the only fix, so the card offers that and no password box (P-5).
  | { kind: 'reload'; heading: string; line: string }
  // The computer stopped taking this device's key: the password box, with the reason over it.
  | { kind: 'password'; line: string };
// WHY: the host closes with 4005 when this page is older than the computer's YouCoded. Before
// this, the gate showed a bare password box with no hint, so later version bumps looped silently.
const OLD_PAGE_NOTICE: Notice = { kind: 'reload', heading: 'This page needs a refresh', line: "Your computer's YouCoded was updated. Refresh to get the new page." };
// WHY (2026-10-22): the computer now closes an older connection when the same browser signs in again, so a second tab
// takes over from the first. Only a reload of THIS tab brings it back; the password is not needed.
const OTHER_TAB_NOTICE: Notice = { kind: 'reload', heading: 'Open in another tab', line: 'YouCoded is open in another tab of this browser. Reload this tab to use it here instead.' };
// WHY its own sentence (Destin 2026-10-31): a device signed out for sitting unused 90 days should hear that, not the generic refusal.
const DEVICE_EXPIRED_NOTICE: Notice = { kind: 'password', line: 'This device was signed out after 90 days without use. Enter the password to connect again.' };
const KEY_REFUSED_NOTICE: Notice = { kind: 'password', line: 'This computer no longer accepts this device. Enter the password to connect again.' };
// WHY exported: the photo-only screen list shows this toast with these very words (dev/workbench/ToastPractice).
/** WHY by reason (branch review F9): only a refused credential means the saved password is wrong; a computer with remote access
 *  switched off, or one refusing for another reason, says so instead of sending the person to change a password that is fine. */
export const savedPasswordRefusedNotice = (name: string, reason = 'invalid-credentials') =>
  reason === 'no-password-configured'
    ? `${name} has no remote access password set yet. Set one on that computer, in Settings → Remote access.`
    : ['invalid-credentials', 'revoked', 'unknown'].includes(reason)
      ? `${name} didn't accept the saved password. Update it in Settings → Connect to Desktop.`
      : reason === 'expired'
        ? `${name} signed this phone out after 90 days without use. Enter the password again in Settings → Connect to Desktop.`
        : `${name} refused this sign-in.`;
const KEY_REFUSALS = new Set(['revoked', 'expired', 'unknown', 'invalid-credentials', 'retired']);

type Trouble = Exclude<SignInFailure['kind'], 'refused'>;

/** Plain words for a sign-in that did not finish. Each says only what the failure proves. */
export function troubleText(kind: Trouble): string {
  switch (kind) {
    case 'unreachable': return "Can't reach your computer.";
    default: return 'Your computer closed the connection before sign-in finished.';
  }
}

/** Minimal login screen for remote browser access. */
function LoginScreen({ onLogin, notice }: { onLogin: (password: string) => Promise<void>; notice?: Notice | null }) {
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
      // Each says only what the answer proves (review of the 2026-09-11 fixes, finding 10).
      setError(
        failure?.kind === 'refused'
          ? failure.reason === 'no-password-configured'
            ? 'This computer has no remote access password yet. Set one on the computer itself, in Settings → Remote access.'
            : failure.reason === 'invalid-credentials'
              ? 'Invalid password'
              // WHY (security audit RA-1): the computer now pauses password tries after repeated wrong ones.
              : failure.reason === 'too-many-attempts'
                ? 'Too many wrong passwords. Wait a few minutes and try again.'
                : 'Your computer refused this sign-in.'
          : failure
            ? troubleText(failure.kind)
            : "Couldn't sign in."
      );
      setLoading(false);
    }
  };

  if (notice?.kind === 'reload') {
    // WHY no password box (P-5): a password can't fix a page that is older than its computer, or bring back a tab another
    // tab took over; only a reload does, so the card carries that one button and nothing to type.
    return (
      <GateShell>
        <GateCard heading={notice.heading} line={notice.line} role="status">
          <GateButton main type="button" onClick={() => window.location.reload()}>Reload this tab</GateButton>
        </GateCard>
      </GateShell>
    );
  }

  if (needsSetup) {
    // No password on the host: there is nothing to type, so nothing is offered to type
    // into. The one thing that moves this forward happens on the other computer.
    return (
      <GateShell>
        <GateCard
          heading="No password set yet"
          line="On the computer itself, open Settings → Remote access and set a password. Then reload this page."
        />
      </GateShell>
    );
  }

  return (
    <GateShell>
      <form onSubmit={handleSubmit} className="brand-card w-full p-6 flex flex-col gap-4">
        <div className="text-center">
          <h2 className="brand-heading text-xl text-fg">Connect to your computer</h2>
          <p className="mt-1 text-sm text-fg-dim" role={notice ? 'status' : undefined}>
            {notice?.line ?? 'Enter the password you set for remote access.'}
          </p>
        </div>
        {/* The guide's text box: its name above it, its error under it (Text and numbers). */}
        <div className="flex flex-col gap-2">
          <label htmlFor="remote-password" className="text-xs font-medium text-fg-dim">Password</label>
          <TextInput
            id="remote-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            disabled={loading}
          />
          {/* WHY FieldError (guide: no red/coloured body text for messages) */}
          {error && <FieldError as="p" size="2xs">{error}</FieldError>}
        </div>
        <GateButton main type="submit" disabled={loading}>{loading ? 'Connecting…' : 'Connect'}</GateButton>
      </form>
    </GateShell>
  );
}

/** Connecting with nothing to decide: the heading with the app's spinner beside it, as setup's busy steps show. */
function GateConnecting({ label }: { label: string }) {
  return (
    <GateShell>
      <h1 className="brand-heading text-2xl text-fg inline-flex items-center gap-3" role="status">
        <BrailleSpinner size="lg" />
        {label}
      </h1>
    </GateShell>
  );
}

/** The saved key is signing in, or trying to. No password box: none is needed yet. Also the Android
 *  app's way back to the computer it was last using (`computerName` set, the way out is the phone). */
function SavedKeyScreen({ trouble, attempting, onTryNow, onPassword, computerName, otherLabel = 'Enter password instead' }: {
  trouble: Trouble | null;
  /** "Try now" was pressed and that attempt has not finished (review finding 7). */
  attempting: boolean;
  onTryNow: () => void;
  onPassword: () => void;
  /** The saved computer's own name, when the Android app is going back to it. */
  computerName?: string;
  otherLabel?: string;
}) {
  if (!trouble) return <GateConnecting label={computerName ? `Connecting to ${computerName}…` : 'Connecting to your computer…'} />;
  const heading = attempting ? 'Trying to connect…' : computerName ? `Can't reach ${computerName}` : troubleText(trouble).replace(/\.$/, '');
  return (
    <GateShell>
      <GateCard heading={heading} line="It keeps trying by itself every few seconds." role="status">
        {/* WHY "Try again" (was "Try now"): the guide names every retry button exactly that. Filled on top, the way out
            outlined under it (Buttons → two buttons, stacked); the way out was a borderless line before (P-4). */}
        <GateButton main onClick={onTryNow} disabled={attempting}>Try again</GateButton>
        {/* The way out when the computer is gone for good, or this browser should pair
            again. The saved key is kept: a reload tries it once more. */}
        <GateButton onClick={onPassword}>{otherLabel}</GateButton>
      </GateCard>
    </GateShell>
  );
}

/** A computer the Android app can go back to: the saved row from the phone's own list, password included. */
interface SavedComputer { name: string; host: string; port: number; password: string }

/** How long the Android app waits before trying its computer again, by attempt. The last value repeats. */
const COMPUTER_RETRY_MS = [5_000, 10_000, 20_000, 30_000];

/** The saved computer the app was last using, if it is still in the phone's list. Never throws. */
async function findLastComputer(): Promise<SavedComputer | null> {
  const { lastComputer } = await import('./last-computer');
  const last = lastComputer();
  if (!last) return null;
  try {
    const reply = await (window as any).claude?.android?.getPairedDevices?.();
    const list: SavedComputer[] = reply?.devices ?? reply ?? [];
    return list.find((d) => d.host === last.host && d.port === last.port) ?? null;
  } catch {
    return null;
  }
}

/** How long a saved-key sign-in shows only the spinner before it says what it is doing. */
const CONNECTING_WORDS_AFTER_MS = 1500;

/**
 * The page's own boot spinner (index.html), drawn by React. WHY (Destin, 2026-09-11: "still flashes
 * the password screen at me on refresh"): the "YouCoded Remote" titled screen, shown for the second a
 * saved key takes, read as the password screen. A normal refresh now looks like one continuous load.
 * Not id="boot": dev-mount-probe.ts reads that element's absence as "React mounted".
 */
function BootSpinner({ label }: { label: string }) {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return (
    <div className="fixed inset-0 flex items-center justify-center" role="status" aria-label={label}>
      <div
        style={{
          width: 28, height: 28, borderRadius: '50%',
          border: '2px solid rgba(255, 255, 255, 0.15)', borderTopColor: 'rgba(255, 255, 255, 0.7)',
          animation: reduced ? 'none' : 'boot-spin 0.7s linear infinite',
        }}
      />
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
  const [attempting, setAttempting] = useState(false);
  // Why the password box is back, when the computer stopped accepting this device.
  const [notice, setNotice] = useState<Notice | null>(null);
  // A saved-key sign-in still going after CONNECTING_WORDS_AFTER_MS.
  const [slow, setSlow] = useState(false);
  // Android only: going back to the computer the app was last using. 'pending' until the phone's
  // own runtime has answered and the saved list was read; then the computer being tried, or 'none'.
  // WHY the app waits here (2026-10-22 phone reliability, cause 1 + review item 9): mounting the app
  // on the phone's own runtime first would show the phone's conversations for seconds and let a
  // message go to the wrong place before the switch.
  const [resume, setResume] = useState<'pending' | 'none' | SavedComputer>(isAndroid ? 'pending' : 'none');
  const [computerTrouble, setComputerTrouble] = useState(false);
  const [computerAttempting, setComputerAttempting] = useState(false);
  const computerRetry = useRef<{ timer: ReturnType<typeof setTimeout> | null; n: number; cancelled: boolean }>({ timer: null, n: 0, cancelled: false });

  const tryComputer = useCallback(async (s: RemoteGateShim, c: SavedComputer) => {
    const r = computerRetry.current;
    if (r.timer) { clearTimeout(r.timer); r.timer = null; }
    setComputerAttempting(true);
    try {
      await s.connectToHost(c.host, c.port, c.password);
      // "Use this phone only" was pressed while this attempt was still going: honour it.
      if (r.cancelled) { await s.disconnectFromHost().catch(() => {}); return; }
      setResume('none');
    } catch (err: any) {
      if (r.cancelled) return;
      if (err?.cleartextRefused) {
        // A saved computer at a non-Tailscale address can never connect (2026-10-30 audit A1): retrying forever would only say
        // "can't reach". Open the phone's own runtime and say why, in the same words the pairing form uses.
        setResume('none');
        const { announce } = await import('./utils/announce');
        window.setTimeout(() => announce(String(err.message), 8000), 1500);
        return;
      }
      if (err?.signInFailure?.kind === 'refused') {
        // A changed password will not fix itself: open the phone's own runtime and say where to fix it.
        setResume('none');
        const { announce } = await import('./utils/announce');
        // After the app has mounted its toast.
        window.setTimeout(() => announce(savedPasswordRefusedNotice(c.name, String(err.signInFailure.reason)), 8000), 1500);
        return;
      }
      setComputerTrouble(true);
      const delay = COMPUTER_RETRY_MS[Math.min(r.n++, COMPUTER_RETRY_MS.length - 1)];
      r.timer = setTimeout(() => { void tryComputer(s, c); }, delay);
    } finally {
      setComputerAttempting(false);
    }
  }, []);

  const choosePhoneOnly = useCallback(async () => {
    const r = computerRetry.current;
    r.cancelled = true;
    if (r.timer) { clearTimeout(r.timer); r.timer = null; }
    const { forgetLastComputer } = await import('./last-computer');
    forgetLastComputer();
    setResume('none');
  }, []);

  useEffect(() => () => { const t = computerRetry.current.timer; if (t) clearTimeout(t); }, []);

  // The phone's own runtime answered: is there a computer to go back to?
  useEffect(() => {
    if (!isAndroid || !shim || !connected || resume !== 'pending') return;
    void findLastComputer().then((c) => {
      if (!c) { setResume('none'); return; }
      setResume(c);
      void tryComputer(shim, c);
    });
  }, [isAndroid, shim, connected, resume, tryComputer]);
  useEffect(() => {
    if (savedKey !== 'connecting') { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), CONNECTING_WORDS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [savedKey]);

  useEffect(() => {
    void loadShim().then((s) => {
      s.installShim();
      s.onConnectionStateChange((state) => {
        const isConnected = state === 'connected';
        setConnected(isConnected);
        if (isConnected) setHasConnectedOnce(true);
      });
      // The computer stopped accepting this device after it had connected (unpaired, or a password
      // change retired its key). WHY leave the app (review of the 2026-09-11 fixes, finding 4): it
      // stayed on screen saying "Reconnecting" with no way to type the password. The Android app
      // goes back to its own runtime by itself, so there is nothing to show there.
      s.onCredentialRefused((reason) => {
        if (isAndroid) return;
        setConnected(false);
        setHasConnectedOnce(false);
        setSavedKey('none');
        setNotice(reason === 'replaced' ? OTHER_TAB_NOTICE : reason === 'unsupported-version' ? OLD_PAGE_NOTICE : reason === 'expired' ? DEVICE_EXPIRED_NOTICE : KEY_REFUSALS.has(reason) ? KEY_REFUSED_NOTICE : null);
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
      const started = s.startSavedKeySignIn((e) => {
        setAttempting(false);
        setSavedKey(e.type === 'refused' ? 'none' : e.kind);
        // The saved key was timed out at page load: say why before asking for the password.
        if (e.type === 'refused' && e.reason === 'expired') setNotice(DEVICE_EXPIRED_NOTICE);
      });
      setSavedKey(started ? 'connecting' : 'none');
    });
    // Once, for the page's life: the shim is a module-level singleton.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogin = useCallback(async (password: string) => {
    if (!shim) return;
    await shim.connect(password);
  }, [shim]);

  // Android: going back to the last computer, before the app shows anything.
  if (isAndroid && shim && typeof resume === 'object') {
    return (
      <SavedKeyScreen
        trouble={computerTrouble ? 'unreachable' : null}
        attempting={computerAttempting && computerTrouble}
        computerName={resume.name}
        otherLabel="Use this phone only"
        onTryNow={() => { void tryComputer(shim, resume); }}
        onPassword={() => { void choosePhoneOnly(); }}
      />
    );
  }

  // Once connected, keep showing the app even during transient disconnections.
  if ((connected || hasConnectedOnce) && resume === 'none') return <>{renderApp()}</>;

  if (!shim || savedKey === 'pending') return <BootSpinner label="Loading YouCoded" />;

  // Android always auto-connects to local bridge — never show the password screen.
  // Fix: wait for connection/auth to complete BEFORE mounting App. IPC calls made during the
  // pre-auth window (theme:list, skills:list, etc.) are dropped by LocalBridgeServer's
  // unauthenticated-client guard (LocalBridgeServer.kt:116), then time out silently after 30s.
  if (isAndroid) {
    return <GateConnecting label="Starting YouCoded…" />;
  }

  if (savedKey === 'connecting' && !slow) return <BootSpinner label="Connecting to your computer" />;

  if (savedKey !== 'none') {
    return (
      <SavedKeyScreen
        trouble={savedKey === 'connecting' ? null : savedKey}
        attempting={attempting}
        onTryNow={() => { setAttempting(true); shim.retrySavedKeyNow(); }}
        onPassword={() => { shim.stopSavedKeySignIn(); setSavedKey('none'); }}
      />
    );
  }

  return <LoginScreen onLogin={handleLogin} notice={notice} />;
}
