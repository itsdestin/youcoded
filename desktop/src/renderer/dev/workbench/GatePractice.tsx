// The screens a phone shows BEFORE the app (`shoot dev/gate#…`): the Android app going back to its computer, and the browser
// page's "another tab took over" notice. WHY (phone-reliability review deck, 2026-10-22): the workbench renders <App/> directly, so
// these never had a picture. This mounts the REAL <RemoteGate> over a pretend connection, beside the app, in the photo-only build
// only (index.tsx) — like the icon sheet. Never ships. Nothing here connects anywhere: every "computer" is a fake in this file.
import { useEffect, useState } from 'react';
import { RemoteGate, type RemoteGateShim } from '../../remote-gate';
import { rememberLastComputer, forgetLastComputer } from '../../last-computer';
import { useScreenOpen, ScreenMark } from '../../shoot-mode';
import { TAILSCALE_ONLY_MESSAGE } from '../../../shared/cleartext-hosts';

// 'login': the browser page's password screen, with no saved key and nothing refused.
// The next three are that same screen after the computer said no (WHY, release comparison 2026-11-07: the words for these
// answers are new or changed and no picture reached them): 'login-too-many' and 'login-refused' are a password typed and answered
// with a refusal (the entry types it and presses Connect), 'login-expired' is a saved sign-in the computer timed out after 90 days.
// 'tailscale': the Android app going back to a saved computer whose address is not a Tailscale one; it never connects and says why.
type Gate = 'connecting' | 'unreachable' | 'tab' | 'login' | 'login-too-many' | 'login-refused' | 'login-expired' | 'tailscale';
const isLogin = (g: Gate) => g === 'login' || g.startsWith('login-');
const GATES: readonly Gate[] = ['connecting', 'unreachable', 'tab', 'login', 'login-too-many', 'login-refused', 'login-expired', 'tailscale'];

/** What a refused sign-in rejects with in the real shim (remote-shim.ts signInError): the reason rides on `signInFailure`. */
const refusal = (reason: string) => Object.assign(new Error('Authentication failed'), { signInFailure: { kind: 'refused', reason } });

/** A pretend shim: just enough for the gate to reach the state being photographed. */
function fakeShim(gate: Gate): RemoteGateShim {
  return {
    installShim() {},
    async connect() {
      // The password box's Connect: the computer answers with the refusal this gate is photographing.
      if (gate === 'login-too-many') throw refusal('too-many-attempts');
      if (gate === 'login-refused') throw refusal('retired');
      return 'android-local';
    },
    // The phone's own runtime "connects" at once, which is what the Android gate waits for before it tries its computer.
    onConnectionStateChange(cb) { if (gate !== 'tab' && !isLogin(gate)) setTimeout(() => cb('connected' as never), 0); },
    retryLocalBridge() {},
    startSavedKeySignIn() { return false; },
    retrySavedKeyNow() {},
    stopSavedKeySignIn() {},
    // The browser page: the computer closed this tab's connection because another tab of the same browser signed in.
    onCredentialRefused(cb) {
      if (gate === 'tab') setTimeout(() => cb('replaced'), 0);
      // A saved sign-in the computer timed out (a device unused for 90 days): the password box says so.
      if (gate === 'login-expired') setTimeout(() => cb('expired'), 0);
    },
    // 'connecting' never finishes; 'unreachable' fails at once every time, so the picture shows the resting card and
    // never the moment a retry is in flight (a slow camera caught the 5 s retry in flight before).
    connectToHost() {
      // The same refusal the real connectToHost gives an address that is not a Tailscale one (it never retries).
      if (gate === 'tailscale') return Promise.reject(Object.assign(new Error(TAILSCALE_ONLY_MESSAGE), { cleartextRefused: true }));
      if (gate === 'unreachable') return Promise.reject(new Error('no route to host'));
      return new Promise<void>(() => {});
    },
    async disconnectFromHost() {},
  };
}

export default function GatePractice() {
  const [gate, setGate] = useState<Gate | null>(null);
  useScreenOpen('dev/gate', () => {
    const g = new URLSearchParams(location.search).get('gate');
    const next = (GATES.includes(g as Gate) ? g : 'connecting') as Gate;
    // The saved computer the Android gate goes back to, and the phone's saved list that holds its name.
    if (next !== 'tab' && !isLogin(next)) {
      // A saved address on the home network (not Tailscale) is what the Tailscale-only refusal is for.
      const host = next === 'tailscale' ? '192.168.1.20' : 'home-pc.example.invalid';
      rememberLastComputer(host, 7842);
      try {
        (window as any).claude.android = { getPairedDevices: async () => ({ devices: [{ name: 'Home PC', host, port: 7842, password: 'practice' }] }) };
      } catch { /* the gate then finds no saved computer and the picture fails its mark check, loudly */ }
    }
    setGate(next);
  });
  useEffect(() => {
    if (!gate) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setGate(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); forgetLastComputer(); };
  }, [gate]);
  const [shim, setShim] = useState<RemoteGateShim | null>(null);
  useEffect(() => { setShim(gate ? fakeShim(gate) : null); }, [gate]);
  if (!gate || !shim) return null;
  // The Tailscale refusal ends in the phone's own app with a notice on top of it (the real gate announces it, and the app's toast
  // draws it), so this state has no cover: a small corner square holds the mark, the gate runs unseen inside it, as ToastPractice does.
  if (gate === 'tailscale') {
    return (
      <div className="fixed left-0 top-0" style={{ width: 12, height: 12, zIndex: 100000 }} role="dialog" aria-label="Phone start-up screen">
        <ScreenMark name="dev/gate" />
        <div style={{ display: 'none' }}><RemoteGate isAndroid loadShim={async () => shim} renderApp={() => null} /></div>
      </div>
    );
  }
  return (
    <div className="fixed inset-0 bg-panel text-fg" style={{ zIndex: 100000 }} role="dialog" aria-label="Phone start-up screen">
      <ScreenMark name="dev/gate" />
      <RemoteGate isAndroid={gate !== 'tab' && !isLogin(gate)} loadShim={async () => shim} renderApp={() => null} />
    </div>
  );
}
