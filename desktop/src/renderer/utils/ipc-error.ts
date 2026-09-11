// Turning a rejected bridge call into a sentence a non-developer can read.
//
// Both transports wrap the real message in machinery before it reaches a
// component's error line, and every wrapped message is unreadable in a
// different way:
//
//   Electron IPC:  Error invoking remote method 'models:set-settings':
//                  Error: error: invalid argument: --gpu-layers 99x
//   remote/phone:  remote-unsupported: models:settings
//
// The first hides the engine's own words — which is what the settings dialog is
// required to show VERBATIM, because only the engine binary knows which option
// it refused — behind forty characters a user has to read past. The second is a
// channel name, which means nothing to anyone.
//
// WHY this lives here rather than in EngineCard.tsx, where it started: a copy
// per component is how three call sites shipped without it. One import, one
// behaviour, and the guard in tests/ipc-error.test.ts breaks if either wrapper
// stops being stripped.
import { remoteUnsupportedMessage } from '../remote-unsupported';
import { isAndroid, isRemoteMode } from '../platform';

const ELECTRON_WRAPPER = /^Error invoking remote method '[^']*':\s*(Error:\s*)?/;
const REMOTE_UNSUPPORTED = /^remote-unsupported:\s*(\S+)$/;

/** The phone on its own bridge, not paired to a desktop. `window` is checked
 *  first because this helper is pure and its test runs without a DOM. */
function onPhone(): boolean {
  return typeof window !== 'undefined' && isAndroid() && !isRemoteMode();
}

/** Remove ONLY Electron's "Error invoking remote method '<channel>': Error: " prefix,
 *  leaving the handler's own text exactly as it was — for callers that read a code
 *  out of that text rather than show it.
 *
 *  WHY separate from plainMessage (error inventory 2026-09-10, false message 17):
 *  plainMessage also rewrites `remote-unsupported: <channel>` into a sentence, which
 *  is right on screen and wrong for UpdatePanel, whose retry decision needs that code.
 *  UpdatePanel had parsed the raw text instead, so desktop's prefix hid every code.
 *  One regex behind both, so they cannot disagree about what the wrapper is. */
export function stripInvokeWrapper(text: string): string {
  return text.replace(ELECTRON_WRAPPER, '');
}

/** The user-facing sentence inside a rejected `window.claude.*` call.
 *  `fallback` is used when the failure carries no message of its own — never
 *  guess a cause there; say only what is certainly true. */
export function plainMessage(e: unknown, fallback = 'Something went wrong.'): string {
  // Only a real string counts. `String(e)` on anything else yields
  // "[object Object]", and putting that on screen is worse than the fallback —
  // it tells the user nothing and looks like a crash.
  const raw = (e as { message?: unknown } | null | undefined)?.message;
  const text = (typeof raw === 'string' ? raw : typeof e === 'string' ? e : '').trim();
  if (!text) return fallback;
  const unsupported = REMOTE_UNSUPPORTED.exec(text);
  // A phone on its own bridge (not paired to a desktop) is the 'phone' host;
  // the same wrapper reaches here from either transport.
  if (unsupported) return remoteUnsupportedMessage(unsupported[1], onPhone() ? 'phone' : 'remote');
  return text.replace(ELECTRON_WRAPPER, '') || fallback;
}
