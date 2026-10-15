// remote-local.ts — the socket door's local mode, used by the Android app's own backend.
//
// WHY (2026-10-14, Android clean rebuild P1): the Android app runs this backend headless
// (headless/headless-boot.ts) and its WebView is the only screen. In local mode the door listens on
// 127.0.0.1 only, needs no Tailscale or password, and signs in exactly one kind of client: one presenting
// the token the app generated for this run. That client is the backend's OWNER, so the channel table
// treats it like a window (serveRemoteChannel's `owner`), and the window-door services a handler may
// reach for point at the sockets instead.
import { timingSafeEqual } from 'crypto';
import type { DesktopServices } from './ipc/channel-def';

export interface LocalModeOptions { port: number; token: string }

/** True only for this run's token, compared in constant time. */
export function localTokenMatches(given: unknown, want: string): boolean {
  const a = Buffer.from(typeof given === 'string' ? given : '');
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What a window would get, for the owner's page: every "tell the windows/phones" goes to the sockets. */
export function ownerDesktopServices(o: {
  broadcast: (message: { type: string; payload: unknown }) => void;
  sessionRoots: () => string[];
  sessionManager: DesktopServices['sessionManager'];
}): DesktopServices {
  return {
    sendToWindows: (channel, payload) => o.broadcast({ type: channel, payload }),
    sendToPhones: (message) => o.broadcast(message),
    sessionRoots: o.sessionRoots,
    sessionManager: o.sessionManager,
  };
}
