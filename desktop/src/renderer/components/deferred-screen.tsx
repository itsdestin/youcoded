// deferred-screen.tsx — a screen whose code loads apart from the app's startup code (2026-10-22 phone speed).
//
// WHY not React.lazy: these screens are mounted all the time (closed) so they keep their state, and React.lazy would
// load them on that first, closed render — the very download this exists to move. A deferred screen renders nothing
// until `load` is true (the screen is opened, or state/screens-ready.ts says the phone has drawn its conversation), then
// loads its code once and stays. A failed load (a phone offline) is tried again the next time `load` turns true, instead
// of being remembered as React.lazy would, so a screen is never lost for the rest of the session.
import { useEffect, useState, type ComponentType } from 'react';

export type DeferredScreen<P> = ComponentType<P & { load: boolean }> & { preload(): void };

export function deferredScreen<P extends object>(importScreen: () => Promise<ComponentType<P>>): DeferredScreen<P> {
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  const fetchScreen = () => (loading ??= importScreen().then(
    (screen) => (loaded = screen),
    (err) => { loading = null; throw err; },
  ));

  function Deferred(props: P & { load: boolean }) {
    const { load, ...rest } = props;
    const [Screen, setScreen] = useState<ComponentType<P> | null>(() => loaded);
    useEffect(() => {
      if (Screen || !load) return;
      let live = true;
      fetchScreen().then((screen) => { if (live) setScreen(() => screen); }, (err) => console.warn('[deferred-screen] could not load', err));
      return () => { live = false; };
    }, [Screen, load]);
    return Screen ? <Screen {...(rest as P)} /> : null;
  }
  return Object.assign(Deferred, { preload: () => { fetchScreen().catch(() => { /* tried again when opened */ }); } });
}
