import React from 'react';
import ResumeBrowser from '../../../components/ResumeBrowser';
import { ThemeBg } from '../../../components/ThemeBg';
import { Button } from '../../../components/ui';
import { EscCloseProvider } from '../../../hooks/use-esc-close';
import './ResumeShellDemo.css';

/** WHY: the Resume popup is a fixed, portaled real component. Mark its actual
 * shell in this isolated Workbench iframe so the comparison CSS never changes
 * production styles or another popup's nested header. Select a real fixture
 * row through its own button to show the two-column preview in both panes. */
export function ResumeShellDemo({ treatment }: { treatment: 'today' | 'proposed' }) {
  const [open, setOpen] = React.useState(true);
  React.useLayoutEffect(() => {
    document.documentElement.dataset.resumeReview = treatment;
    let selected = false;
    const markShell = () => {
      const heading = [...document.querySelectorAll('h2')].find((node) => node.textContent === 'Resume Session');
      const panel = heading?.closest<HTMLElement>('.layer-surface');
      if (!panel) return;
      if (!panel.hasAttribute('data-resume-review-panel')) panel.setAttribute('data-resume-review-panel', '');
      const header = heading?.parentElement?.parentElement;
      if (header && !header.hasAttribute('data-resume-review-header')) header.setAttribute('data-resume-review-header', '');
      const list = panel.querySelector<HTMLElement>('.scroll-fade');
      if (list && !list.hasAttribute('data-resume-review-list')) list.setAttribute('data-resume-review-list', '');
      // WHY: the first expanded button in a stress card is its Organize icon,
      // not the conversation trigger. Skip unsynced/inert rows as well.
      const firstRow = list?.querySelector<HTMLButtonElement>('button.w-full[aria-expanded]:not([aria-disabled])');
      if (!selected && firstRow) {
        selected = true;
        firstRow.click();
      }
    };
    const observer = new MutationObserver(markShell);
    observer.observe(document.body, { childList: true, subtree: true });
    markShell();
    return () => {
      observer.disconnect();
      delete document.documentElement.dataset.resumeReview;
    };
  }, [treatment]);

  return <div className="resume-shell-review p-4">
    <ThemeBg />
    <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Open Resume Session</Button>
    <EscCloseProvider>
      <ResumeBrowser open={open} onClose={() => setOpen(false)} onResume={async () => false} />
    </EscCloseProvider>
  </div>;
}
