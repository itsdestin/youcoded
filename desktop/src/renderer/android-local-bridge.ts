// The Android app's two lines to this page, as the remote shim reaches them.
// Its own module so remote-shim.ts stays inside its line budget; only the shim imports it.
//
// WHY two lines (2026-10-14, Android clean rebuild P1): the phone now runs the desktop's own backend
// (a Node process inside the app), and the page talks to it over the same socket protocol a remote
// browser uses — `localBridgeUrl()`. What only the PHONE can do (voice typing with Android's speech
// recognizer, the saved-computers list, the QR scanner, the app version) never was the backend's
// business, so it goes straight to the Android app through the `YouCodedHost` object the app's
// WebView injects — `invokeAndroidHost()`. That line works whether the socket points at the phone's
// own backend or at a paired computer, which is why the old side-connection to the local bridge is gone.

/** The backend's address. Port comes from the `bridgePort` query param the app injects. */
export function localBridgeUrl(): string {
  const port = new URLSearchParams(location.search).get('bridgePort') || '9901';
  return `ws://localhost:${port}`;
}

/** What the Android app injects (addJavascriptInterface): one async call in, answers come back through
 *  `window.__youcodedHost.reply`, and the app's own pushes (voice words) through `.event`. */
interface YouCodedHostObject {
  invoke(id: string, type: string, payloadJson: string, token: string): void;
}

type HostPending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
const hostPending = new Map<string, HostPending>();
let hostCounter = 0;
let hostEventSink: ((type: string, payload: unknown) => void) | null = null;
/** QR scanning and a first speech-model check can take a person a while; a dead host cannot. */
const HOST_TIMEOUT_MS = 120_000;

function hostObject(): YouCodedHostObject | null {
  const h = (window as unknown as { YouCodedHost?: YouCodedHostObject }).YouCodedHost;
  return h && typeof h.invoke === 'function' ? h : null;
}

/** True inside the Android app (the WebView has the host object), false in any browser. */
export function hasAndroidHost(): boolean {
  return hostObject() !== null;
}

/** Ask the Android app one question. Rejects when there is no app (a browser) or it does not answer. */
export function invokeAndroidHost(type: string, payload?: unknown): Promise<any> {
  const host = hostObject();
  if (!host) return Promise.reject(new Error('This is only available in the Android app.'));
  const id = `host-${Date.now()}-${++hostCounter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { hostPending.delete(id); reject(new Error('The phone did not answer.')); }, HOST_TIMEOUT_MS);
    hostPending.set(id, { resolve, reject, timer });
    try {
      // WHY the token (independent review, 2026-10-15): Android hands this object to EVERY frame in the WebView,
      // including a previewed HTML file or a Page in an iframe. Only the app's own page knows this run's token
      // (its own query string), so the app answers only calls that carry it.
      const token = new URLSearchParams(location.search).get('bridgeToken') ?? '';
      host.invoke(id, type, JSON.stringify(payload ?? null), token);
    } catch (e) {
      clearTimeout(timer); hostPending.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Where the app's own pushes go (the shim's dispatchEvent). Set once by the shim, which also installs
 *  the receiver the app calls (not at import: tests import this module with no window). */
export function setAndroidHostEventSink(sink: (type: string, payload: unknown) => void): void {
  hostEventSink = sink;
  // The app calls these with evaluateJavascript. Payloads arrive as JSON text so nothing the app sends
  // is ever evaluated as code.
  (window as unknown as { __youcodedHost: unknown }).__youcodedHost = hostReceiver;
}

const hostReceiver = {
  reply(id: string, json: string, error?: string): void {
    const p = hostPending.get(id);
    if (!p) return;
    hostPending.delete(id);
    clearTimeout(p.timer);
    if (error) { p.reject(new Error(error)); return; }
    try { p.resolve(json ? JSON.parse(json) : undefined); } catch { p.resolve(undefined); }
  },
  event(type: string, json: string): void {
    let payload: unknown;
    try { payload = json ? JSON.parse(json) : undefined; } catch { return; }
    hostEventSink?.(type, payload);
  },
};
