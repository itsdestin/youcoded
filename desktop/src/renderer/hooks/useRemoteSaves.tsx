import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSaveNotice } from './useSaveNotice';

/**
 * The Remote access panel's two quick saves (Enabled switch, Keep awake) with "Couldn't save …" notices beside them (card #134).
 * `config` only changes after a save ANSWERS, so each control already shows the last value really saved; useSaveNotice adds the
 * lifecycle (a slow save says nothing, a late or superseded answer is ignored, cleared on success / Try again / closing the panel).
 * Lives here, not in SettingsPanel, to keep that file inside its line budget.
 */
export function useRemoteSaves<C extends { enabled?: boolean }>(
  open: boolean, config: C | null, setConfig: React.Dispatch<React.SetStateAction<C | null>>, setEnableError: (e: string) => void,
) {
  const { run, notice } = useSaveNotice(open);
  const configRef = useRef(config);
  configRef.current = config;
  const noSnap = () => { /* the control shows config, which did not change */ };

  const toggleEnabled = useCallback(async () => {
    const current = configRef.current;
    if (!current) return;
    setEnableError('');
    void run('enabled', 'the remote access setting', async () => {
      const updated = await (window as any).claude.remote.setConfig({ enabled: !current.enabled });
      // Main rolls `enabled` back to false when the server can't bind and returns the OS error; spreading `updated` un-sticks the toggle.
      if (updated?.error) setEnableError(String(updated.error));
      setConfig((prev) => (prev ? { ...prev, ...updated } : prev));
    }, noSnap, () => { void toggleEnabled(); });
  }, [run, setConfig, setEnableError]);

  const setKeepAwake = useCallback(async (hours: number) => {
    await run('keepAwake', 'the keep awake setting', async () => {
      const updated = await (window as any).claude.remote.setConfig({ keepAwakeHours: hours });
      setConfig((prev) => (prev ? { ...prev, ...updated } : prev));
    }, noSnap, () => { void setKeepAwake(hours); });
  }, [run, setConfig]);

  return { toggleEnabled, setKeepAwake, enabledNotice: notice('enabled', 'mt-1'), keepAwakeNotice: notice('keepAwake', 'mt-2') };
}

/** The password box's failure line: set when the save call itself failed, cleared on the next try, and when the panel closes. */
export function usePasswordFailed(open: boolean) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [open]);
  return [failed, setFailed] as const;
}
