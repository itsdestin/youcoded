import React from 'react';
import { Button } from '../ui';
import { PagesIcon } from './page-icons';

/** First-run explanation in the Pages landing frame, where the Pages button leads. */
export function PagesEmptyCard({ onMake }: { onMake: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center max-sm:items-start px-2 py-8 min-h-0">
      <div className="w-full max-w-xl bg-panel border border-edge rounded-lg p-5 sm:p-6 flex flex-col items-center text-center gap-4 sm:flex-row sm:items-start sm:text-left">
        <span aria-hidden="true" className="shrink-0 inline-flex w-16 h-16 rounded-lg bg-inset border border-edge-dim items-center justify-center text-fg-dim">
          <PagesIcon className="w-8 h-8" />
        </span>
        <div className="min-w-0 flex flex-col gap-3 items-center sm:items-start">
          <div>
            <div className="text-2xs font-medium text-fg-muted tracking-wider uppercase mb-1">Pages</div>
            <h3 className="text-base font-semibold text-fg leading-snug">Pages are little apps you describe</h3>
          </div>
          {/* Examples that intrigue, not the smallest things a page could be
              (Destin, shell deck round 1, 2026-09-16). */}
          <p className="text-sm text-fg-2 leading-relaxed">
            Tell the assistant what you want — a calendar that pulls your accounts together, a
            news feed built around your interests, an email browser that works your way, a
            timesheet tracker for your team — and it builds a page that looks like the rest of
            YouCoded and follows your theme.
          </p>
          <p className="text-sm text-fg-2 leading-relaxed">
            Pin the ones you use most and they get their own button up top.
          </p>
          <Button variant="primary" onClick={onMake} className="w-full">
            Make a page
          </Button>
        </div>
      </div>
    </div>
  );
}
