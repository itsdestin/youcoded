import { useEffect } from 'react';
import { announceSettingsRepaired } from '../utils/settings-repair-notice';

// Renders nothing. Asks the app once at start-up whether it had to replace a damaged Claude Code settings
// file, and raises the heads-up toast if so (card #11 a). "Once" is the app's side: it hands the fact out a
// single time, so a reload or a second window does not repeat it.
// WHY not in the photo-only build: the practice backend has no repair to report, and the shoot build shows
// the toast on purpose through ToastPractice.
declare const __SHOOT__: boolean;

export default function SettingsRepairNotice() {
  useEffect(() => {
    if (typeof __SHOOT__ !== 'undefined' && __SHOOT__) return;
    const ask = (window as any).claude?.settings?.takeRepairNotice;
    if (typeof ask !== 'function') return;
    // A failed ask (an older host, a phone) is simply no notice; it must never raise an error of its own.
    Promise.resolve(ask()).then((n: { backupPath?: string } | null) => {
      if (n?.backupPath) announceSettingsRepaired(n.backupPath);
    }).catch(() => {});
  }, []);
  return null;
}
