// Voice prompting — the mic in the composer, and the small card behind it.
//
// Four looks, one button (deck 2026-09-05, docs/active/design/2026-09-05-voice-prompting/):
//   idle       a ghost icon like Attach and Skills — tap to talk
//   listening  the button fills with accent and breathes a ring (globals.css
//              `.voice-mic-on`); a four-bar loudness meter and the elapsed time
//              sit to its left so you know it is still hearing you (Q-3: "an
//              obvious glowing state and a Stop are essential")
//   finishing  a spinner for the beat between the mic closing and the last
//              words settling
//   card       when the engine is not ready the tap opens a card ABOVE the mic.
//              Five things that card can say, in the order they are decided:
//                needs-download  the one-time offer — what dictation does, that
//                                the voice never leaves this computer (Q-5),
//                                which languages it understands (V-11) and the
//                                size (V-10). If a download FAILED, this same
//                                card carries the computer's own reason and its
//                                Download button becomes Retry (R3-6).
//                error           "Voice stopped" — a microphone that was open
//                                and died. Never shown for a failed download.
//                downloading     a real progress bar over the bytes.
//                unpacking       "Almost ready…" and a bar that moves without
//                                measuring anything (V-12).
//                unavailable     no microphone, or the computer refused — the
//                                real reason and one Check again.
//
// The card is positioned the way AnchorTip positions its bubble — a portaled
// OverlayPanel at layer 4, measured from the trigger — rather than reusing
// AnchorTip, whose trigger is its own ⓘ glyph. Overlay.tsx stays the only
// z-index authority.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui/Button';
import { ProgressBar } from './ui/ProgressBar';
import { OverlayPanel } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import { MicIcon } from './Icons';
import type { VoiceReadiness } from '../../shared/voice-types';
import type { VoicePhase } from '../hooks/useVoiceInput';
import { Tooltip } from './ui';

/** Round-2 alternatives (review deck 2026-09-05, V-1: "alternatives for the
 *  counter/feedback location and styling, and the animation on the mic icon").
 *  `feedback` is where the meter and clock live while listening; `motion` is
 *  how the button itself moves. The defaults are what ships; the compare view
 *  provides the others through VoiceStyleContext so all three sit side by side
 *  against the same fake. When Destin picks, the default changes and the
 *  losers stay renderable (the registry keeps every round). */
export interface VoiceStyle {
  feedback: 'beside' | 'strip' | 'placeholder';
  motion: 'breathe' | 'level' | 'dot';
}
// Round 2 picks (2026-09-05): V-4 strip, V-5 level ("make the max size a tad smaller tho").
export const DEFAULT_VOICE_STYLE: VoiceStyle = { feedback: 'strip', motion: 'level' };
export const VoiceStyleContext = createContext<VoiceStyle>(DEFAULT_VOICE_STYLE);

interface Props {
  phase: VoicePhase;
  readiness: VoiceReadiness | null;
  level: number;
  seconds: number;
  error: string | null;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
  onDownload: () => void;
  onRecheck: () => void;
  onClearError: () => void;
  /** Fired once when a download completes — the input bar toasts "Voice is ready". */
  onReady?: () => void;
}

/** Four bars whose height follows the microphone level, plus m:ss elapsed. */
export function VoiceMeter({ level, seconds }: { level: number; seconds: number }) {
  // Each bar wakes up at a higher level so quiet speech still moves the first
  // one and only a loud moment lights all four.
  const heights = [0.15, 0.35, 0.6, 0.85].map((gate) => {
    const t = Math.max(0, Math.min(1, (level - gate * 0.6) / 0.5));
    return 4 + Math.round(t * 10);
  });
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  return (
    <span className="flex items-center gap-1.5 text-2xs text-fg-muted tabular-nums select-none" aria-live="off">
      <span className="flex items-end gap-0.5 h-3.5" aria-hidden="true">
        {heights.map((h, i) => (
          <span key={i} className="voice-bar w-0.5 rounded-full bg-accent" style={{ height: `${h}px` }} />
        ))}
      </span>
      <span>{mm}:{ss}</span>
    </span>
  );
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" />
    </svg>
  );
}

export function VoiceButton({ phase, readiness, level, seconds, error, disabled, onStart, onStop, onDownload, onRecheck, onClearError, onReady }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasDownloading = useRef(false);

  const listening = phase === 'listening';
  const state = readiness?.state ?? 'unavailable';
  const style = useContext(VoiceStyleContext);
  // Motion B (picked): the ring IS the meter — an inline shadow sized by the level,
  // no keyframes at all, so it only repaints when a level event arrives. 2 to 9 px:
  // round 2 showed 2 to 12 and Destin asked for the biggest a tad smaller.
  const levelRing = listening && style.motion === 'level'
    // steps(3), not linear (whole-branch review F3): this transition retriggers on
    // every level event — ten a second, for as long as the mic is open — so a
    // linear one presents a frame at the display's full refresh rate throughout.
    // That is the exact shape the 2026-07-30 idle-CPU investigation measured at
    // ~30% of a core at 180 Hz, and its conclusion was that the only lever that
    // works is presenting fewer frames. Pinned by tests/animation-frame-budget.test.ts.
    ? { boxShadow: `0 0 0 ${2 + Math.round(level * 7)}px color-mix(in srgb, var(--accent) 35%, transparent)`, transition: 'box-shadow 90ms steps(3)' }
    : undefined;

  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // The mic lives at the composer's right edge, so a card centred on it would
    // run off the window. Hang the card's RIGHT edge from the mic's right edge
    // instead (translate(-100%, -100%) below): it grows leftward, over the box.
    setPos({ x: r.right, y: r.top - 8 });
  }, []);

  useEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, measure]);

  useEscClose(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [open]);

  // The download finished: close the card and let the input bar say so.
  useEffect(() => {
    if (state === 'downloading') wasDownloading.current = true;
    if (state === 'ready' && wasDownloading.current) {
      wasDownloading.current = false;
      setOpen(false);
      onReady?.();
    }
  }, [state, onReady]);

  // An error while listening opens the card so the message is read, not lost.
  useEffect(() => { if (error) setOpen(true); }, [error]);

  const handleClick = () => {
    if (error) { setOpen((v) => !v); return; }
    if (state === 'ready') {
      if (listening) onStop(); else onStart();
      return;
    }
    setOpen((v) => !v);
  };

  // A failure reported while the engine is still not on this computer can only
  // have come from the DOWNLOAD — the microphone was never open, so the "Voice
  // stopped" card (which is about a mic that was working and then died) would be
  // a lie. The service hands the card back to its offer state and puts the real
  // reason on the rejection (voice-service.ts `download()`), so this branch is
  // the offer card it interrupted, plus that reason, plus a Retry.
  const downloadFailed = !!error && state === 'needs-download';

  const label = downloadFailed ? 'Voice download failed — see why'
    : error ? 'Voice stopped — see why'
    : listening ? 'Stop listening'
    : phase === 'finishing' ? 'Finishing…'
    : state === 'ready' ? 'Speak your message'
    : state === 'downloading' ? 'Voice is downloading'
    : state === 'unpacking' ? 'Voice is almost ready'
    : state === 'needs-download' ? 'Speak your message (one-time download)'
    : "Voice isn't available";

  let card: React.ReactNode = null;
  if (state === 'needs-download' && readiness?.state === 'needs-download') {
    card = (
      <>
        <p className="text-xs font-semibold text-fg mb-1.5">Speak your messages</p>
        <p className="text-2xs text-fg-2 leading-snug">
          Tap the mic, talk, and your words appear here with punctuation, ready to fix or send.
          Your voice is turned into text on this computer and never leaves it.
        </p>
        {/* The limit, said BEFORE half a gigabyte is fetched rather than after
            (reopen deck V-11): someone who speaks a language it cannot hear
            deserves to find out first. */}
        <p className="text-2xs text-fg-2 leading-snug mt-2">Understands English and 24 other European languages.</p>
        {/* Written out, not computed from `sizeMb`, so the sentence a person
            reads never shifts by a few MB when the engine pin moves. It was
            "about 500 MB" (reopen deck V-10), which was the compressed archive
            plus its runtime; the model now arrives as its four plain files
            instead, because unpacking the archive needed a program the app does
            not ship and could not be tested on Windows or macOS from here. That
            costs 175 MB more and removes the wait to unpack it. */}
        <p className="text-2xs text-fg-muted mt-2">One-time download: about 650 MB.</p>
        {downloadFailed && (
          // The computer's OWN words, never a guess about the network —
          // docs/error-message-standards.md.
          <p className="text-2xs text-fg-2 leading-snug mt-2 whitespace-pre-line">{error}</p>
        )}
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="ghost" size="sm" onClick={() => { onClearError(); setOpen(false); }}>Not now</Button>
          <Button variant="primary" size="sm" onClick={onDownload}>{downloadFailed ? 'Retry' : 'Download'}</Button>
        </div>
      </>
    );
  } else if (state === 'unavailable') {
    // BEFORE the error branch. WHY: when the microphone is unavailable AND something
    // also errored (tapping Check again on a machine with no mic while the host itself
    // fails), the error card's lone OK button replaced the Check again the user needs —
    // the one affordance that lets them come back after plugging a mic in. Unavailable
    // is the more useful of the two truths. Found reviewing T9, 2026-09-05.
    card = (
      <>
        <p className="text-xs font-semibold text-fg mb-1.5">Voice isn&rsquo;t available</p>
        <p className="text-2xs text-fg-2 leading-snug">{readiness?.state === 'unavailable' ? readiness.reason : 'Still checking whether this computer can listen.'}</p>
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="ghost" size="sm" onClick={onRecheck}>Check again</Button>
        </div>
      </>
    );
  } else if (error) {
    card = (
      <>
        <p className="text-xs font-semibold text-fg mb-1.5">Voice stopped</p>
        <p className="text-2xs text-fg-2 leading-snug">{error}</p>
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="ghost" size="sm" onClick={() => { onClearError(); setOpen(false); }}>OK</Button>
        </div>
      </>
    );
  } else if (state === 'downloading' && readiness?.state === 'downloading') {
    card = (
      <>
        <p className="text-xs font-semibold text-fg mb-1.5">Getting voice ready</p>
        <ProgressBar percent={readiness.percent} showLabel aria-label="Voice download" />
        <p className="text-2xs text-fg-muted mt-2">About 650 MB, once. You can keep typing; the mic wakes up when it is done.</p>
      </>
    );
  } else if (state === 'unpacking') {
    // The download has landed and is being expanded — tens of seconds on a slow
    // machine. Without this branch the card would VANISH for that whole minute
    // and the app would look finished, or stuck. There is no percentage worth
    // showing here (nothing reports one), so the bar moves without measuring
    // anything — the same sweeping track the model loader uses for its own
    // unmeasured wait, which Reduced Effects already knows how to still.
    // "Almost ready…" is the wording Destin picked over "Unpacking…" (reopen V-12).
    card = (
      <>
        <p className="text-xs font-semibold text-fg mb-1.5">Almost ready&hellip;</p>
        <div className="model-load-track h-1.5 rounded-full bg-inset" role="progressbar" aria-label="Getting voice ready" />
        <p className="text-2xs text-fg-muted mt-2">You can keep typing; the mic wakes up when it is done.</p>
      </>
    );
  }

  return (
    <div className="relative shrink-0 flex items-center gap-2">
      {listening && style.feedback === 'beside' && <VoiceMeter level={level} seconds={seconds} />}
      <Tooltip text={label}>
      <Button
        ref={triggerRef}
        type="button"
        variant={listening ? 'primary' : 'ghost'}
        size="icon"
        aria-label={label}
        aria-pressed={listening}
        aria-expanded={open || undefined}
        disabled={disabled || phase === 'finishing'}
        onClick={handleClick}
        className={`relative rounded-full ${listening && style.motion === 'breathe' ? 'voice-mic-on' : ''}`}
        style={levelRing}
      >
        {phase === 'finishing' ? <Spinner /> : <MicIcon className="w-4 h-4" />}
        {/* Motion C: a recorder's blinking dot on the button's corner. Red is the
            one colour every recorder has taught people; stepped so it presents
            two frames a cycle, not 180. */}
        {listening && style.motion === 'dot' && (
          <span aria-hidden="true" className="voice-rec-dot absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-canvas" />
        )}
      </Button>
      </Tooltip>
      {open && card &&
        createPortal(
          <OverlayPanel
            ref={panelRef}
            layer={4}
            role="dialog"
            aria-label="Voice"
            className="fixed p-3 text-left w-72 max-w-[calc(100vw-1.5rem)]"
            style={{ left: pos.x, top: pos.y, transform: 'translate(-100%, -100%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {card}
          </OverlayPanel>,
          document.body,
        )}
    </div>
  );
}

