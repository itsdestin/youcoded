// src/renderer/dev/workbench/mockups/ChipChoiceDemo.tsx
//
// Card #143 c, deck C-4 (Destin 2026-11-13: "i want to see this. idk if i love strip above box styling").
// Three different ways to answer "you tapped a quick chip but the message box already has words: replace them,
// or add to them?". NOTHING HERE IS WIRED INTO THE APP. Each variant draws the REAL quick-chip row and real
// shared pieces (Button, Toast, the right-click ContextMenu) around a stand-in for the message box.
// Today (shipping) a chip simply REPLACES what was typed, with no way back.
//
// Reached at ?mode=workbench&child=1&view=chip-choice&variant=strip|menu|undo (routing in index.tsx). Dev-only.
import React, { useEffect, useRef, useState } from 'react';
import QuickChips from '../../../components/QuickChips';
import { SkillProvider } from '../../../state/skill-context';
import { Button } from '../../../components/ui';
import { Toast } from '../../../components/ui/Toast';
import { ContextMenu } from '../../../components/context-menu/ContextMenu';
import { ThemeBg } from '../../../components/ThemeBg';

const TYPED = 'Draft a reply to Maya about Thursday';
const CHIP = 'Inbox';

/** A stand-in for the message box (the real one needs a whole session behind it). Same surface class as the app's input. */
function FakeBox({ text }: { text: string }) {
  return (
    <div className="layer-surface rounded-2xl px-4 py-3 text-sm text-fg" style={{ minHeight: 44 }}>{text}</div>
  );
}

// Variant A: the strip above the box. Same surface and slot as the waiting-message strip (QueuedMessagesStrip).
function StripVariant() {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="layer-surface flex items-center gap-2 rounded-xl px-3 py-2 shadow-lg">
        <div className="text-3xs text-fg-muted select-none shrink-0">You have words in the box</div>
        <div className="flex-1" />
        <Button variant="secondary" size="sm">Add to end</Button>
        <Button variant="primary" size="sm">Replace</Button>
        <Button variant="ghost" size="icon" aria-label="Cancel" className="w-6 h-6 rounded-full text-fg-dim">✕</Button>
      </div>
      <QuickChips onChipTap={() => {}} />
      <FakeBox text={TYPED} />
    </div>
  );
}

// Variant B: a small menu that opens at the chip you tapped. The right-click menu's own component and look.
function MenuVariant() {
  const wrap = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      const chip = [...(wrap.current?.querySelectorAll('.quick-chip') ?? [])].find((b) => b.textContent === CHIP);
      const r = chip?.getBoundingClientRect();
      // Opens ABOVE the chip's top edge; ContextMenu flips itself if it runs off the window.
      if (r) setAt({ x: r.left, y: r.top - 76 });
    }, 400);
    return () => clearTimeout(t);
  }, []);
  return (
    <div ref={wrap} className="flex flex-col gap-1.5" style={{ paddingTop: 100 }}>
      <QuickChips onChipTap={() => {}} />
      <FakeBox text={TYPED} />
      {at && (
        <ContextMenu x={at.x} y={at.y} onClose={() => {}} entries={[
          { type: 'item', id: 'replace', label: 'Replace what I typed', icon: 'rename', primary: true, run: () => {} },
          { type: 'item', id: 'add', label: 'Add to the end', icon: 'paste', run: () => {} },
        ]} />
      )}
    </div>
  );
}

// Variant C: no question first. The chip replaces the words as it does today, and a notice offers the way back.
function UndoVariant() {
  return (
    <div className="flex flex-col gap-1.5 relative" style={{ paddingTop: 70 }}>
      <div className="relative">
        <Toast
          variant="anchored"
          durationMs={null}
          onDismiss={() => {}}
          message="Replaced what you typed"
          actions={[{ label: 'Add to it instead', onClick: () => {} }, { label: 'Undo', onClick: () => {}, primary: true }]}
        />
      </div>
      <QuickChips onChipTap={() => {}} />
      <FakeBox text="Check my inbox and tell me what needs a reply today" />
    </div>
  );
}

const SUMMARY: Record<string, { title: string; line: string }> = {
  strip: { title: 'A. Strip above the box', line: 'After tapping a chip, a strip asks. Words in the box wait until you answer.' },
  menu: { title: 'B. Small menu at the chip', line: 'After tapping a chip, a two-row menu opens right at it. Same look as right-click.' },
  undo: { title: 'C. Replace at once, with Undo', line: 'No question. The chip replaces the words, and a notice lets you undo or add instead.' },
};

export function ChipChoiceDemo() {
  const variant = new URLSearchParams(window.location.search).get('variant') ?? 'strip';
  const s = SUMMARY[variant] ?? SUMMARY.strip;
  return (
    <SkillProvider>
      <div className="relative min-h-screen text-fg p-6" style={{ minWidth: 0 }}>
        <ThemeBg />
        <div className="relative max-w-3xl mx-auto">
          <h1 className="text-sm font-semibold mb-0.5">{s.title}</h1>
          <p className="text-2xs text-fg-dim mb-4">{s.line} (Message box shown with words typed; you just tapped “{CHIP}”.)</p>
          {variant === 'menu' ? <MenuVariant /> : variant === 'undo' ? <UndoVariant /> : <StripVariant />}
        </div>
      </div>
    </SkillProvider>
  );
}
