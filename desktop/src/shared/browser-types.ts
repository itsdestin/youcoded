// The Browser's shapes shared by the screen (renderer) and the main process /
// worker (src/main/assistant-browser/). Data only.

export type BrowserRunState = 'stopped' | 'starting' | 'running' | 'error';

export type PromptKind = 'site' | 'final' | 'local' | 'handoff' | 'no-browser';
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

export interface BrowserTabInfo { index: number; title: string; url: string; active: boolean }

/** Everything a screen needs to draw one conversation's Browser panel and card. */
export interface BrowserSessionState {
  sessionId: string;
  run: BrowserRunState;
  windowShown: boolean;
  myChrome: boolean;
  browserLabel: string | null;
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
}

/** One live picture of a conversation's current tab (base64 JPEG). */
export interface BrowserFrame { sessionId: string; data: string; width: number; height: number }

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

/** Settings a screen may change. */
export type BrowserSettingsPatch = Partial<Pick<BrowserPreferences, 'showWindow' | 'useMyChrome' | 'preferredBrowser' | 'explainerSeen'>>;

/** The Browser tool behind a tool-card name: native ("BrowserAct") or a Claude
 *  Code MCP name ("mcp__youcoded-browser-1a2b3c4d__BrowserAct"). */
export const BROWSER_TOOL_LABEL_NAMES = ['BrowserNavigate', 'BrowserSnapshot', 'BrowserAct', 'BrowserScreenshot', 'BrowserTabs', 'BrowserWait', 'BrowserAskUser'] as const;

export function browserToolOf(toolName: string): typeof BROWSER_TOOL_LABEL_NAMES[number] | null {
  const m = /^(?:mcp__youcoded-browser-[0-9a-f]+__)?(Browser\w+)$/.exec(toolName);
  if (!m) return null;
  return (BROWSER_TOOL_LABEL_NAMES as readonly string[]).includes(m[1]) ? m[1] as typeof BROWSER_TOOL_LABEL_NAMES[number] : null;
}
