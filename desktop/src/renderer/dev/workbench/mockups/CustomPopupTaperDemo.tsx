import React from 'react';
import FileViewerOverlay from '../../../components/marketplace/FileViewerOverlay';
import { SessionTagsChip } from '../../../components/tags/SessionTagsChip';
import { ThemeBg } from '../../../components/ThemeBg';
import { Button } from '../../../components/ui';
import './CustomPopupTaperDemo.css';

// WHY: both previews now render the real approved custom shells and their
// scroll hooks. Only the Today panes restore original styling through CSS.
export function MarketplaceFileTaperDemo({ variant }: { variant: 'today' | 'two-lines' | 'one-line' }) {
  const [open, setOpen] = React.useState(true);
  return (
    <div className="file-taper-demo p-4" style={{ height: 570 }} data-variant={variant}>
      <ThemeBg />
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Open Marketplace file</Button>
      {open && <FileViewerOverlay target={{ pluginId: 'ui-guide-preview', pluginName: 'Sample Plugin', kind: 'skill', name: 'sample-skill' }} onClose={() => setOpen(false)} />}
    </div>
  );
}

export function TagEditorTaperDemo({ variant }: { variant: 'today' | 'divider' | 'fade' }) {
  React.useEffect(() => {
    // The actual chip owns opening; click it rather than copying its popup.
    const timer = window.setTimeout(() => document.querySelector<HTMLButtonElement>('.tag-taper-demo > button')?.click(), 100);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="tag-taper-demo p-4" style={{ height: 570 }} data-variant={variant}>
      <ThemeBg />
      <SessionTagsChip sessionId="ui-guide-tag-preview" />
    </div>
  );
}
