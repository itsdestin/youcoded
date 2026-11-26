// The two new phone notices (`shoot dev/toast#…`), raised through the app's own announce() so the real toast draws them.
// WHY a file of its own (phone-reliability review deck, 2026-10-22): both fire from deep inside the send and start-up code
// after a failure, so no click reaches them. The words come from the real code's exports, so the picture cannot drift.
// Photo-only build only (index.tsx). Never ships.
import { useEffect, useState } from 'react';
import { announce, announceFailed } from '../../utils/announce';
import { LOST_SEND_NOTICE } from '../../state/submit-outgoing';
import { savedPasswordRefusedNotice } from '../../remote-gate';
import { announcePluginTurnedOff } from '../../utils/plugin-off-notice';
import { announceSettingsRepaired } from '../../utils/settings-repair-notice';
import { announceSessionLost } from '../../utils/session-lost-notice';
import { useScreenOpen, ScreenMark } from '../../shoot-mode';
import { NOTICE_CATALOGUE } from './notice-catalogue';
import { showChatNotice, type ChatNotice } from '../../state/chat-notice-store';

// Waiting-notice deck round 4: the per-chat strip above the message box, with each kind's real words (`?strip=<which>`).
const noop = () => {};
const STRIPS: Record<string, ChatNotice> = {
  // K-1 held back: stays until the question is answered or you send.
  held: { key: 'held', tone: 'warn', leave: 'resolved', text: 'Claude Code is waiting on something — answer it first. Your message is still in the box.',
    actions: [{ label: 'Send anyway', onClick: noop }, { label: 'Show card', onClick: noop, primary: true }] },
  // K-3 can't be done now: leaves on your next action.
  cant: { key: 'cant', tone: 'warn', leave: 'next-action', text: "Can't compact while your assistant is still working. Stop the current turn, or wait for it to finish." },
  // K-4 failed before anything was sent: red dot, Try again.
  failed: { key: 'failed', tone: 'error', leave: 'next-action', text: "Couldn't run /review: two installed skills have that name (a:review, b:review).",
    actions: [{ label: 'Try again', onClick: noop, primary: true }] },
};

export default function ToastPractice() {
  const [shown, setShown] = useState(false);
  useScreenOpen('dev/toast', () => {
    const which = new URLSearchParams(location.search).get('toast');
    // Waiting-notice review deck: any notice from the catalogue, by id (`?toast=n:<id>`), held on screen for the picture.
    const strip = new URLSearchParams(location.search).get('strip');
    if (strip && STRIPS[strip]) { showChatNotice('wb-1', STRIPS[strip]); setShown(true); return; }
    // K-7 (needs you, app-wide): stays until closed, outlined Dismiss left, its own button filled right (`?toast=k7:<id>`).
    const heads = which?.startsWith('k7:') ? NOTICE_CATALOGUE.find((n) => n.id === which.slice(3)) : undefined;
    if (heads) { announce(heads.text, undefined, heads.button ? { label: heads.button, onClick: () => {} } : undefined, { untilClosed: true }); setShown(true); return; }
    const listed = which?.startsWith('n:') ? NOTICE_CATALOGUE.find((n) => n.id === which.slice(2)) : undefined;
    // A notice that now lives in the chat's strip is raised there (the practice chat `wb-1`), exactly as the real code raises it;
    // one that stays floating keeps announce(), and one that stays until closed shows with its button.
    if (listed?.strip) {
      showChatNotice('wb-1', {
        key: listed.id, text: listed.text, tone: listed.strip.tone, leave: listed.strip.leave,
        actions: listed.strip.buttons.map((label, i, all) => ({ label, onClick: noop, primary: i === all.length - 1 })),
      });
    } else if (listed?.untilClosed) announce(listed.text, undefined, listed.button ? { label: listed.button, onClick: () => {} } : undefined, { untilClosed: true });
    else if (listed) announce(listed.text, 60_000, listed.button ? { label: listed.button, onClick: () => {} } : undefined);
    else if (which === 'turned-off') announcePluginTurnedOff(60_000);
    else if (which === 'none') { /* the same screen with no notice: the "Before" picture for card #216 */ }
    else if (which === 'settings-repaired') announceSettingsRepaired('/home/me/.claude/settings.json.corrupt-2026-11-12T04-30-00-000Z', 60_000); // card #11 a
    else if (which === 'action-failed') announceFailed('copy the path'); // card #134 round 4
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
