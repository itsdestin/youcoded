// capabilities.ts — what a screen can do, written ONCE, read by every screen and by both hosts.
//
// WHY (2026-10-01 one-core R4-1, seam S7): the screens used to ask "am I on Android? am I in remote mode?" and guess
// from the answer what the screen could do (open a file in the computer's own apps, tear a session into a window,
// read the terminal text...). Each guess was written separately at every call site, and a new kind of screen (a phone
// browser, an Android app paired to a computer) meant revisiting every one. Now the HOST says what the screen it serves
// can do, once, in the handshake (`auth:ok`), and the desktop window reads the same object locally from its preload.
// A screen asks `capabilities.openInOs`, never "am I Android".
//
// Keep this file DATA ONLY (no imports, literal values): scripts/generate-preload-channels.mjs copies
// PROTOCOL_VERSION and DESKTOP_WINDOW_CAPABILITIES into preload.ts, because Electron's sandboxed preload cannot import
// another module. Kotlin's MessageRouter.kt mirrors ANDROID_LOCAL_CAPABILITIES (pinned by
// tests/capabilities.test.ts, the way bundled-plugins-parity pins its list).

/** The version of the handshake and message shapes between a screen and its host. Bump it when a message changes in a
 *  way an older screen or host would misread; a screen never refuses a host over it (it falls back to
 *  REMOTE_SCREEN_CAPABILITIES), but it lets a future screen say "update the other side". */
export const PROTOCOL_VERSION = 1;

export interface Capabilities {
  /** More than one window of its own: tear a session out, drag it between windows, window caption buttons. */
  nativeWindows: boolean;
  /** Open a file or folder in the computer's own apps, or show it in the file manager (shell.openPath / showItemInFolder). */
  openInOs: boolean;
  /** Open a web address in the computer's own browser (shell.openExternal), for sign-in flows that tell the person to
   *  "go to this address". A screen without it shows the address to copy instead. */
  openExternal: boolean;
  /** Git status and review for a file (the git channels answer only on the computer's own windows). */
  git: boolean;
  /** Theme pictures that live on this device load (theme-asset:// URLs: wallpapers, mascot pictures). */
  themePictures: boolean;
  /** Animated theme mascots (rigs) draw inline. They fetch theme-asset:// files at draw time. */
  themeRigs: boolean;
  /** How the terminal receives its bytes: 'text' = pty:output strings (what a computer sends to a window or a phone),
   *  'raw-bytes' = pty:raw-bytes (Android's own runtime). Waiting for the wrong one draws a blank terminal. */
  terminalTransport: 'text' | 'raw-bytes';
  /** The terminal's screen text can be read on this device (the "is Claude stuck?" check). A screen watching a
   *  computer has no buffer of its own; the computer reports attention instead. */
  terminalScreenRead: boolean;
  /** The app's own assistant engine (native sessions, local models, provider keys) can be started and used from this screen.
   *  A model picker offers native models only when this is true. A phone watching a computer gets true from a computer with the
   *  engine on (one-core R6-1): the session runs on the computer, the phone only drives it. */
  nativeSessions: boolean;
  /** The floating buddy window exists. */
  buddy: boolean;
  /** This screen may change a project's files and records: copy a file into the folder, record a file the assistant
   *  made outside it. A screen watching a computer only reads. */
  projectWrites: boolean;
  /** Search inside the CONTENTS of a project's files (the Files tab search box). */
  contentSearch: boolean;
  /** A running conversation on another device can be taken over from here ("live handoff"). */
  liveHandoff: boolean;
  /** The host keeps a numbered record of each session and publishes the shared lines (a model-switch or "Conversation
   *  cleared" divider, the compaction spinner, a prompt card, the messages queued on the computer) as events, so this screen
   *  draws them from the record and does NOT infer them itself (one-core R5-4a). False only on the Android app's own runtime,
   *  which has no such record: there the screen keeps drawing what it infers. */
  sessionRecord: boolean;
}

/** What the computer's own window can do. The preload copies this and overrides `nativeSessions` from the
 *  YOUCODED_NATIVE kill switch (the only part that varies per run). */
export const DESKTOP_WINDOW_CAPABILITIES: Capabilities = {
  nativeWindows: true,
  openInOs: true,
  openExternal: true,
  git: true,
  themePictures: true,
  themeRigs: true,
  terminalTransport: 'text',
  terminalScreenRead: true,
  nativeSessions: true,
  buddy: true,
  projectWrites: true,
  contentSearch: true,
  liveHandoff: true,
  sessionRecord: true,
};

/** What a screen watching a computer over the network can do (a phone's browser, or the Android app paired to a
 *  computer). Also the CONSERVATIVE DEFAULT: a screen that hears nothing from its host (an older computer that sends no
 *  capabilities) assumes only what is true of every screen — it can read and chat, and nothing that needs the
 *  computer's own machine. */
export const REMOTE_SCREEN_CAPABILITIES: Capabilities = {
  nativeWindows: false,
  openInOs: false,
  openExternal: false,
  git: false,
  themePictures: false,
  themeRigs: false,
  terminalTransport: 'text',
  terminalScreenRead: false,
  // FALSE on purpose, like sessionRecord: a computer older than R6-1 says nothing and cannot run a native session for a phone. A
  // current host says true in its handshake (remote-server.ts authOkMessage), never by this default.
  nativeSessions: false,
  buddy: false,
  projectWrites: false,
  contentSearch: false,
  liveHandoff: true,
  // FALSE on purpose: a host that sends no `sessionRecord` (a computer older than the record) has none, so the screen keeps inferring the
  // lines itself. A host WITH a record says true explicitly in its handshake (remote-server.ts), never by this default (review fix, R5-4a F3).
  sessionRecord: false,
};

/** What the Android app can do on its OWN runtime (not paired to a computer). Mirrored in MessageRouter.kt. */
export const ANDROID_LOCAL_CAPABILITIES: Capabilities = {
  nativeWindows: false,
  openInOs: false,
  openExternal: false,
  git: false,
  themePictures: true,
  themeRigs: false,
  terminalTransport: 'raw-bytes',
  terminalScreenRead: true,
  nativeSessions: false,
  buddy: false,
  projectWrites: true,
  contentSearch: false,
  liveHandoff: false,
  sessionRecord: false,
};

const KEYS = Object.keys(REMOTE_SCREEN_CAPABILITIES) as Array<keyof Capabilities>;

/** Read a capabilities object that arrived over the wire (untrusted, possibly from an older or newer host).
 *  A key that is missing or the wrong type takes the conservative default; unknown keys are dropped. */
export function normalizeCapabilities(raw: unknown): Capabilities {
  const out: Record<string, unknown> = { ...REMOTE_SCREEN_CAPABILITIES };
  if (raw && typeof raw === 'object') {
    for (const k of KEYS) {
      const v = (raw as Record<string, unknown>)[k];
      if (k === 'terminalTransport' ? (v === 'text' || v === 'raw-bytes') : typeof v === 'boolean') out[k] = v;
    }
  }
  return out as unknown as Capabilities;
}

/** The protocol version a handshake reported: a positive whole number, or 0 when the host sent none (an older host). */
export function normalizeProtocolVersion(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : 0;
}
