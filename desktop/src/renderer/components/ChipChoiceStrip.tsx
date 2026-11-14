import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { QuickChip } from './QuickChips';
import { Button, CloseButton } from './ui';
import { useEscClose } from '../hooks/use-esc-close';
import { useScreenOpen, ScreenMark } from '../shoot-mode';

// The slim strip above the message box that asks what a quick chip should do when the box already has words (card #143 c; Destin
// picked this design, "strip above box", on the round-3 deck, step R3-9, after seeing it beside two others).
// Same surface and slot as the waiting-message strip (QueuedMessagesStrip). The typed words are NOT touched while this shows: the
// parent applies the answer. The draft text itself stays in InputBar (performance rule 5); this only asks.
//
// WHY keyboard: Escape closes it (the app's central Escape stack, so it never competes with another layer), and focus moves to
// "Add to end", the answer that cannot lose words — never to Replace, so a stray Enter cannot throw the draft away.
function ChipChoiceStrip({ onReplace, onAdd, onClose, focusAdd }: { onReplace: () => void; onAdd: () => void; onClose: () => void; focusAdd: boolean }) {
  // WHY notPopup (review): registered as a popup, the strip made the message box and the chat's permission / question cards stand down
  // on Enter while it was open, so a waiting card could not be answered. It takes Escape but covers nothing (the guided tour's bubble
  // is the same case, use-esc-close.tsx F40).
  useEscClose(true, onClose, { notPopup: true });
  const addRef = useRef<HTMLButtonElement>(null);
  // WHY not on touch (review): focusing a button blurs the message box and drops the phone's on-screen keyboard. A tap leaves focus
  // where it is; keyboard and mouse still land on "Add to end".
  useEffect(() => { if (focusAdd) addRef.current?.focus(); }, [focusAdd]);
  return (
    // WHY Enter stops here: with focus on a strip button, Enter must press THAT button. A card's window-level Enter handler would
    // otherwise answer the same key press (and cancel the button's own click by preventing the key's default).
    <div className="px-2 sm:px-3 pb-1.5" data-chip-choice-strip role="group" aria-label="What should the quick chip do?"
      onKeyDown={(e) => { if (e.key === 'Enter') e.stopPropagation(); }}>
      <div className="layer-surface flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl px-3 py-2 shadow-lg">
        <div className="text-3xs text-fg-muted select-none shrink-0">You have words in the box</div>
        <div className="flex items-center gap-2 ml-auto">
          <Button ref={addRef} variant="secondary" size="sm" onClick={onAdd}>Add to end</Button>
          <Button variant="primary" size="sm" onClick={onReplace}>Replace</Button>
          <CloseButton label="Cancel" onClick={onClose} />
        </div>
        <ScreenMark name="chat/chip-choice" />
      </div>
    </div>
  );
}

/** All of the chip question's state and rules, so InputBar (already at its size ceiling) only wires it in. The DRAFT TEXT stays in
 *  InputBar (performance rule 5); this reads and writes it through `textRef` / `setText` and holds only "which chip is waiting". */
export function useChipChoice(
  textRef: React.MutableRefObject<string>,
  setText: (v: string) => void,
  inputRef: React.RefObject<HTMLTextAreaElement | null>,
  sessionId: string,
  text: string,
) {
  const [pending, setPending] = useState<{ chip: QuickChip; touch: boolean } | null>(null);
  useEffect(() => { setPending(null); }, [sessionId]); // a question about one chat's box must not follow to another
  // The question is about the words in the box: once the box is empty (cleared, or sent) there is nothing left to replace or add to.
  useEffect(() => { if (!text.trim()) setPending(null); }, [text]);
  const fill = useCallback((value: string) => {
    setText(value);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(value.length, value.length);
    });
  }, [setText, inputRef]);
  // WHY (card #143 c): a chip over typed words used to REPLACE them with no way back. Now the words wait untouched and a strip asks;
  // an empty box fills as always, and the chip never sends by itself.
  // WHY the click, not window listeners (review, performance rule 2: hidden means idle): a click made by touch or pen says so itself
  // (pointerType; QuickChips falls back to the chip's own pointerdown where click is a plain MouseEvent), and a keyboard one has none, so no listener has to watch the whole window from mount.
  const onChip = useCallback((chip: QuickChip, t?: string) => {
    if (textRef.current.trim()) setPending({ chip, touch: t === 'touch' || t === 'pen' }); else fill(chip.prompt);
  }, [textRef, fill]);
  const answer = useCallback((how: 'replace' | 'add' | 'close') => {
    const chip = pending?.chip;
    setPending(null);
    if (!chip || how === 'close') { inputRef.current?.focus(); return; }
    const cur = textRef.current;
    // Add to end: the words stay, a space between unless one is already there.
    fill(how === 'replace' || !cur.trim() ? chip.prompt : `${cur}${/\s$/.test(cur) ? '' : ' '}${chip.prompt}`);
  }, [pending, textRef, inputRef, fill]);
  // Photo-only build: `shoot chat/chip-choice` types words and taps a chip, through the same state.
  useScreenOpen('chat/chip-choice', () => { setText('Draft a reply to Maya about Thursday'); setPending({ chip: { label: 'Inbox', prompt: 'Check my inbox' }, touch: false }); });
  const strip = pending ? <ChipChoiceStrip onReplace={() => answer('replace')} onAdd={() => answer('add')} onClose={() => answer('close')} focusAdd={!pending.touch} /> : null;
  return { onChip, strip };
}
