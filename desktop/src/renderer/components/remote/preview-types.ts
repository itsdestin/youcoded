/**
 * Shapes the Remote Access mock preview speaks in. There is deliberately NO component
 * here: round-2 review rejected a bespoke panel, so every stage renders through the
 * existing Settings dialog's own setup banner (StatusStrip / Callout / ErrorState).
 */
export interface RemoteAccessView {
  stage: 'setup' | 'consent' | 'checking' | 'ready' | 'conflict' | 'error' | 'disabled';
  address: string;
  prerequisite?: 'not-installed' | 'sign-in-required' | 'ready';
  notice?: string;
  devices: { id: string; name: string; online: boolean }[];
}
export type RemoteAccessAction =
  | { type: 'consent' | 'check' | 'disable' | 'prerequisite' | 'report' | 'diagnose' }
  | { type: 'revoke'; deviceId: string };
export interface RemoteAccessPreview {
  getView: () => RemoteAccessView;
  subscribe: (listener: () => void) => () => void;
  act: (action: RemoteAccessAction) => void;
}
