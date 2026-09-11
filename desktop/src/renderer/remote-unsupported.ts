// Shared vocabulary for "this feature isn't bridged to remote access yet".
//
// Deliberately its own module with NO imports. remote-shim.ts is loaded only
// via a dynamic import() on the remote/browser path (see index.tsx) — pulling
// these constants directly from it would drag the whole shim into the main
// bundle and evaluate it on desktop, where it is never used.

export const REMOTE_UNSUPPORTED_EVENT = 'youcoded:remote-unsupported';

export interface RemoteUnsupportedDetail {
  channel: string;
  feature: string;
  message: string;
}

// Namespace → what the user would call it. Longest-prefix-first so
// 'theme-marketplace:' wins over 'theme:'.
const FEATURE_NAMES: Array<[string, string]> = [
  ['theme-marketplace:', 'Theme browsing'],
  ['marketplace:', 'The skill marketplace'],
  ['social:', 'Friends and challenges'],
  ['integrations:', 'Integrations'],
  ['artifacts:', 'Project files'],
  ['project:', 'Project details'],
  ['dialog:', 'File pickers'],
  ['theme:', 'Theme editing'],
  ['skills:', 'Skills'],
  ['dev:', 'Developer tools'],
  // The local llama.cpp engine and the models it runs. Both stub out on a
  // phone, which has neither, and without a name here the notice would read
  // "models:settings isn't available via remote access yet." — a channel name,
  // which means nothing to anyone. Phrased as singular nouns because the
  // sentence below appends "isn't available…".
  ['models:', 'The local model manager'],
  ['engine:', 'The local engine'],
  // Desktop-only on a phone too, and both are called on ordinary screens
  // (provider:list runs every time the model picker opens), so a missing name
  // here is a toast reading a raw channel id at somebody.
  ['provider:', 'The model providers list'],
  ['native:', 'The built-in assistant'],
  // Reading the terminal's own screen. The classifier that polled this no longer runs on a
  // remote browser, so this should be unreachable — it stays as the name of last resort,
  // because the alternative is what Destin actually saw: "terminal:get-screen-text isn't
  // available via remote access yet.", a channel id shown to someone who does not write code.
  ['terminal:', 'The terminal'],
  // Neither exists on the phone's own bridge (2026-09-10). Both are asked for
  // automatically — syncspaces:status on opening Settings or Project View,
  // transcript:page on every launch — so without a name the phone would greet
  // the user with a raw channel id. The shim refuses those two quietly on the
  // phone; the names are for the remaining, user-initiated calls in each family.
  ['syncspaces:', 'Syncing across your devices'],
  ['transcript:', 'Older messages'],
];

/** Which host refused: a desktop reached over remote access, or the phone's
 *  own bridge. The sentence has to say which, because "via remote access"
 *  read at somebody using no remote access is a lie about their setup. */
export type UnsupportedHost = 'remote' | 'phone';

/** Plain-language name for the feature a channel belongs to. Falls back to the
 *  raw channel so an unmapped namespace still says something specific. */
export function remoteFeatureName(channel: string): string {
  for (const [prefix, label] of FEATURE_NAMES) {
    if (channel.startsWith(prefix)) return label;
  }
  return channel;
}

export function remoteUnsupportedMessage(channel: string, host: UnsupportedHost = 'remote'): string {
  const where = host === 'phone' ? 'on the phone' : 'via remote access';
  return `${remoteFeatureName(channel)} isn't available ${where} yet.`;
}

/** Whether this channel has a plain-language name, or would show its own id to the user. */
export function hasFeatureName(channel: string): boolean {
  return FEATURE_NAMES.some(([prefix]) => channel.startsWith(prefix));
}
