// signin-loopback.ts — binds a marketplace sign-in to THIS computer.
//
// WHY (security hardening 2026-10-30, card #55): the device-code sign-in could be finished by anyone
// who learned the device code. Now the app opens a one-shot listener on 127.0.0.1 and tells the Worker
// its port; after GitHub approval the Worker sends the browser to http://127.0.0.1:<port>/youcoded-signin?secret=…
// and only an app that received that secret can collect the session. A phone/other computer that merely
// has the code never sees the secret. The secret is never logged.
import http from 'http';
import type { AddressInfo } from 'net';
import { randomInt } from 'crypto';

const SIGNIN_LISTENER_TTL_MS = 15 * 60 * 1000;
const MAX_QUEUED = 50;
const SECRET_RE = /^[0-9a-f]{64}$/;
const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>YouCoded</title><body style="font-family:sans-serif;padding:2em"><p>You can return to YouCoded.</p></body>';

export interface SigninListener {
  port: number;
  /** The next secret a browser delivered that has not been tried yet, else null. */
  take(): string | null;
  /** True once the listener has shut down (time limit or close()). */
  isClosed(): boolean;
  close(): void;
}

/** Start the listener. Loopback only, a random high port. WHY it no longer stops at the first valid-looking secret:
 *  any web page can send this port a made-up 64-character value, and "first one wins" let that block the real
 *  sign-in. Now every well-formed value is queued; the caller tries each against the Worker (which accepts only the
 *  real one) and the listener keeps waiting for the real one until its time limit or close(). */
export async function startSigninListener(ttlMs = SIGNIN_LISTENER_TTL_MS): Promise<SigninListener> {
  const queue: string[] = [];
  let closed = false;
  const server = http.createServer((req, res) => {
    let url: URL | null = null;
    try { url = new URL(req.url ?? '', 'http://127.0.0.1'); } catch { /* falls through to 404 */ }
    const given = url?.searchParams.get('secret') ?? '';
    // Only GET /youcoded-signin?secret=<64 hex> is taken; anything else is a plain 404 and changes nothing.
    if (req.method !== 'GET' || url?.pathname !== '/youcoded-signin' || !SECRET_RE.test(given)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
    }
    // A flood of junk cannot grow memory without bound: past the cap new values are simply ignored.
    if (queue.length < MAX_QUEUED && !queue.includes(given)) queue.push(given);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end(DONE_PAGE);
  });
  const timer = setTimeout(() => close(), ttlMs);
  timer.unref?.();
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }
  // A random port >= 1024; retry a few times if taken.
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = randomInt(20000, 60000);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      return { port: (server.address() as AddressInfo).port, take: () => queue.shift() ?? null, isClosed: () => closed, close };
    } catch (e: any) {
      if (e?.code !== 'EADDRINUSE') { close(); throw e; }
    }
  }
  close();
  throw new Error('Could not open a local port for sign-in.');
}
