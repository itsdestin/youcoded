import React from 'react';
import { ProjectDetailOverlay } from '../../../components/project-view/ProjectDetailOverlay';
import { Button } from '../../../components/ui';
import { ThemeBg } from '../../../components/ThemeBg';
import './ProjectPopupTaperDemo.css';

/** WHY: each pane now runs the actual Project overlay and its scroll hook;
 * only Today's original header/edge is restored by dev-only CSS. */
export function ProjectPopupTaperDemo({ variant }: { variant: 'today' | 'selected' }) {
  const [open, setOpen] = React.useState(true);

  return (
    <div className="project-popup-taper-demo p-4" style={{ height: 570 }} data-variant={variant}>
      <ThemeBg />
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Open project detail</Button>
      {open && <ProjectDetailOverlay title="Project notes" onClose={() => setOpen(false)}>
        <div className="max-w-prose mx-auto px-5 py-6 space-y-5 text-sm text-fg-2">
          <h3 className="text-base font-semibold text-fg">Notes for this project</h3>
          {Array.from({ length: 16 }, (_, i) => (
            <p key={i}>Note {i + 1}: Conversations, files and research for this project appear here. Scroll to reach the later notes and compare how they pass beneath the header.</p>
          ))}
        </div>
      </ProjectDetailOverlay>}
    </div>
  );
}
