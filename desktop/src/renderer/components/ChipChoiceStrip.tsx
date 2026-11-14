import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { QuickChip } from './QuickChips';
import { Button } from './ui';
import { useEscClose } from '../hooks/use-esc-close';
import { useScreenOpen, ScreenMark } from '../shoot-mode';

// The slim strip above the message box that asks what a quick chip should do when the box already has words (card #143 c; Destin
// picked this design, "strip above box", on the round-3 deck, step R3-9, after seeing it beside two others).
// Same surface and slot as the waiting-message strip (QueuedMessagesStrip). The typed words are NOT touched while this shows: the
// parent applies the answer. The draft text itself stays in InputBar (performance rule 5); this only asks.
//
// WHY keyboard: Escape closes it (the app's central Escape stack, so it never competes with another layer), and focus moves to
// "Add to end", the answer that cannot lose words — never to Replace, so a stray Enter cannot throw the draft away.
export function ChipChoiceStrip({ onReplace, onAdd, onClose }: { onReplace: () => void; onAdd: () => void; onClose: () => void }) {
  useEscClose(true, onClose);
  const addRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { addRef.current?.focus(); }, []);
  return (
    <div className="px-2 sm:px-3 pb-1.5" data-chip-choice-strip role="group" aria-label="What should the quick chip do?">
      <div className="layer-surface flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl px-3 py-2 shadow-lg">
        <div className="text-3xs text-fg-muted select-none shrink-0">You have words in the box</div>
        <div className="flex items-center gap-2 ml-auto">
          <Button ref={addRef} variant="secondary" size="sm" onClick={onAdd}>Add to end</Button>
          <Button variant="primary" size="sm" onClick={onReplace}>Replace</Button>
          <Button variant="ghost" size="icon" aria-label="Cancel" onClick={onClose} className="w-6 h-6 rounded-full text-fg-dim">✕</Button>
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
) {
  const [pending, setPending] = useState<QuickChip | null>(null);
  useEffect(() => { setPending(null); }, [sessionId]); // a question about one chat's box must not follow to another
  const fill = useCallback((value: string) => {
    setText(value);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(value.length, value.length);
    });
  }, [setText, inputRef]);
  // WHY (card #143 c): a chip over typed words used to REPLACE them with no way back. Now the words wait untouched and a strip asks;
  // an empty box fills as always, and the chip never sends by itself.
  const onChip = useCallback((chip: QuickChip) => {
    if (textRef.current.trim()) setPending(chip); else fill(chip.prompt);
  }, [textRef, fill]);
  const answer = useCallback((how: 'replace' | 'add' | 'close') => {
    const chip = pending;
    setPending(null);
    if (!chip || how === 'close') { inputRef.current?.focus(); return; }
    const cur = textRef.current;
    // Add to end: the words stay, a space between unless one is already there.
    fill(how === 'replace' || !cur.trim() ? chip.prompt : `${cur}${/\s$/.test(cur) ? '' : ' '}${chip.prompt}`);
  }, [pending, textRef, inputRef, fill]);
  // Photo-only build: `shoot chat/chip-choice` types words and taps a chip, through the same state.
  useScreenOpen('chat/chip-choice', () => { setText('Draft a reply to Maya about Thursday'); setPending({ label: 'Inbox', prompt: 'Check my inbox' }); });
  const strip = pending ? <ChipChoiceStrip onReplace={() => answer('replace')} onAdd={() => answer('add')} onClose={() => answer('close')} /> : null;
  return { onChip, strip };
}
