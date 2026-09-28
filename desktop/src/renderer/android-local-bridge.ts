// The Android app's own on-device bridge (LocalBridgeServer.kt), as the remote shim reaches it.
// Its own module so remote-shim.ts stays inside its line budget; only the shim imports it.

/** The bridge's address. Port comes from the `bridgePort` query param WebViewHost.kt injects
 *  so dev (9951) and release (9901) APKs can run side by side; 9901 keeps the legacy wiring
 *  working if a host forgets to inject it. */
export function localBridgeUrl(): string {
  const port = new URLSearchParams(location.search).get('bridgePort') || '9901';
  return `ws://localhost:${port}`;
}

let requestCounter = 0;

/**
 * Ask the Android app's own runtime one question while the app is paired to a computer.
 *
 * WHY: pairing points the app's ONE connection at the computer, but the list of saved
 * computers (address + password) lives in the phone's runtime, which the computer cannot
 * reach. The android.* pairing methods used to answer "done" without asking anyone, so
 * removing a computer while connected left its saved pairing — still trusted — on the phone.
 * A short second connection to the local bridge (same token the page loaded with) asks the
 * runtime itself and closes; the connection to the computer is never touched.
 */
export function invokeLocalBridge(type: string, payload?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const token = new URLSearchParams(location.search).get('bridgeToken') ?? '';
    const id = `local-${Date.now()}-${++requestCounter}`;
    const socket = new WebSocket(localBridgeUrl());
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('The phone did not answer.'))), 10_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token }));
    socket.onmessage = (event) => {
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'auth:ok') { socket.send(JSON.stringify({ type, id, payload })); return; }
      if (msg.type === `${type}:response` && msg.id === id) finish(() => resolve(msg.payload));
    };
    socket.onerror = () => finish(() => reject(new Error('Could not reach the phone’s own runtime.')));
    socket.onclose = () => finish(() => reject(new Error('Could not reach the phone’s own runtime.')));
  });
}
