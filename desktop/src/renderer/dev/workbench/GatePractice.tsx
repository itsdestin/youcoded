// The screens a phone shows BEFORE the app (`shoot dev/gate#…`): the Android app going back to its computer, and the browser
// page's "another tab took over" notice. WHY (phone-reliability review deck, 2026-10-22): the workbench renders <App/> directly, so
// these never had a picture. This mounts the REAL <RemoteGate> over a pretend connection, beside the app, in the photo-only build
// only (index.tsx) — like the icon sheet. Never ships. Nothing here connects anywhere: every "computer" is a fake in this file.
import { useEffect, useState } from 'react';
import { RemoteGate, type RemoteGateShim } from '../../remote-gate';
import { rememberLastComputer, forgetLastComputer } from '../../last-computer';
import { useScreenOpen, ScreenMark } from '../../shoot-mode';

type Gate = 'connecting' | 'unreachable' | 'tab';

/** A pretend shim: just enough for the gate to reach the state being photographed. */
function fakeShim(gate: Gate): RemoteGateShim {
  let tried = 0;
  return {
    installShim() {},
    async connect() { return 'android-local'; },
    // The phone's own runtime "connects" at once, which is what the Android gate waits for before it tries its computer.
    onConnectionStateChange(cb) { if (gate !== 'tab') setTimeout(() => cb('connected' as never), 0); },
    retryLocalBridge() {},
    startSavedKeySignIn() { return false; },
    retrySavedKeyNow() {},
    stopSavedKeySignIn() {},
    // The browser page: the computer closed this tab's connection because another tab of the same browser signed in.
    onCredentialRefused(cb) { if (gate === 'tab') setTimeout(() => cb('replaced'), 0); },
    // 'connecting' never finishes; 'unreachable' fails once and then waits, so the picture is not the "Trying to connect…" beat.
    connectToHost() {
      if (gate === 'unreachable' && tried++ === 0) return Promise.reject(new Error('no route to host'));
      return new Promise<void>(() => {});
    },
    async disconnectFromHost() {},
  };
}

export default function GatePractice() {
  const [gate, setGate] = useState<Gate | null>(null);
  useScreenOpen('dev/gate', () => {
    const g = new URLSearchParams(location.search).get('gate');
    const next = (g === 'unreachable' || g === 'tab' ? g : 'connecting') as Gate;
    // The saved computer the Android gate goes back to, and the phone's saved list that holds its name.
    if (next !== 'tab') {
      rememberLastComputer('home-pc.example.invalid', 7842);
      try {
        (window as any).claude.android = { getPairedDevices: async () => ({ devices: [{ name: 'Home PC', host: 'home-pc.example.invalid', port: 7842, password: 'practice' }] }) };
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
  return (
    <div className="fixed inset-0 bg-panel text-fg" style={{ zIndex: 100000 }} role="dialog" aria-label="Phone start-up screen">
      <ScreenMark name="dev/gate" />
      <RemoteGate isAndroid={gate !== 'tab'} loadShim={async () => shim} renderApp={() => null} />
    </div>
  );
}
