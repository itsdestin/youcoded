// ProjectDetailOverlay — shared centered detail host for Project View (Task 2.4).
// Generic, content-agnostic shell: a scrim + large centered panel. The header
// carries the title (left) plus a `tools` slot for content-specific action
// buttons and the close button (right); an optional `meta` strip sits below the
// header (bg-well) for content-specific metadata; the body slot scrolls. Layout
// matches the prototype's renderDetail() (header → meta strip → body). Reused by
// the artifact viewer (Task 2.4), the conversation preview (Task 3.2), and the
// context editor (Task 4.4) — so it MUST NOT bake in any artifact-specific logic;
// each consumer supplies its own `tools` / `meta` / body.
import React from 'react';
import './ProjectDetailOverlay.css';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';
import { useScrollFade } from '../../hooks/useScrollFade';
import { CloseButton } from '../ui';

interface ProjectDetailOverlayProps {
  title: React.ReactNode;
  onClose: () => void;
  // Content-specific action buttons rendered in the header, left of the close
  // button (e.g. Edit/Save, Reveal, Copy path, Resume). Omit for a chrome-only
  // header.
  tools?: React.ReactNode;
  // Optional meta strip below the header (e.g. "N messages · 2d ago · read-only").
  // The strip is only rendered when this is provided.
  meta?: React.ReactNode;
  children: React.ReactNode;
}

export function ProjectDetailOverlay({ title, onClose, tools, meta, children }: ProjectDetailOverlayProps) {
  // ESC-close via the centralized LIFO stack (see docs/PITFALLS.md → Keyboard
  // Routing). `true` because the overlay is only mounted while it should be
  // dismissible — mounting/unmounting is the open/close gate.
  useEscClose(true, onClose);
  // WHY: the project body scrolls independently of its persistent header; track
  // actual scroll room so the approved content mask disappears at either end.
  const scrollRef = useScrollFade<HTMLDivElement>();

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        className="fixed inset-2 sm:inset-8 md:inset-16 flex flex-col"
        role="dialog"
        aria-modal
      >
        {/* Header: title (left) + tools + close (right). */}
        {/* Wraps below 640px. For an artifact the tools slot renders Edit ·
            Open · Reveal · Copy path · Exclude (~340px of shrink-0 content) in
            a panel that is only ~374px wide at inset-2 — the title collapsed
            to nothing AND the buttons still pushed the × off-panel, so the
            overlay could not be closed. CloseButton is deliberately outside
            the wrapping group so it stays reachable on the first line. */}
        <header className="project-detail-header flex flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-4 sm:py-3 shrink-0">
          <span className="text-base font-medium text-fg truncate min-w-0 flex-1">{title}</span>
          {/* order flips the close button: narrow keeps it on the title line
              (tools wrap underneath); sm+ restores the original title · tools ·
              close reading order. */}
          <CloseButton className="order-1 sm:order-3 ml-1 shrink-0" onClick={onClose} title="Close" />
          <div className="order-2 flex flex-wrap items-center justify-end gap-1.5">
            {tools}
          </div>
        </header>

        {/* Meta strip — only when the consumer supplies metadata. */}
        {meta != null && (
          <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-fg-muted border-b border-edge-dim bg-well shrink-0">
            {meta}
          </div>
        )}

        {/* Scrollable body slot */}
        <div ref={scrollRef} className="project-detail-scroll flex-1 overflow-auto min-h-0">{children}</div>
      </OverlayPanel>
    </>
  );
}
