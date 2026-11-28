// Workbench-only clock: at page load "now" always reads 08:00 local today, and then keeps ticking.
//
// WHY (card #178 follow-up): the made-up chats are dated 07:40 today (fixtures/clock.ts), but labels such
// as "19m ago" and "7:57 AM" under a running helper are measured against the page's real clock, so two
// pictures taken at different hours differed and the before/after comparison tools reported false changes.
// Shifting the clock by one constant makes every such label the same at any hour.
//
// WHY this shape: only `Date.now()` and an argument-less `new Date()` are shifted, by a constant, so
// timers, animations, elapsed counters and `performance.now()` behave exactly as before (a gap between two
// readings is unchanged). `new Date(x)`, `Date.parse`, `Date.UTC` and calling `Date()` as a function keep their
// real behaviour (the function form is shifted too, so its string agrees with the rest).
//
// WHY it can never run in the real app: the whole body sits behind the SAME build-time condition that boots the
// workbench in index.tsx (`DEV || VITE_WORKBENCH === '1'`, folded to false in an app build, so the body is
// dropped) AND the runtime `?mode=workbench` check. This file must be the FIRST import of index.tsx: ES
// modules evaluate in import order, so code that reads the clock while loading sees the shifted one.
// `?realClock=1` turns it off for anyone who needs the real time in a workbench page.
import { fixtureNow } from './fixtures/clock';

// @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
if ((import.meta.env.DEV || import.meta.env.VITE_WORKBENCH === '1') && typeof location !== 'undefined') {
  const q = new URLSearchParams(location.search);
  if (q.get('mode') === 'workbench' && q.get('realClock') !== '1') {
    const RealDate = Date;
    const delta = fixtureNow(RealDate.now()) - RealDate.now();
    const shiftedNow = () => RealDate.now() + delta;
    const ShiftedDate = new Proxy(RealDate, {
      get(target, prop, receiver) {
        if (prop === 'now') return shiftedNow;
        return Reflect.get(target, prop, receiver);
      },
      construct(target, args, newTarget) {
        // Only the no-argument form means "the current moment"; every other form names a moment itself.
        // newTarget is passed through so `class X extends Date {}` and Reflect.construct keep working, and
        // `new Date().constructor === Date` (newTarget is this proxy, whose prototype is the real one).
        return Reflect.construct(target, args.length ? args : [shiftedNow()], newTarget);
      },
      apply(target) {
        return new target(shiftedNow()).toString();
      },
    });
    // Instances share the real prototype, so point its `constructor` at the shifted Date: `new Date().constructor === Date`.
    Object.getPrototypeOf(new RealDate()).constructor = ShiftedDate;
    (globalThis as { Date: DateConstructor }).Date = ShiftedDate;
  }
}
