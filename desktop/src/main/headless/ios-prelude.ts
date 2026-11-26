// ios-prelude.ts — loaded before every module of every iPhone bundle (the backend AND each worker thread).
//
// WHY (2026-11-25, iPhone app, card #89): the fills in ios-compat.ts must be in place before ANY module evaluates —
// a library that builds a `\p{…}` regular expression while loading fails the whole bundle otherwise — and a worker
// thread is a separate bundle with its own globals, which the backend's entry (ios-main.ts) never touches. The build
// (ios/runtime/build-backend.mjs) injects this file into every entry, so it always runs first.
import { installIosCompat } from './ios-compat';

installIosCompat();
