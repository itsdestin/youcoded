// The buddy's windows (`shoot dev/buddy#…`): its chat at both sizes, with a question or an approval waiting, its empty
// New session screen, the whole group on a desktop, and the mascot in each mood.
// WHY (release comparison v1.3.3 -> now, 2026-11-07): the buddy chat was rebuilt to draw the main chat, and no catalog
// screen showed it. The buddy is its OWN Electron window, so it cannot open inside the app; the workbench already
// has pages for it (?view=buddy-chat / buddy-session / buddy-group, mockups/Buddy*.tsx). This frames one of those pages
// at the window's real size, so the picture is the shipping <BuddyChatApp/> and cannot drift from it.
// Photo-only build only (index.tsx; guarded by tests/shoot-build-guard.test.ts). Never ships.
import { useEffect, useRef, useState } from 'react';
import { MascotRig, type RigMotion } from '../../components/mascot/MascotRig';
import { MOOD_POSE, type MascotMood } from '../../components/buddy/mascot-mood';
import { CHAT_SIZE, CHAT_SIZE_LARGE } from '../../../shared/buddy-geometry';
import { ScreenMark, useScreenOpen } from '../../shoot-mode';

type Piece = { view: string; width: number; height: number; /** text that must be in the frame before it counts as drawn */ ready?: string; /** extra wait for a page that frames another page */ settleMs?: number; extra?: Record<string, string> };

const PIECES: Record<string, Piece> = {
  chat: { view: 'buddy-chat', ...CHAT_SIZE },
  'chat-large': { view: 'buddy-chat', ...CHAT_SIZE_LARGE },
  // A native session waiting on a two-part question: the buddy draws it as one question at a time.
  'chat-question': { view: 'buddy-chat', ...CHAT_SIZE, ready: 'Which color?', extra: { seed: 'bubbles-questions-native', buddySession: 'wb-2' } },
  'chat-question-large': { view: 'buddy-chat', ...CHAT_SIZE_LARGE, ready: 'Which color?', extra: { seed: 'bubbles-questions-native', buddySession: 'wb-2' } },
  // A command waiting for a yes or no.
  'chat-approval': { view: 'buddy-chat', ...CHAT_SIZE, ready: 'rm -rf', extra: { seed: 'bubbles-approval', buddySession: 'wb-2' } },
  // No session yet: the screen the buddy opens with (the practice app with no conversations).
  welcome: { view: 'buddy-chat', ...CHAT_SIZE, ready: 'New session', extra: { scenario: 'empty' } },
  // The whole buddy on a desktop: mascot, round buttons and chat.
  group: { view: 'buddy-group', width: 900, height: 680, settleMs: 5000 },
};

/** Waits until the frame's own page has drawn (the shipping window, not the loading screen), then lets the mark show. */
function Frame({ piece, onReady }: { piece: Piece; onReady: () => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const q = new URLSearchParams(location.search);
  // Every switch the shoot gave this page rides along (scenario, latency, theme), then this piece's own.
  q.set('view', piece.view);
  for (const [k, v] of Object.entries(piece.extra ?? {})) q.set(k, v);
  q.delete('buddy');
  // The theme the shoot applied rides along by name, so the group page's own chat frame (which reads ?theme) wears it too.
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme) q.set('theme', theme);
  useEffect(() => {
    let done = false;
    const t0 = performance.now();
    const id = setInterval(() => {
      const doc = ref.current?.contentDocument;
      const text = doc?.body?.innerText ?? '';
      const drawn = !!doc?.querySelector('.buddy-chat-shell, .buddy-bar-root, [data-mode="buddy-chat"] .header-bar, .buddy-welcome, button')
        && (!piece.ready || text.includes(piece.ready));
      if (!done && drawn) {
        done = true;
        clearInterval(id);
        // The conversation fills a moment after the shell; one more beat so the mark never beats the messages.
        setTimeout(onReady, piece.settleMs ?? 1200);
      }
      if (performance.now() - t0 > 20_000) clearInterval(id); // never marks: shoot then fails loudly with this screen's name
    }, 150);
    return () => clearInterval(id);
  }, [piece, onReady]);
  return <iframe ref={ref} title="Buddy window" src={`?${q.toString()}`}
    style={{ width: piece.width, height: piece.height, border: 0, display: 'block', background: 'transparent', colorScheme: 'normal' }} />;
}

// The mascot stands in the pose each mood draws (components/buddy/mascot-mood.ts MOOD_POSE), at his real 112px.
const MOODS: readonly MascotMood[] = ['idle', 'working', 'alert', 'done', 'sleep'];
function Moods() {
  const motionRef = useRef<RigMotion>({ vx: 0, vy: 0, dragging: false });
  return (
    <div className="flex gap-4 p-6 w-full h-full" style={{ background: 'linear-gradient(150deg, #5b6b8c 0%, #8e7aa8 55%, #c99a8a 100%)' }}>
      {MOODS.map((m) => (
        <div key={m} style={{ width: 112, height: 112 }} data-mood={m}>
          <MascotRig svgUrl={null} pose={MOOD_POSE[m]} motionRef={motionRef} reducedEffects={false} motionStyle={m === 'sleep' ? 'sleepy' : 'chill'} />
        </div>
      ))}
    </div>
  );
}

export default function BuddyPractice() {
  const [which, setWhich] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useScreenOpen('dev/buddy', () => { setReady(false); setWhich(new URLSearchParams(location.search).get('buddy') ?? 'chat'); });
  // Escape closes it like any layer (shoot --check presses it).
  useEffect(() => {
    if (which === null) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setWhich(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [which]);
  useEffect(() => {
    // The mascot sheet has no page to wait for; the springs need a moment to settle into each pose.
    if (which === 'moods') { const t = setTimeout(() => setReady(true), 1500); return () => clearTimeout(t); }
    return undefined;
  }, [which]);
  if (which === null) return null;
  const piece = PIECES[which];
  return (
    <div className="fixed inset-0 text-fg bg-canvas flex items-start" style={{ zIndex: 100000 }} role="dialog" aria-label="Buddy practice">
      {ready && <ScreenMark name="dev/buddy" />}
      {which === 'moods' ? <Moods /> : piece ? <Frame piece={piece} onReady={() => setReady(true)} /> : null}
    </div>
  );
}
