import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { GoogleFilesBridge } from '../../../shared/google-files-channels';
import type { GoogleFile, GoogleSaveTarget } from './google-files-model';

/** Props-only seam for the design-stage workbench. No backend or preload contract yet. */
export interface GoogleFilesAdapter {
  accounts: string[];
  files: GoogleFile[];
  state?: 'ready' | 'error' | 'reconnect';
  attached?: GoogleFile[];
  connect: (signal: AbortSignal) => Promise<string[]>;
  pick: (account: string, signal: AbortSignal) => Promise<GoogleFile[]>;
  changes: string;
  reviewFile?: GoogleFile;
  save: (target: GoogleSaveTarget) => Promise<GoogleFile | void>;
  open: (file: GoogleFile) => Promise<void>;
  disconnect?: (account: string) => Promise<string[]>;
  bridge?: GoogleFilesBridge;
  configured?: boolean;
  loadError?: string;
}
interface GoogleFilesContextValue {
  adapter: GoogleFilesAdapter;
  accounts: string[];
  files: GoogleFile[];
  setAccounts: React.Dispatch<React.SetStateAction<string[]>>;
  remember: (files: GoogleFile[]) => void;
}
const Context = createContext<GoogleFilesContextValue | null>(null);
export const useGoogleFiles = () => useContext(Context);
export function GoogleFilesProvider({ adapter, children }: { adapter: GoogleFilesAdapter; children: React.ReactNode }) {
  const [accounts, setAccounts] = useState(adapter.accounts);
  const [files, setFiles] = useState(adapter.files);
  // WHY: real account/metadata loads arrive asynchronously; fake adapters remain stable.
  useEffect(() => { setAccounts(adapter.accounts); setFiles(adapter.files); }, [adapter.accounts, adapter.files]);
  const value = useMemo(() => ({ adapter, accounts, files, setAccounts,
    remember: (added: GoogleFile[]) => setFiles((old) => [...old.filter((f) => !added.some((a) => a.id === f.id && a.account === f.account)), ...added]),
  }), [adapter, accounts, files]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
