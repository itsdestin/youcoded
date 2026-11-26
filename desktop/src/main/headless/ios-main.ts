// ios-main.ts — entry point of the backend inside the iPhone app.
//
// WHY its own entry (2026-11-25, iPhone app, card #89): the iPhone runs the same headless backend as the Android
// app (headless-main.ts → headless-boot.ts), but on nodejs-mobile's Node 18 with no JIT, started in-process by the
// Swift shell (ios/YouCoded/NodeRunner.swift) from ONE bundled file (ios/runtime/build-backend.mjs). The gaps that
// Node leaves must be filled before any backend module loads — imports are hoisted, so the backend is `require`d
// only after the fills are in.
import { installIosCompat, installInProcessGuards } from './ios-compat';

installIosCompat();
installInProcessGuards();
// eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the fills on purpose
require('./headless-main');
