import React from 'react';
import { GoogleFilesProvider, type GoogleFilesAdapter } from '../../../components/google-files/google-files-context';
import type { GoogleFile } from '../../../components/google-files/google-files-model';

const ACCOUNTS = ['alex@example.com', 'alex@studio.example'];
const FILES: GoogleFile[] = [
  { id: 'launch', name: 'Launch brief', kind: 'Doc', account: ACCOUNTS[0] },
  { id: 'budget', name: 'Budget', kind: 'Sheet', account: ACCOUNTS[0] },
  { id: 'pitch', name: 'Pitch deck', kind: 'Slides', account: ACCOUNTS[1] },
];
function pause(signal: AbortSignal, hold: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, hold ? 120_000 : 1800);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export function GoogleFilesWorkbench({ children }: { children: React.ReactNode }) {
  const [adapter] = React.useState<GoogleFilesAdapter>(() => {
    const params = new URLSearchParams(location.search);
    const scene = params.get('googleState');
    let fail = scene === 'error';
    return {
      accounts: scene === 'disconnected' ? [] : ACCOUNTS,
      files: scene === 'empty' ? [] : scene === 'stress' ? Array.from({ length: 1000 }, (_, i) => ({ ...FILES[0], id: `brief-${i}`, name: `Launch brief ${i + 1}` })) : FILES,
      state: scene === 'error' ? 'error' : scene === 'reconnect' ? 'reconnect' : 'ready',
      attached: scene === 'attached' ? [FILES[0]] : [],
      connect: async (signal) => { await pause(signal, scene === 'waiting'); return ACCOUNTS; },
      pick: async (account, signal) => { await pause(signal, scene === 'waiting'); return FILES.filter((f) => f.account === account); },
      changes: 'Updated the introduction and added the launch checklist.',
      reviewFile: FILES[0],
      save: async (target) => {
        if (fail) { fail = false; throw new Error('Save unavailable'); }
        const file = FILES.find((f) => f.id === target.fileId && f.account === target.account);
        if (!file) throw new Error('Selected file unavailable');
        return target.mode === 'copy' ? { ...file, id: `${file.id}-copy`, name: `${file.name} (copy)` } : file;
      },
      // WHY: the visual-stage transport simulates the normal external-browser handoff.
      // No Google URL, embedded webpage, assistant browser or live network is opened.
      open: async () => {},
    };
  });
  return <GoogleFilesProvider adapter={adapter}>{children}</GoogleFilesProvider>;
}
