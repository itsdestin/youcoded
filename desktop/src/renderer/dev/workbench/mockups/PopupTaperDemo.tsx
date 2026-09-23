import React from 'react';
import AboutPopup from '../../../components/AboutPopup';
import { DevelopmentPopup } from '../../../components/development/DevelopmentPopup';
import { Button } from '../../../components/ui';
import { ThemeBg } from '../../../components/ThemeBg';
import './PopupTaperDemo.css';

/** WHY: compare the real, long, scrolling About dialog with and without the
 * Settings treatment. Each pane has its own document because Dialog portals to
 * body; no production dialog or global scroll styling is changed for this review. */
export function PopupTaperDemo({ variant, kind = 'about' }: { variant: 'today' | 'selected'; kind?: 'about' | 'development' }) {
  const [open, setOpen] = React.useState(true);
  return (
    <div className="popup-taper-demo p-4" style={{ height: 570 }} data-variant={variant}>
      <ThemeBg />
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Open {kind === 'about' ? 'About' : 'Development'}</Button>
      {kind === 'about'
        ? <AboutPopup open={open} onClose={() => setOpen(false)} platform="desktop" version="1.3.1" />
        : <DevelopmentPopup open={open} onClose={() => setOpen(false)} onOpenBug={() => {}} onOpenContribute={() => {}} />}

    </div>
  );
}
