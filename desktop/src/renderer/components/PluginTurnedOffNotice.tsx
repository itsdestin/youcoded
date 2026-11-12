import { useEffect } from 'react';
import { useSkills } from '../state/skill-context';
import { announcePluginTurnedOff } from '../utils/plugin-off-notice';

// Renders nothing. Raises the heads-up toast once per newly turned-off plugin.
// WHY localStorage: "once" must survive a relaunch, or the toast would repeat every start.
// WHY not in the photo-only build: the practice installed list always holds a turned-off
// plugin, so every picture of every screen would carry the toast (ToastPractice shows it on purpose).
declare const __SHOOT__: boolean;
const KEY = 'youcoded-plugin-off-notified';

export default function PluginTurnedOffNotice() {
  const { installed } = useSkills();
  useEffect(() => {
    if (typeof __SHOOT__ !== 'undefined' && __SHOOT__) return;
    const off = installed.filter((s) => s.blocked).map((s) => s.pluginName ?? s.id);
    if (off.length === 0) return;
    let seen: string[] = [];
    try { seen = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { /* private window: say it again rather than never */ }
    const fresh = off.filter((id) => !seen.includes(id));
    if (fresh.length === 0) return;
    announcePluginTurnedOff();
    try { localStorage.setItem(KEY, JSON.stringify([...new Set([...seen, ...off])])); } catch { /* ignore */ }
  }, [installed]);
  return null;
}
