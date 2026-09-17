// ContextIntroBanner — a one-time, dismiss-forever explainer that mounts at the
// top of the Context tab. It teaches a non-technical user, in one plain-language
// paragraph, what "context" files are. Once dismissed it never returns (there is
// intentionally NO "show again" affordance — the user removed it).
//
// Persistence: the dismissed state is stored under the localStorage key
// `pv-context-intro-dismissed` (value '1'). On first render we read that key so a
// previously-dismissed banner stays hidden across reloads, and we mirror it in
// local state so clicking the × hides the banner immediately without a reload.
import { useState } from 'react';

// localStorage key for the dismiss-forever flag. Kept in sync with the prototype
// (docs/superpowers/prototypes/2026-06-14-project-view-redesign.html).
const INTRO_DISMISSED_KEY = 'pv-context-intro-dismissed';

// Defensive reads/writes: localStorage exists in the renderer, but wrap in
// try/catch so an unexpected access failure can never throw during render.
function readDismissed(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(INTRO_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function persistDismissed(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(INTRO_DISMISSED_KEY, '1');
  } catch {
    /* ignore — banner still hides via local state below */
  }
}

// Info-circle + close glyphs — shared module (./icons.tsx).
import { InfoIcon } from './icons';
import { CloseButton } from '../ui';

export function ContextIntroBanner() {
  // Initialize from localStorage so a previously-dismissed banner never flashes
  // on mount; the local state also lets the × hide it instantly without reload.
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed());

  if (dismissed) return null;

  return (
    // shrink-0: the Context tab is a flex-col with overflow-auto; without this the
    // banner gets vertically compressed by the column and `.layer-surface`'s
    // overflow:hidden clips the paragraph down to the eyebrow line.
    // boxShadow none: this is an in-flow banner, not a floating overlay — the
    // .layer-surface popup shadow read as stray elevation (same override the
    // seg control and file cards use).
    <div className="layer-surface relative flex gap-3 p-3.5 pr-9 mb-4 shrink-0" style={{ boxShadow: 'none' }}>
      <span className="shrink-0 text-fg-dim mt-px">
        <InfoIcon size={18} />
      </span>
      <div className="min-w-0">
        {/* Uppercase micro-label / eyebrow, consistent with the design language. */}
        <div className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1">About context</div>
        {/* One plain-language paragraph — no jargon, no glyphs. */}
        <p className="text-xs text-fg-2 leading-relaxed">
          These are the notes and rules YouCoded reads to understand how you want it to work. Some
          load every time you chat, some only in certain folders or situations. Open any file to see
          or edit what shapes Claude&rsquo;s behavior here.
        </p>
      </div>
      {/* × dismiss — persists the flag AND hides immediately via local state. */}
      {/* w-6 h-6 survives as a className override: this sits inside a compact banner
          corner, where the standard 28px icon button would crowd the text. */}
      <CloseButton
        className="absolute top-2 right-2 w-6 h-6 rounded-md"
        title="Dismiss — won't show again"
        label="Dismiss context intro"
        onClick={() => {
          persistDismissed();
          setDismissed(true);
        }}
      />
    </div>
  );
}
