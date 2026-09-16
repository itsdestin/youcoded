// Renderer-side platform detection. Wraps window.claude.getPlatform() and
// caches the result in module scope since platform never changes over a
// session. Components call useCurrentPlatform(); initial render returns
// null, the effect resolves + re-renders with the real value on next tick.

import { useEffect, useState } from 'react';
import { useOnRemoteReconnect } from '../hooks/useOnRemoteReconnect';

export type Platform = 'darwin' | 'win32' | 'linux' | 'android';

let cached: Platform | null = null;
let inflight: Promise<Platform> | null = null;

async function fetchPlatform(): Promise<Platform> {
  if (cached) return cached;
  if (inflight) return inflight;
  const w = window as any;
  if (!w.claude?.getPlatform) {
    // Defensive fallback for older shims — detect Android via file: protocol.
    const fallback: Platform = location.protocol === 'file:' ? 'android' : 'linux';
    cached = fallback;
    return fallback;
  }
  const promise: Promise<Platform> = w.claude.getPlatform().then((p: Platform) => {
    cached = p;
    inflight = null;
    return p;
  }, (err: unknown) => {
    // A failed read must not be the answer for the page's life: the rejected promise used to
    // stay in `inflight`, so every later call got the same failure (2026-09-11 phone pass sweep).
    inflight = null;
    throw err;
  });
  inflight = promise;
  return promise;
}

export function useCurrentPlatform(): Platform | null {
  const [platform, setPlatform] = useState<Platform | null>(cached);
  useEffect(() => {
    if (cached) { setPlatform(cached); return; }
    let active = true;
    fetchPlatform().then((p) => { if (active) setPlatform(p); }).catch(() => { /* unknown until a retry */ });
    return () => { active = false; };
  }, []);
  // Still unknown after a remote reconnect: ask again. Unmounting removes the listener.
  useOnRemoteReconnect(() => {
    if (cached) return;
    fetchPlatform().then(setPlatform).catch(() => { /* still unknown */ });
  });
  return platform;
}
