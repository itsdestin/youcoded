// YouCoded Pages — shared shapes.
// Plan: youcoded-dev/docs/active/plans/2026-09-16-youcoded-pages-phasing.md
//
// A page is a small app inside YouCoded, built in chat, shown in the live theme.
// Phase 1 (the shell) pages reach nothing outside their own frame. Phase 2 adds
// connections, below — decided on two questions decks on 2026-09-19.

/** Where a page lives. Personal pages belong to the person; project pages
 *  belong to one project folder and say so on their card. Explicit, never
 *  inferred from the current session (scope §1: "explicit source bindings"). */
export type PageHome =
  | { kind: 'personal' }
  | { kind: 'project'; path: string; name: string }
  // WHY: Office ships with the app (questions deck office-questions#Q-entry: "a
  // pinnable page") — it lists, pins and opens like a page, but its body is the
  // app's own Office view, never a framed page document.
  | { kind: 'builtin' };

/** The small named icon set a page may pick for its card and pinned button.
 *  A named glyph, not an image: the pinned button is 16px in the header bar
 *  and follows `currentColor` like the Projects folder beside it. */
export type PageIcon =
  | 'page' | 'timer' | 'notes' | 'paint' | 'chart' | 'calendar' | 'list' | 'game' | 'money'
  // Built-in pages only.
  | 'office';

/** The built-in Office page's id. Stable, so a pin syncs like any page's. */
export const OFFICE_PAGE_ID = 'builtin:office';

/** The built-in Office page as the pages list carries it (main lists it where the add-on is
 *  installed; the workbench fake always does). Unpinned until the person pins it. */
export const OFFICE_PAGE_SUMMARY: PageSummary = {
  id: OFFICE_PAGE_ID, name: 'Office', description: 'Documents, spreadsheets and presentations.',
  icon: 'office', home: { kind: 'builtin' }, pinned: false, updatedAt: '2026-09-28T00:00:00Z', htmlStamp: 0,
};

// ── Phase 2: connections (decided on two questions decks, 2026-09-19) ──────
// Everything a page reaches outside its frame is listed here and approved
// once; anything unlisted is blocked. The shapes are the UI's contract — the
// backend (manifest parsing, the approval store, fetch-on-behalf) is built
// AFTER the screens are approved, so these fields are optional on PageSummary
// until then and only the workbench fake fills them.

/** `lookup`: the app sends look-up requests only and blocks the rest, so the
 *  approval can truthfully say "Cannot send changes". Never worded as
 *  "read-only" or "safe" for an outside service (deck Q-readonly). */
/** The word a service expects before a key in a header. */
export type KeyScheme = 'bearer' | 'token' | 'none';

export type PageAccess = 'lookup' | 'full';

export type PageConnection =
  /** YouCoded's own service, as the signed-in person. */
  | {
      id: string; kind: 'youcoded';
      /** Changes are allowed ONLY at these exact places on YouCoded's service
       *  (for example `/admin/analytics/website-campaigns`); look-ups anywhere.
       *  Absent or empty: look-ups only. There is deliberately no "change
       *  anything" form — the sign-in controls the person's whole account. */
      writePaths?: string[];
    }
  /** A service that takes a pasted key. The key lives in the app, never the page. */
  | {
      id: string; kind: 'key'; service: string; address: string; access: PageAccess;
      /** How to find the key, written by the page's author and carried with the
       *  page (review round 1, C-1). Shown as the author's words. */
      keyHelp?: { steps: string[] };
      /** Where the service wants the key. Every service takes it somewhere
       *  different and the person is never asked — OpenWeather wants `appid`
       *  in the URL, most others want a header — so the manifest says which,
       *  and main attaches it there. Default: the `Authorization` header. */
      keyIn?: 'header' | 'query';
      keyParam?: string;
      /** What goes before the key in a header. Absent means the usual word for
       *  an Authorization header ("Bearer") and nothing for any other header. */
      keyScheme?: KeyScheme;
    }
  /** Public information: an approved address, nothing secret. */
  | { id: string; kind: 'public'; address: string }
  /** The GitHub sign-in the app already holds. */
  | { id: string; kind: 'github'; access: PageAccess }
  /** The whole internet — its own blunt approval, never combined with a key
   *  or sign-in on the same page (follow-up deck Q-open, Q-open-mix). */
  | { id: string; kind: 'open' }
  /** ONE device in the home or on the person's Tailscale network, such as Home
   *  Assistant (home-device questions deck, 2026-10-01). The page SUGGESTS an
   *  address; the person may change it on the approval card, and what they
   *  allow is what the app uses (Q-address). Only home and Tailscale addresses
   *  are accepted (S-only-home, `page-device-address.ts`). Never combined with
   *  `open` on one page, like every other credentialled kind. */
  | {
      id: string; kind: 'device'; service: string;
      /** `host` or `host:port`. Before approval: the page's suggestion. After:
       *  the address the person allowed, which may differ from the manifest. */
      address: string;
      access: PageAccess;
      /** False for a device that needs no key (most home devices do). */
      needsKey: boolean;
      keyHelp?: { steps: string[] };
      /** A path on the device where its key is made (Home Assistant:
       *  `/profile/security`). The key step offers a button that opens it in
       *  the browser, so the person does not have to find it. */
      keyPage?: string;
      keyIn?: 'header' | 'query';
      keyParam?: string;
      keyScheme?: KeyScheme;
      /** The first message of a socket exchange (`PageFetchRequest.socket`),
       *  sent BY THE APP before any of the page's own, with `{{key}}` replaced
       *  by the saved key. It is how a device that signs in over its socket
       *  (Home Assistant: `{"type":"auth","access_token":"{{key}}"}`) gets the
       *  key without the page ever holding it: the page cannot put the key in
       *  a message of its own, so it cannot write it somewhere it could read
       *  back. Part of the approval fingerprint. */
      socketHello?: string;
      // The device profile (spec 2026-10-04) is the four fields below: what main
      // must know about the device, read from the approved manifest and never
      // chosen by a page. All of it rides the approval fingerprint (one
      // `|profile:` segment).
      /** The reply TYPE that means "logged in" (Home Assistant: `auth_ok`). */
      socketReady?: string;
      /** The reply TYPE that means "wrong key" (`auth_invalid`). */
      socketAuthFailed?: string;
      /** Extra lower-case type prefixes refused on this device's socket, added
       *  to main's built-in floor. */
      socketDeny?: string[];
      /** How main plays a camera on the page's behalf. */
      videoProfile?: VideoProfile;
    }
  /** Bank balances through Plaid (finance dashboard, 2026-10-05). The page
   *  never reaches Plaid itself: it asks the app (`youcoded.plaid`) to connect
   *  a bank, read balances, reconnect or remove one, and main holds the Plaid
   *  keys and every bank's sign-in (main/pages/plaid.ts). The key is saved
   *  like any other under service "Plaid" at the environment's address, so
   *  practice (sandbox) and real (production) keys never mix. */
  | { id: string; kind: 'plaid'; environment: PlaidEnvironment; keyHelp?: { steps: string[] } };

export type PlaidEnvironment = 'sandbox' | 'production';
/** The saved-key address for a Plaid environment. */
export function plaidAddress(env: PlaidEnvironment): string { return `${env}.plaid.com`; }
export const PLAID_SERVICE = 'Plaid';

/** Which browser a bank sign-in opens in. Some banks' own login pages fail in one browser and work in another
 *  (American Express's, in Chrome, on the first real try), so the person can pick. */
export type PlaidBrowser = 'default' | 'firefox' | 'chrome';

/** What a page may ask Plaid for, through the app. */
export type PlaidRequest =
  | { op: 'status' }
  | { op: 'connect'; browser?: PlaidBrowser }
  /** Stop waiting for a bank sign-in (the person closed the browser tab). */
  | { op: 'cancel' }
  | { op: 'accounts'; live?: boolean }
  | { op: 'reconnect'; itemId: string; browser?: PlaidBrowser }
  | { op: 'remove'; itemId: string };

/** A bank as Plaid describes it. `logo` is a data: PNG; `color` a #rrggbb. */
export interface PlaidInstitution { id: string; name: string; logo?: string; color?: string; url?: string }

export interface PlaidAccount {
  id: string; name: string; officialName?: string; mask?: string;
  type: string; subtype?: string;
  kind: 'checking' | 'savings' | 'investment' | 'credit' | 'loan' | 'other';
  /** Plaid's `current`: what is in the account, or what is owed on a card or loan. */
  balance: number;
  available?: number; limit?: number; currency?: string;
  /** Cards and loans, where the bank shares it (Plaid Liabilities). */
  liability?: {
    apr?: number; minimumPayment?: number; nextDue?: string;
    lastPaymentDate?: string; lastPaymentAmount?: number; isOverdue?: boolean;
  };
}

/** One connected bank. `error.reconnect` means "sign in to this bank again". */
export interface PlaidItemSummary {
  itemId: string;
  institution: PlaidInstitution;
  ok: boolean;
  error?: { code: string; message: string; reconnect: boolean };
  accounts: PlaidAccount[];
}

export type PlaidResult =
  | { ok: true; op: PlaidRequest['op']; items: PlaidItemSummary[] }
  | { ok: false; op: PlaidRequest['op']; code: string; message: string };

/** How main asks a device for camera video. `send` is a JSON template that
 *  may hold `{{offer}}` and `{{target}}` but never `{{key}}`; the other three
 *  are dotted paths into the device's replies. */
export interface VideoProfile {
  /** What a page may ask to watch. Must end with "." (the device's
   *  `domain.` form, e.g. `camera.`): one character or a bare word would
   *  widen "a camera" to "anything on the device". */
  targetPrefix: string;
  /** The path of the device's socket (default `/api/websocket`). Main opens
   *  its own connection there for a video, never one the page names. */
  socketPath?: string;
  send: string;
  answer: string;
  candidate: string;
  failed: string;
}

/** A connection as the person sees it on one page. */
export type PageConnectionStatus = PageConnection & {
  /** False for a line added since the last approval — the page pauses and the
   *  approval screen marks just this line New (deck S-change). */
  approved: boolean;
  /** `key` and `device`: a key for this service is already saved, so the
   *  approval offers it instead of asking again (deck Q-key-reuse). For a
   *  device it is the key saved for the SUGGESTED address; a changed address
   *  asks for a key again, because keys are kept per service AND address. */
  savedKey?: boolean;
};

/** Freshness of a connected page, owned by the app and shown in the band
 *  (deck Q-last-updated). `at` is null before the first successful update. */
export interface PageRefreshState {
  at: string | null;
  failed: boolean;
}

/** A key saved once under Settings › Connected services, with the pages using
 *  it. Identified by service AND address: a saved key is offered to another
 *  page only when the address matches byte for byte, so a second page cannot
 *  point your key at its own collector (design review 1, finding 3). */
export interface SavedPageKey {
  service: string;
  address: string;
  usedBy: { id: string; name: string }[];
}

/** What a page asked the app to fetch on its behalf. The page never holds the
 *  credential; main attaches it and redacts it from everything it returns. */
export interface PageFetchRequest {
  /** Absolute http(s) URL. A relative or protocol-relative URL is refused. */
  url: string;
  method?: string;
  /** Only Accept, Accept-Language and Content-Type survive. */
  headers?: Record<string, string>;
  body?: string;
  /** `picture`: answer an image as a `data:` link the page can put straight
   *  into an <img> (camera snapshots — home-device deck, Q-scope). Refused for
   *  anything that is not an image, so it cannot become a way to carry other
   *  bytes past the text redaction. Default: text.
   *  `video`: the same for a recorded clip (spec 2026-10-04, Part 3) — a
   *  `data:video/mp4;base64,…` link for a <video>. Only a device connection;
   *  `video/mp4` with an `ftyp` box, at most 4 MB, one at a time per page. */
  as?: 'text' | 'picture' | 'video';
  /** A one-shot socket exchange with an approved `device` that may make
   *  changes (home-page-v2 deck, Q-where: renames and room moves happen in
   *  the device itself, which some devices only offer over a socket). The
   *  app opens `ws://` (or `wss://` for an https URL) to the SAME approved
   *  host and port, sends the connection's `socketHello` and then `send` in
   *  order, collects text messages until it holds `until` of them (or the
   *  device closes), and closes. The answer's `body` is a JSON array of the
   *  messages received, in order, with the key removed. Nothing stays open:
   *  a page that is hidden or closed holds no socket. */
  socket?: { send: string[]; until: number; timeoutMs?: number };
}

type PageFetchRefusal =
  | 'not-approved'        // no connection covers that address, or it is not approved
  | 'method-not-allowed'  // a look-up connection was asked to send a change
  | 'too-many-requests'   // the page's own rate cap
  | 'bad-url'             // not an absolute http(s) URL
  | 'unsupported'         // this window cannot fetch for a page at all (Android, an older host)
  | 'network';            // the guard or the service refused; `message` says what

export type PageFetchResult =
  | { ok: true; status: number; headers: Record<string, string>; body: string }
  | { ok: false; reason: PageFetchRefusal; message: string };

/** Approving can fail for a reason the person must see — most often a computer
 *  with no keychain, where the secrets store refuses by design and NO approval
 *  is recorded (design review 1, finding 11). */
export type PageApproveResult =
  | { ok: true; pages: PageSummary[] }
  | { ok: false; message: string };

export interface PageSummary {
  /** `personal:<slug>` or `project:<project name>:<slug>` — the same on every
   *  device, so a synced pin matches (design review F3). */
  id: string;
  name: string;
  /** One line, shown on the card under the name. */
  description: string;
  icon: PageIcon;
  home: PageHome;
  /** Pinned pages get their own icon beside Projects. Per device. */
  pinned: boolean;
  /** ISO timestamp of the last change to the page's manifest or document. */
  updatedAt: string;
  /** Changes only when `page.html` is rewritten — never on a data save — so
   *  the host reloads the frame on an edit and not on the page's own saving
   *  (design review F7). Milliseconds. */
  htmlStamp: number;
  /** What the page reaches. Absent or empty: a page that reaches nothing. */
  connections?: PageConnectionStatus[];
  /** Present only for a connected page that has been approved. */
  refresh?: PageRefreshState;
  /** The page's code is not the code that was approved, while its connections
   *  are. It still opens and still reaches only what was allowed; the band
   *  says so quietly until the person dismisses it (deck 3, Q-code-change). */
  codeChanged?: boolean;
}

/** A page's working version, ready to show. `html` is a complete document;
 *  the host injects the theme, the style kit and `data` before it is framed. */
export interface PageDocument extends PageSummary {
  html: string;
  /** The page's own saved data, folded; null when it has never saved. */
  data: unknown | null;
}

/** Largest `data.json` the host will write, checked in the renderer before
 *  posting and in main before writing (design review F4). */
export const MAX_PAGE_DATA_BYTES = 1_000_000;

/** Why a page could not be shown. Specific and accurate when known
 *  (docs/error-message-standards.md); the host never invents a cause. */
export type PageLoadFailure =
  | { kind: 'missing'; message: string }
  | { kind: 'unreadable'; message: string };

// ── The live socket (spec 2026-10-04, Part 1) ────────────────────────────
/** What a page sees of its live connection. `paused` is made by the host (the
 *  window is hidden), never by main. */
export type PageSocketState = 'connecting' | 'open' | 'reconnecting' | 'paused' | 'closed';
/** Every call names the page and the FRAME INSTANCE it came from; main also
 *  knows the caller (window or remote client) itself, so a socket is usable
 *  only by the frame that opened it. */
export interface PageSocketCall { page: string; frame: string; }
export type PageSocketOpenResult = { ok: true; socket: string } | { ok: false; message: string };
export type PageSocketCallResult = { ok: true } | { ok: false; message: string };
/** Pushed by main to the owner only. `socket` is main's id for it. */
export type PageSocketEvent =
  | { socket: string; kind: 'state'; state: PageSocketState; why?: string }
  | { socket: string; kind: 'messages'; texts: string[] }
  // Camera video (spec 2026-10-04, Part 2). `socket` is main's id for the VIDEO.
  // Main hands the host only what the device answered, already filtered and
  // redacted; the host never sees a network address it was not meant to dial.
  | { socket: string; kind: 'video-answer'; answer: string }
  | { socket: string; kind: 'video-candidate'; candidate: string }
  | { socket: string; kind: 'video-stopped'; why: string };
/** The channels, written out here because preload cannot import this file
 *  (pinned equal by tests/ipc-channels.test.ts). */
export const PAGE_SOCKET_CHANNELS = {
  open: 'pages:socket-open', send: 'pages:socket-send', close: 'pages:socket-close',
  ping: 'pages:socket-ping', event: 'pages:socket-event',
} as const;

/** Camera video: the host asks main to start / stop / keep alive one video.
 *  Events come back on the same push channel as the live socket. */
export type PageVideoStartRequest = PageSocketCall & { connection: string; target: string; offer: string };
export type PageVideoCall = PageSocketCall & { video: string };
export type PageVideoStartResult = { ok: true; video: string } | { ok: false; message: string };
export const PAGE_VIDEO_CHANNELS = { start: 'pages:video-start', stop: 'pages:video-stop', ping: 'pages:video-ping' } as const;

export interface PagesBridge {
  list: () => Promise<PageSummary[]>;
  get: (id: string) => Promise<{ ok: true; page: PageDocument } | { ok: false; failure: PageLoadFailure }>;
  setPinned: (id: string, pinned: boolean) => Promise<PageSummary[]>;
  /** Writes the page's own data beside it (`data.json`, later save wins).
   *  Refused over MAX_PAGE_DATA_BYTES or for an unknown page. */
  setData: (id: string, data: unknown) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Fires with the fresh list whenever a page is added, rewritten, renamed,
   *  pinned or removed — on this device or arriving by sync. Returns the
   *  unsubscribe. */
  onChanged: (cb: (pages: PageSummary[]) => void) => () => void;
  // Phase 2 — workbench-only until the screens are approved (mock-only.ts).
  /** Approves every unapproved line. `keys` carries a pasted key per `key` or
   *  `device` connection id, or 'saved' to use the one already kept.
   *  `addresses` carries the address the person allowed per `device` id; main
   *  re-checks it is a home address before recording anything. */
  approve?: (id: string, keys: Record<string, string>, addresses?: Record<string, string>) => Promise<PageApproveResult>;
  /** Stops future use of one connection; the page asks again next time. */
  removeConnection?: (id: string, connectionId: string) => Promise<PageSummary[]>;
  /** Fetch fresh information now (the band's refresh button). */
  refresh?: (id: string) => Promise<PageSummary[]>;
  savedKeys?: () => Promise<SavedPageKey[]>;
  /** Both parts, because a key is identified by service AND address. */
  deleteSavedKey?: (service: string, address: string) => Promise<SavedPageKey[]>;
  /** The one door out of a page. Main checks it against the approvals on disk. */
  fetch?: (id: string, req: PageFetchRequest) => Promise<PageFetchResult>;
  /** Plaid on the page's behalf (main/pages/plaid.ts). Desktop only. */
  plaid?: (id: string, req: PlaidRequest) => Promise<PlaidResult>;
  /** The live socket (platform tooling). Absent where a window cannot hold one. */
  socketOpen?: (req: PageSocketCall & { url: string }) => Promise<PageSocketOpenResult>;
  socketSend?: (req: PageSocketCall & { socket: string; text: string }) => Promise<PageSocketCallResult>;
  socketClose?: (req: PageSocketCall & { socket: string }) => Promise<PageSocketCallResult>;
  /** The lease: main closes a socket that has not been pinged for 60 s. */
  socketPing?: (req: PageSocketCall & { socket: string }) => Promise<PageSocketCallResult>;
  onSocketEvent?: (cb: (e: PageSocketEvent) => void) => () => void;
  /** Camera video played by the app (platform tooling). */
  videoStart?: (req: PageVideoStartRequest) => Promise<PageVideoStartResult>;
  videoStop?: (req: PageVideoCall) => Promise<PageSocketCallResult>;
  videoPing?: (req: PageVideoCall) => Promise<PageSocketCallResult>;
  /** Workbench only: a pretend peer connection and picture source for the host
   *  code to run against (no camera exists there). Real bridges never set it. */
  videoPlayback?: object;
}

/** How many pinned pages the header shows before the rest stay in the
 *  library. Small on purpose: the left cluster shares its width with the
 *  session strip, and packSessions() already competes for it. */
export const MAX_PINNED_PAGES = 4;
