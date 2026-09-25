// Photo-only build support for `shoot` (scripts/shoot/): named screens open
// directly, with no click path to go stale.
//
// WHY a build-time define and not a URL flag: the "open me" openers and the
// screen marks must exist ONLY in the photo-only build (`VITE_SHOOT=1`, see
// vite.config.ts). The real app must not carry them, and the landing page's
// live demo (VITE_WORKBENCH=1 without VITE_SHOOT) must not either, or a
// stranger on the website could drive them. `__SHOOT__` is replaced by a
// literal at every use site, so every branch below folds to dead code in
// those two builds. Guard: tests/shoot-build-guard.test.ts builds both and
// fails on any trace of this module's globals.
//
// Spec: docs/active/specs/2026-09-24-shoot-and-explore.md (workspace repo).
import { useEffect, useRef } from 'react';

declare const __SHOOT__: boolean;

/** Opens a screen. `sub` is the last segment when the screen was registered with sub-pages. */
type Opener = (sub?: string) => void;

const openers = new Map<string, Opener>();

/**
 * Registers how to open a screen by name, e.g. `settings/sound`. A no-op
 * outside the photo-only build. `subpages` also registers `<name>/<sub>` for
 * each entry, opening through the same function with `sub` set.
 *
 * Call it unconditionally at the top of the component, like any hook: the
 * early return is a build-time constant, so the hook order never changes
 * within one build.
 */
export function useScreenOpen(name: string, open: Opener, subpages?: readonly string[]): void {
  if (!(typeof __SHOOT__ !== 'undefined' && __SHOOT__)) return;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- guarded by a build-time constant, see above
  const ref = useRef(open);
  ref.current = open;
  const subKey = subpages?.join(',') ?? '';
  // eslint-disable-next-line react-hooks/rules-of-hooks -- guarded by a build-time constant, see above
  useEffect(() => {
    const names = [name, ...(subKey ? subKey.split(',').map((s) => `${name}/${s}`) : [])];
    names.forEach((n, i) => openers.set(n, (sub) => ref.current(i === 0 ? sub : names[i].slice(name.length + 1))));
    return () => names.forEach((n) => openers.delete(n));
  }, [name, subKey]);
}

/**
 * Marks the visible surface of a screen so `shoot` can prove the screen is
 * showing. Put it inside the screen's own panel; `shoot` checks the nearest
 * dialog / layer surface around it is on screen and not covered. Renders
 * nothing outside the photo-only build.
 */
export function ScreenMark({ name }: { name: string }) {
  if (!(typeof __SHOOT__ !== 'undefined' && __SHOOT__)) return null;
  return <span data-screen={name} hidden />;
}

/** Installed only by the photo-only boot (index.tsx). `shoot` drives it over CDP. */
export function installScreenDriver(screens: readonly { name: string }[]): void {
  if (!(typeof __SHOOT__ !== 'undefined' && __SHOOT__)) return;
  const known = screens.map((s) => s.name);
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const waitFor = async (n: string, ms: number) => {
    for (const t0 = performance.now(); performance.now() - t0 < ms; await frame()) if (openers.has(n)) return openers.get(n)!;
    return null;
  };
  (window as any).__youcodedScreens = {
    // The whole list, with tags / scenario / params, so the CLI never keeps a copy.
    list: () => screens,
    registered: () => [...openers.keys()],
    // Opens every KNOWN prefix of `name` in order (settings → settings/assistant →
    // settings/assistant/cloud). A prefix that is a known screen must register an
    // opener within 3 s of its parent opening, or the open fails with its name.
    async open(name: string): Promise<{ ok: true } | { ok: false; reason: string }> {
      if (!known.includes(name)) return { ok: false, reason: `not in the screen list: ${name}` };
      const parts = name.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join('/');
        if (!known.includes(p)) continue;
        const open = await waitFor(p, 3000);
        if (!open) return { ok: false, reason: `no opener registered for ${p} (is its component mounted?)` };
        open();
        await frame();
      }
      return { ok: true };
    },
  };
}
