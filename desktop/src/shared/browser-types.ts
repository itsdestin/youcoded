// The Browser's shapes shared by the screen (renderer) and the main process /
// worker (src/main/assistant-browser/). Data only.

export type BrowserRunState = 'stopped' | 'starting' | 'running' | 'error';

type PromptKind = 'site' | 'final' | 'form' | 'local' | 'handoff' | 'no-browser';
export type PromptAnswer = 'allow_chat' | 'allow_always' | 'once' | 'no' | 'done' | 'cant' | 'download';

/** A card the Browser shows the person, asking them to decide or act. */
export interface BrowserPrompt {
  kind: PromptKind;
  id: string;
  /** The sentence the card shows (already plain language). */
  message: string;
  /** The site the ask is about, when there is one. */
  host?: string;
  /** Whether "Always allow" may be offered (false in My Chrome). */
  allowAlways?: boolean;
}

interface BrowserTabInfo {
  index: number; title: string; url: string; active: boolean;
  /** The page is still loading (the panel's Reload becomes Stop). */
  loading: boolean;
  /** Whether Back / Forward have anywhere to go in this tab. */
  canGoBack: boolean; canGoForward: boolean;
}

/** Everything a screen needs to draw one conversation's Browser panel and card. */
export interface BrowserSessionState {
  sessionId: string;
  run: BrowserRunState;
  windowShown: boolean;
  myChrome: boolean;
  browserLabel: string | null;
  /** The browser is running without its extra protection (Linux computers that don't allow it). Optional so older
   *  senders and fixtures still fit. */
  sandboxOff?: boolean;
  tabs: BrowserTabInfo[];
  prompt: BrowserPrompt | null;
  /** A plain, verified sentence when run === 'error'. */
  error: string | null;
  /** This conversation has used the browser since the app started. */
  used: boolean;
  /** The assistant is in the middle of a browser call. */
  busy: boolean;
  /** Browser download progress 0–100 while a download runs, else null. */
  downloadPercent: number | null;
  /** The page zoom the panel's − / + shows (the person and the assistant share
   *  it); `auto` = the default, which follows the panel's width. null when the
   *  pages can't be zoomed (a shown window or My Chrome). */
  zoom: { percent: number; auto: boolean } | null;
}

/** One live picture of a conversation's current tab (base64 JPEG). */
export interface BrowserFrame {
  sessionId: string; data: string; width: number; height: number;
  /** How far the page was scrolled when the picture was taken (CSS px). Lets
   *  the panel move the picture at once while a scroll is on its way. */
  scrollX: number; scrollY: number;
}

export type BrowserKind = 'chrome' | 'edge' | 'chromium' | 'brave' | 'downloaded';

export interface FoundBrowser {
  kind: BrowserKind;
  /** Name shown to the person. */
  label: string;
  executablePath: string;
}

export type InstallState =
  | { phase: 'idle' }
  | { phase: 'downloading'; percent: number }
  | { phase: 'done' }
  | { phase: 'failed'; error: string };

export interface BrowserPreferences {
  /** A real window instead of a hidden browser. */
  showWindow: boolean;
  /** Work in the person's own running Chrome instead of the Browser's own. */
  useMyChrome: boolean;
  /** null = the first browser found. */
  preferredBrowser: BrowserKind | null;
  /** Hosts the person chose "Always allow" for (lower-case host names). */
  alwaysAllowedSites: string[];
  /** Hosts where the person chose "Always allow" for SUBMITTING FORMS (lower-case, www. folded).
   *  WHY separate from alwaysAllowedSites (click/type) and from any "may open this site" list:
   *  each is a different permission and must be granted and revoked on its own. */
  alwaysAllowedFormSites: string[];
  /** The one-time explainer was dismissed. */
  explainerSeen: boolean;
}

/** What Settings → Browser and the panel need besides one conversation's state. */
export interface BrowserInfo {
  running: boolean;
  browsers: FoundBrowser[];
  chosen: FoundBrowser | null;
  install: InstallState;
  settings: BrowserPreferences;
  /** Conversations with tabs open (the restart confirm names the count). */
  sessionsWithTabs: number;
}

export interface MyChromeCheck { ok: boolean; message: string }

/** What the person typed in the panel's address box, a back/forward/reload/stop
 *  button, or a tab action from the panel's tab strip. */
type BrowserOpenRequest =
  | { sessionId: string; address: string }
  | { sessionId: string; nav: 'back' | 'forward' | 'reload' | 'stop' }
  | { sessionId: string; tab: 'new' | 'select' | 'close'; index?: number }
  /** The panel's − / + (a percent), or its % button ('auto' = the default). */
  | { sessionId: string; zoom: number | 'auto' };

/** The person using the page through the panel's picture. Coordinates are page
 *  (CSS) pixels of the live picture's frame. */
export type BrowserInputEvent =
  | { type: 'click'; x: number; y: number; clickCount: number; button: 'left' | 'right' | 'middle' }
  /** The left button pressed, dragged and let go as separate steps, so a drag
   *  highlights text on the page (a click is a down then an up). */
  | { type: 'mouse'; action: 'down' | 'move' | 'up'; x: number; y: number; clickCount: number }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string };

/** Settings a screen may change. */
export type BrowserSettingsPatch = Partial<Pick<BrowserPreferences, 'showWindow' | 'useMyChrome' | 'preferredBrowser' | 'explainerSeen'>>;

/** The Browser tool behind a tool-card name: native ("BrowserAct") or a Claude
 *  Code MCP name ("mcp__youcoded-browser-1a2b3c4d__BrowserAct"). */
export const BROWSER_TOOL_LABEL_NAMES = ['BrowserNavigate', 'BrowserHistory', 'BrowserZoom', 'BrowserSnapshot', 'BrowserAct', 'BrowserScreenshot', 'BrowserTabs', 'BrowserWait', 'BrowserAskUser'] as const;

export function browserToolOf(toolName: string): typeof BROWSER_TOOL_LABEL_NAMES[number] | null {
  const m = /^(?:mcp__youcoded-browser-[0-9a-f]+__)?(Browser\w+)$/.exec(toolName);
  if (!m) return null;
  return (BROWSER_TOOL_LABEL_NAMES as readonly string[]).includes(m[1]) ? m[1] as typeof BROWSER_TOOL_LABEL_NAMES[number] : null;
}

/** Request/answer shapes of the browser:* channels (main/ipc/browser.ts). */
export interface BrowserChannelTypes {
  'browser:state': { request: { sessionId: string }; response: BrowserSessionState | null };
  'browser:info': { request: void; response: BrowserInfo };
  'browser:watch': { request: { sessionId: string }; response: boolean };
  'browser:unwatch': { request: { sessionId: string }; response: boolean };
  'browser:frame-ack': { request: { sessionId: string }; response: void };
  'browser:answer': { request: { sessionId: string; promptId: string; answer: PromptAnswer }; response: boolean };
  'browser:open-window-for-handoff': { request: { sessionId: string }; response: boolean };
  'browser:set-show-window': { request: { show: boolean }; response: BrowserInfo };
  'browser:update-settings': { request: BrowserSettingsPatch; response: BrowserInfo };
  'browser:remove-site': { request: { host: string; form?: boolean }; response: BrowserInfo };
  'browser:clear-signins': { request: void; response: BrowserInfo };
  'browser:stop': { request: void; response: boolean };
  'browser:close-session': { request: { sessionId: string }; response: boolean };
  'browser:download': { request: void; response: BrowserInfo };
  'browser:cancel-download': { request: void; response: boolean };
  'browser:check-my-chrome': { request: void; response: MyChromeCheck };
  'browser:open': { request: BrowserOpenRequest; response: { ok: boolean; error?: string } };
  'browser:input': { request: { sessionId: string; event: BrowserInputEvent }; response: void };
  'browser:view-size': { request: { sessionId: string; width: number; height: number }; response: void };
  'browser:selection': { request: { sessionId: string }; response: string };
}

/** window.claude.browser — the computer's own window only (capabilities.assistantBrowser); remote-shim's methods reject. */
export interface BrowserBridge {
  state: (sessionId: string) => Promise<BrowserSessionState | null>;
  info: () => Promise<BrowserInfo>;
  watch: (sessionId: string) => Promise<boolean>;
  unwatch: (sessionId: string) => Promise<boolean>;
  ackFrame: (sessionId: string) => void;
  answer: (sessionId: string, promptId: string, answer: PromptAnswer) => Promise<boolean>;
  openWindowForHandoff: (sessionId: string) => Promise<boolean>;
  setShowWindow: (show: boolean) => Promise<BrowserInfo>;
  updateSettings: (patch: BrowserSettingsPatch) => Promise<BrowserInfo>;
  removeSite: (host: string, form?: boolean) => Promise<BrowserInfo>;
  clearSignins: () => Promise<BrowserInfo>;
  stop: () => Promise<boolean>;
  closeSession: (sessionId: string) => Promise<boolean>;
  download: () => Promise<BrowserInfo>;
  cancelDownload: () => Promise<boolean>;
  checkMyChrome: () => Promise<MyChromeCheck>;
  /** The person browses themselves: an address or search, or back/forward/reload. */
  open: (req: BrowserOpenRequest) => Promise<{ ok: boolean; error?: string }>;
  /** A click, scroll or key on the panel's picture, sent on to the page. */
  input: (sessionId: string, event: BrowserInputEvent) => void;
  /** The panel's picture area, so a hidden browser lays its pages out to fit. */
  viewSize: (sessionId: string, width: number, height: number) => void;
  /** The text highlighted on the page right now ('' for none), for Copy. */
  selection: (sessionId: string) => Promise<string>;
  onState: (cb: (state: BrowserSessionState) => void) => () => void;
  onFrame: (cb: (frame: BrowserFrame) => void) => () => void;
  onInfoChanged: (cb: () => void) => () => void;
}
