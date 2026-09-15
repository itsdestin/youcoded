import React, { useEffect, useRef } from 'react';
import { Button, Dialog, StatusStrip } from '../ui';
import { useEscClose } from '../../hooks/use-esc-close';

export interface CloudConsentState {
  phase: 'ask' | 'denied' | 'waiting';
  purpose: 'file' | 'instructions';
  file: string | null;
  additionalFiles?: string[];
  suppressAutoOpen?: boolean;
}
export type CloudConsentAction = 'allow' | 'deny' | 'review' | 'suppress-auto-open';
export interface CloudConsentPreview {
  initial: CloudConsentState;
  provider?: 'OneDrive';
  availability: (path: string) => 'local' | 'cloud' | 'unknown';
  openConversation?: (folder: string) => void;
  folder?: string;
}

// WHY: permission alone must not pose as a request to download the whole folder.
// This is presentation state only; no file I/O or permission persistence lives here.
export function cloudConsentTransition(state: CloudConsentState, action: CloudConsentAction): CloudConsentState {
  // WHY: dismissal revokes file-open intent, not the authorized download or conversation continuation.
  if (action === 'suppress-auto-open') return state.purpose === 'file' && state.phase === 'waiting'
    ? { ...state, suppressAutoOpen: true } : state;
  return { ...state, phase: action === 'deny' ? 'denied' : action === 'review' ? 'ask' : state.file ? 'waiting' : 'ask' };
}

// WHY: approval covers only this operation, never later file selections.
export function cloudConsentSelect(state: CloudConsentState, file: string, purpose: CloudConsentState['purpose'] = 'file'): CloudConsentState {
  if (state.file === file && state.purpose === purpose && state.phase !== 'denied') {
    // WHY: a new explicit click restores open intent for the pending operation without re-authorizing it.
    return purpose === 'file' && state.phase === 'waiting' ? { ...state, suppressAutoOpen: false } : state;
  }
  return { phase: 'ask', purpose, file };
}

/** Shared presentation for the production operation service and workbench examples.
 * WHY: the backend owns authorization; this component only presents exact scope. */
export function CloudFileConsent({ provider, state, onAction }: {
  folder: string;
  provider?: 'OneDrive';
  state: CloudConsentState;
  onAction: (action: CloudConsentAction) => void;
}) {
  const modalOpen = state.purpose === 'file' && !!state.file && state.phase !== 'denied'
    && !(state.phase === 'waiting' && state.suppressAutoOpen);
  const panel = useRef<HTMLDivElement>(null);
  const dismiss = () => onAction(state.phase === 'waiting' ? 'suppress-auto-open' : 'deny');
  useEscClose(modalOpen, dismiss);
  useEffect(() => {
    if (!modalOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const root = panel.current;
    const buttons = () => Array.from(root?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex="0"]') ?? []);
    buttons()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = buttons();
      const next = event.shiftKey ? items.at(-1) : items[0];
      if (document.activeElement === (event.shiftKey ? items[0] : items.at(-1)) || !root?.contains(document.activeElement)) {
        event.preventDefault(); next?.focus();
      }
    };
    document.addEventListener('keydown', trap, true);
    return () => { document.removeEventListener('keydown', trap, true); if (previous?.isConnected) previous.focus(); };
  }, [modalOpen]);
  // WHY: browsing is metadata-only. Only a
  // selected substantive operation may ask or wait; never ask just for previews.
  if (!state.file) return null;
  const waiting = state.phase === 'waiting';
  const ask = state.phase === 'ask';
  const instructions = state.purpose === 'instructions';
  if (state.phase === 'denied' && !instructions) return null;
  const files = [state.file, ...(state.additionalFiles ?? [])];
  const title = waiting ? (provider ? 'Waiting for OneDrive' : 'Waiting for the file')
    : instructions ? 'Download instructions to start this conversation?'
    : files.length > 1 ? 'Download these files?' : 'Download this file?';
  if (!instructions) return (
    <Dialog open={modalOpen} onClose={dismiss} panelRef={panel} title={title} size="panel">
      <div data-testid="cloud-file-consent" className="space-y-4">
        {waiting ? <StatusStrip tone="busy">
          <span className="block text-sm text-fg break-all">{files.join(', ')}</span>
          {/* WHY: shown only after the specific operation's Allow action dispatches its read. */}
          <span className="block text-sm text-fg-2">Downloading file. You may wait or leave this page.</span>
        </StatusStrip> : <>
          {/* WHY: Dialog headers truncate; the exact approval scope must wrap in the body. */}
          <div className="space-y-1">{files.map((file) => <p key={file} className="text-sm text-fg break-all">{file}</p>)}</div>
          <p className="text-sm text-fg-2">{provider
            ? files.length > 1 ? 'These files are stored only on OneDrive and need to download before you can open them.' : 'This file is stored only on OneDrive and needs to download before you can open it.'
            : files.length > 1 ? 'These files may need to download before YouCoded can open them.' : 'This file may need to download before YouCoded can open it.'}</p>
        </>}
        {!waiting && <div className="flex justify-end gap-2 flex-wrap">
          <Button variant="secondary" onClick={dismiss}>Not now</Button>
          <Button variant="primary" onClick={() => onAction('allow')}>Download and open</Button>
        </div>}
      </div>
    </Dialog>
  );
  return (
    <section aria-label="Cloud file access" data-testid="cloud-file-consent">
      <StatusStrip tone={waiting ? 'busy' : ask ? 'warn' : 'idle'}
        action={waiting ? undefined : <span className="flex gap-2 flex-wrap">
          {ask ? <>
            <Button variant="secondary" onClick={() => onAction('deny')}>Not now</Button>
            <Button variant="primary" onClick={() => onAction('allow')}>Download and continue</Button>
          </> : <Button variant="secondary" onClick={() => onAction('review')}>Review download</Button>}
        </span>}>
        <span className="block text-sm font-medium text-fg break-words">{waiting ? title : state.phase === 'denied' ? 'This conversation still needs its instructions.' : 'Download'} · {files.join(', ')}</span>
        <span className="block text-sm text-fg-2">{waiting ? 'Your conversation will start when its instructions are ready.' : provider
          ? 'This conversation requires project instructions stored only in your OneDrive.'
          : 'This conversation requires project instructions that may need downloading.'}</span>
      </StatusStrip>
    </section>
  );
}
