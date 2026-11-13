// The two new phone notices (`shoot dev/toast#…`), raised through the app's own announce() so the real toast draws them.
// WHY a file of its own (phone-reliability review deck, 2026-10-22): both fire from deep inside the send and start-up code
// after a failure, so no click reaches them. The words come from the real code's exports, so the picture cannot drift.
// Photo-only build only (index.tsx). Never ships.
import { useEffect, useState } from 'react';
import { announce } from '../../utils/announce';
import { LOST_SEND_NOTICE } from '../../state/submit-outgoing';
import { savedPasswordRefusedNotice } from '../../remote-gate';
import { announcePluginTurnedOff } from '../../utils/plugin-off-notice';
import { announceSettingsRepaired } from '../../utils/settings-repair-notice';
import { announceSessionLost } from '../../utils/session-lost-notice';
import { useScreenOpen, ScreenMark } from '../../shoot-mode';

export default function ToastPractice() {
  const [shown, setShown] = useState(false);
  useScreenOpen('dev/toast', () => {
    const which = new URLSearchParams(location.search).get('toast');
    if (which === 'turned-off') announcePluginTurnedOff(60_000);
    else if (which === 'none') { /* the same screen with no notice: the "Before" picture for card #216 */ }
    else if (which === 'settings-repaired') announceSettingsRepaired('/home/me/.claude/settings.json.corrupt-2026-11-12T04-30-00-000Z', 60_000); // card #11 a
    else if (which === 'signed-out') announceSessionLost(() => {}, 60_000); // card #216
    else announce(which === 'password' ? savedPasswordRefusedNotice('Home PC') : LOST_SEND_NOTICE, 60_000);
    setShown(true);
  });
  // Escape closes the marker like any layer (shoot --check presses it).
  useEffect(() => {
    if (!shown) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setShown(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shown]);
  if (!shown) return null;
  // A small see-through square in the corner stands for the mark (the toast itself is drawn by App, which has no mark to give).
  return (
    <div className="fixed left-0 top-0" style={{ width: 12, height: 12, zIndex: 100000 }} role="dialog" aria-label="Notice practice">
      <ScreenMark name="dev/toast" />
    </div>
  );
}
