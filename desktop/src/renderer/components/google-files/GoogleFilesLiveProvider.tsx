import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getCapabilities } from '../../platform';
import type { GoogleAccount, GoogleDriveFile } from '../../../shared/google-files-types';
import { GoogleFilesProvider, type GoogleFilesAdapter } from './google-files-context';
import { authorizeGoogleFiles } from './google-files-auth';
import type { GoogleFile } from './google-files-model';

function externalUrl(file: GoogleFile): string {
  // WHY: no arbitrary URLs from document contents or a model reach the shell.
  const resource = file.kind === 'Doc' ? 'document' : file.kind === 'Sheet' ? 'spreadsheets' : file.kind === 'Slides' ? 'presentation' : null;
  const url = new URL(resource ? `https://docs.google.com/${resource}/d/${encodeURIComponent(file.id)}/edit` : `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`);
  if (file.account.includes('@')) url.searchParams.set('authuser', file.account);
  return url.href;
}

/** Real transport only; workbench boot deliberately supplies its own fake provider. */
export function GoogleFilesLiveProvider({ children }: { children: React.ReactNode }) {
  const supported = getCapabilities().googleFiles;
  const [snapshot, setSnapshot] = useState<{ configured: boolean; accounts: GoogleAccount[]; files: GoogleDriveFile[] }>({ configured: false, accounts: [], files: [] });
  const [loadError, setLoadError] = useState('');
  const api = window.claude.googleFiles;
  const refresh = useCallback(async () => {
    const status = await api.status();
    const files = (await Promise.all(status.accounts.map((a) => api.files(a.id)))).flat();
    setSnapshot({ ...status, files }); setLoadError('');
    return status.accounts.map((a) => a.email || a.id);
  }, [api]);
  useEffect(() => {
    if (!supported) return;
    void refresh().catch(() => setLoadError('Couldn’t load your Google accounts.'));
  }, [supported, refresh]);
  const adapter = useMemo<GoogleFilesAdapter>(() => {
    const accountId = (label: string) => {
      const account = snapshot.accounts.find((a) => (a.email || a.id) === label);
      if (!account) throw new Error('This Google account is no longer connected.');
      return account.id;
    };
    return {
      configured: snapshot.configured, bridge: api, loadError,
      accounts: snapshot.accounts.map((a) => a.email || a.id), files: snapshot.files,
      changes: '',
      connect: async (signal) => { await authorizeGoogleFiles(api, undefined, signal); return refresh(); },
      pick: async (label, signal) => { const result = await authorizeGoogleFiles(api, accountId(label), signal); await refresh(); return result.files; },
      disconnect: async (label) => { await api.disconnect(accountId(label)); return refresh(); },
      // A real save must name a backend-held proposal; never send arbitrary caller-authored operations here.
      save: async () => { throw new Error('Choose a pending change to review before saving.'); },
      open: async (file) => { await window.claude.shell.openExternal(externalUrl(file)); },
    };
  }, [snapshot, api, loadError, refresh]);
  return supported ? <GoogleFilesProvider adapter={adapter}>{children}</GoogleFilesProvider> : <>{children}</>;
}
