import type { ModelChoice } from '../model/ModelPicker';

export interface NamingPreferences { mode: 'off' | 'basic' | 'ai'; model: ModelChoice | null }
export interface NamingApi {
  /** Absent on desktop (always available). The remote shim sets it false until
   *  its capability probe answers, and leaves it false against a host with no
   *  naming backend — an Android phone running Claude Code locally. */
  available?: boolean;
  get(): Promise<NamingPreferences>;
  set(value: NamingPreferences): Promise<void>;
  title(id: string, fallback: string): Promise<{ title: string; manual: boolean }>;
  rename(id: string, title: string): Promise<void>;
}
// WHY an own-property check rather than a truthiness one: the bridge has a
// callable catch-all, so `window.claude.sessionNaming` answers "yes" for a host
// that has never heard of naming. Undefined here means every naming control —
// the settings card, the rename item, the pencil — renders nothing at all,
// which is the correct appearance where the feature has no backend.
export function namingApi(): NamingApi | undefined {
  if (!Object.prototype.hasOwnProperty.call(window.claude, 'sessionNaming')) return undefined;
  const api = (window.claude as unknown as { sessionNaming: NamingApi }).sessionNaming;
  return api.available === false ? undefined : api;
}
