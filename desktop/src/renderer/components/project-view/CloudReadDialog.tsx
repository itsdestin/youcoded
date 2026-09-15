import React, { useSyncExternalStore } from 'react';
import { CloudFileConsent } from './CloudFileConsent';
import type { CloudReadOptions, NeedsDownload } from '../../../shared/cloud-path-types';

type Pending = { detail: NeedsDownload; phase: 'ask' | 'waiting'; finish(value: any): void; read(options: CloudReadOptions): Promise<any> };
let pending: Pending | null = null;
const listeners = new Set<() => void>();
function publish() { for (const listener of listeners) listener(); }
function dismiss() {
  const old = pending; pending = null; publish();
  old?.finish({ ok: false, error: 'download-dismissed' });
}

/** Only full viewers call this. Thumbnails, inline HTML assets, and watchers keep
 * the backend's preview default. A dismissed/unmounted consumer never auto-opens. */
export async function readWithCloudConsent(read: (options: CloudReadOptions) => Promise<any>, cancelled: () => boolean): Promise<any> {
  const result = await read({ intent: 'explicit' });
  if (cancelled() || result?.error !== 'needs-download' || !result.operationToken) return result;
  if (pending) dismiss();
  return new Promise(resolve => {
    pending = { detail: result, phase: 'ask', finish: resolve, read };
    publish();
  });
}
export function dismissCloudRead() { dismiss(); }

export function CloudReadDialog() {
  const state = useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => pending);
  if (!state) return null;
  return <CloudFileConsent folder="" state={{ file: state.detail.path, purpose: 'file', phase: state.phase }} onAction={action => {
    if (action !== 'allow') { dismiss(); return; }
    // WHY: the exact token is sent only after this specific-file button. X drops
    // open intent but does not claim to cancel an OS/provider download in flight.
    const waiting = { ...state, phase: 'waiting' as const };
    pending = waiting; publish();
    void state.read({ intent: 'explicit', operationToken: state.detail.operationToken }).then(result => {
      if (pending !== waiting) return;
      pending = null; publish(); state.finish(result);
    }, () => {
      if (pending !== waiting) return;
      pending = null; publish(); state.finish({ ok: false, error: 'file-read-unavailable' });
    });
  }} />;
}
