// The saved new-session defaults (default model, project folder, skip-permissions, and the
// cross-provider start model) as this window should show them.
//
// Read on mount, whenever the Settings panel opens or closes, after a remote reconnect (one
// read lost during a drop left the new-session forms without the default project and model —
// 2026-09-11 phone pass sweep), and whenever this window regains focus.
//
// WHY focus (user-interface roadmap: "A second window keeps showing the old default model or
// project folder until its own Settings panel is opened and closed"): each window loaded the
// defaults for itself and only re-read them around ITS OWN Settings panel, so a default saved
// in one window never reached another. Nothing announces a save across windows; switching to a
// window is the moment its user can next start a session, so that is when it asks again. One
// small file read per focus. A phone's browser tab gets the same behaviour when it is brought
// back to the front.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOnRemoteReconnect } from './useOnRemoteReconnect';
import type { ModelChoice } from '../components/model/ModelPicker';

// `startModel` is the saved default across EVERY provider (Assistant settings, Q-3a). The
// inferred shape had only the Claude alias, which is exactly why the setting was written,
// read back, and then ignored by every form that starts a conversation (contract R5).
export interface SessionDefaults {
  skipPermissions: boolean;
  model: string;
  projectFolder: string;
  startModel?: ModelChoice;
  startModelLabel?: { provider: string; model: string };
}

const INITIAL: SessionDefaults = { skipPermissions: false, model: 'sonnet', projectFolder: '' };

export function useSessionDefaults(settingsOpen: boolean): SessionDefaults {
  const [defaults, setDefaults] = useState<SessionDefaults>(INITIAL);
  const shownJson = useRef(JSON.stringify(INITIAL));
  // A failed read keeps what is shown: an unknown answer is not "no defaults".
  const load = useCallback(() => {
    (window as any).claude?.defaults?.get?.().then((defs: any) => {
      // Only a real change is stored. WHY: this runs on every window focus, and a fresh
      // object with the same values would redraw the whole app on each switch back to it.
      // The file is a few small JSON fields, so comparing their JSON is exact and cheap.
      if (!defs) return;
      const json = JSON.stringify(defs);
      if (json === shownJson.current) return;
      shownJson.current = json;
      setDefaults(defs);
    }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [settingsOpen, load]);
  useOnRemoteReconnect(load);
  useEffect(() => {
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);
  return defaults;
}
