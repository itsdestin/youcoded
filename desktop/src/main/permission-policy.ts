// What a page inside the app's windows may ask the computer for (camera, microphone, location, screen, ...).
// Electron answers "yes" to every one of those by default; this answers "no" unless the app really uses it
// (2026-10-30 security audit F4). The only features the app uses: voice input (microphone), copy/paste, and a document
// or video going full-screen.
import { isAppPageUrl } from './app-navigation';

export interface PermissionContext {
  /** Whole-address check for "is this the app's own page" (its index.html or the dev server). */
  isAppPage: (url: string) => boolean;
}

export interface PermissionAsk {
  permission: string;
  /** Address of the page (or frame) asking. */
  requestingUrl: string;
  /** For permission === 'media': what is being asked for ('audio' / 'video'), in either spelling Electron uses. */
  mediaTypes?: readonly string[];
}

/** Permissions the app's own page may use, and the extra ones the Office editor (its own sealed origin) may use. */
const APP_PAGE_ALLOWED = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
const OFFICE_ALLOWED = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);

/** True when the ask should be granted. Everything not listed is refused — including anything a future Electron adds. */
export function isPermissionAllowed(ask: PermissionAsk, ctx: PermissionContext): boolean {
  const appPage = ctx.isAppPage(ask.requestingUrl);
  const office = /^office:\/\//i.test(ask.requestingUrl);
  if (!appPage && !office) return false;           // previews, pages, anything else framed inside the app: never
  if (ask.permission === 'media') {
    // Voice input only: a microphone and nothing else. A request for the camera (or for both) is refused whole.
    if (!appPage) return false;
    const types = ask.mediaTypes ?? [];
    return types.length > 0 ? types.every((t) => t === 'audio') : true;   // no list = a device-name check (microphone labels)
  }
  return (appPage ? APP_PAGE_ALLOWED : OFFICE_ALLOWED).has(ask.permission);
}

interface SessionLike {
  setPermissionRequestHandler(h: ((wc: unknown, permission: string, cb: (granted: boolean) => void, details: any) => void) | null): void;
  setPermissionCheckHandler(h: ((wc: unknown, permission: string, origin: string, details: any) => boolean) | null): void;
}

/** Installs the policy on a session. Refusals are logged once per permission+page so a feature that needed one is findable. */
export function installPermissionPolicy(
  ses: SessionLike,
  opts: { indexHtmlPath: string; devServerUrl: string; log?: (msg: string) => void },
): void {
  const ctx: PermissionContext = { isAppPage: (u) => isAppPageUrl(u, opts.indexHtmlPath, opts.devServerUrl) };
  const seen = new Set<string>();
  const refused = (ask: PermissionAsk): void => {
    const key = `${ask.permission}|${ask.requestingUrl.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    opts.log?.(`refused ${ask.permission} for ${ask.requestingUrl.slice(0, 120)}`);
  };
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const ask: PermissionAsk = { permission, requestingUrl: String(details?.requestingUrl ?? ''), mediaTypes: details?.mediaTypes };
    const ok = isPermissionAllowed(ask, ctx);
    if (!ok) refused(ask);
    callback(ok);
  });
  // The check handler answers "do I already have this?" questions (permissions.query, listing microphone names).
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const ask: PermissionAsk = {
      permission,
      requestingUrl: String(details?.requestingUrl ?? requestingOrigin ?? ''),
      mediaTypes: details?.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : undefined,
    };
    return isPermissionAllowed(ask, ctx);
  });
}
