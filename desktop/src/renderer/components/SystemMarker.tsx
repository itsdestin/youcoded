import { useState } from 'react';
import type { SystemMarker as SystemMarkerData } from '../state/chat-types';

// Thin horizontal divider used for /clear and /compact markers.
// Permanent — user sees "these messages end here" when scrolling back.
// Deliberately quiet styling so it doesn't compete with actual conversation content.
//
// When a /compact marker carries a `summary` (CC-produced conversation summary
// from the isCompactSummary line), clicking the label toggles an inline panel
// that reveals the full summary. Replaces CC's terminal "ctrl+o" affordance,
// which never worked inside YouCoded because the chat view consumes that key.

interface Props {
  marker: SystemMarkerData;
}

export default function SystemMarker({ marker }: Props) {
  const [expanded, setExpanded] = useState(false);
  const time = new Date(marker.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const expandable = !!marker.summary;

  return (
    <div className="px-6 py-2 text-fg-muted">
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-edge-dim" />
        {expandable ? (
          // Render as a button so screen readers + keyboard navigation get
          // the expand affordance for free.
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            // WHY: drop the spaced-caps eyebrow (labels batch, guide: no
            // spaced capitals).
            className="text-2xs whitespace-nowrap inline-flex items-center gap-1.5 hover:text-fg-2 transition-colors cursor-pointer"
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              aria-hidden="true"
              className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
            >
              <path d="M2 1 L6 4 L2 7" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            {marker.label}
            <span className="ml-1 text-fg-muted normal-case tracking-normal">· {time}</span>
            <span className="ml-1 text-fg-muted normal-case tracking-normal">
              · {expanded ? 'hide' : 'view'} summary
            </span>
          </button>
        ) : (
          <span className="text-2xs whitespace-nowrap">
            {marker.label}
            <span className="ml-2 text-fg-muted normal-case tracking-normal">· {time}</span>
          </span>
        )}
        <div className="flex-1 h-px bg-edge-dim" />
      </div>
      {expandable && expanded && (
        // Inline panel — quiet styling, scrolls independently for long
        // summaries. Pre-wrap preserves CC's numbered-list formatting;
        // break-words so long paths/URLs wrap rather than overflow.
        <div className="mt-2 mx-auto max-w-3xl rounded-md border border-edge-dim bg-inset/60 px-4 py-3">
          {/* WHY: drop the spaced-caps eyebrow (labels batch, guide: no
              spaced capitals). Kept a plain div, not SectionLabel — this
              sits inside its own small inline panel, not a screen/popup/list. */}
          <div className="text-xs font-medium text-fg-muted mb-2">
            Compaction summary
          </div>
          <pre className="text-xs text-fg-2 whitespace-pre-wrap break-words font-sans leading-relaxed max-h-96 overflow-y-auto">
            {marker.summary}
          </pre>
        </div>
      )}
    </div>
  );
}
