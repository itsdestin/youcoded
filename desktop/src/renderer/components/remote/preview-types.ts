/**
 * Shapes the Remote Access mock preview speaks in. There is deliberately NO component
 * here: round-2 review rejected a bespoke panel, so every stage renders through the
 * existing Settings dialog's own setup banner (StatusStrip / Callout / ErrorState).
 */
export interface RemoteAccessView {
  /**
   * `consent` belongs to the OPTIONAL second level only. The default setup issues no
   * certificate, so nothing about this computer is published and there is nothing to
   * consent to (Destin, 2026-09-10).
   */
  stage: 'setup' | 'consent' | 'checking' | 'checked' | 'ready' | 'conflict' | 'error' | 'disabled';
  address: string;
  /**
   * The end-of-setup check's answer. `checked` renders through the SAME function the real
   * panel uses, not a preview lookalike — this stage was added after the decks, so there is
   * no approved mock wording for it to drift from, and a second copy of the words would be
   * one more thing to keep in step.
   */
  check?: { listening: boolean; address: string | null; reason: string | null };
  prerequisite?: 'not-installed' | 'sign-in-required' | 'ready';
  notice?: string;
  devices: { id: string; name: string; online: boolean }[];
  /** Whether the optional browser-encryption level is on. Off is the default and is a
   *  complete, working, encrypted setup — not a half-finished one. */
  browserEncryption?: 'off' | 'on';
}
export type RemoteAccessAction =
  | { type: 'consent' | 'check' | 'disable' | 'prerequisite' | 'report' | 'diagnose' | 'advanced' }
  | { type: 'revoke'; deviceId: string };
export interface RemoteAccessPreview {
  getView: () => RemoteAccessView;
  subscribe: (listener: () => void) => () => void;
  act: (action: RemoteAccessAction) => void;
}
