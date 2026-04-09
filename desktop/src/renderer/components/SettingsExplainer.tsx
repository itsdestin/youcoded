/**
 * SettingsExplainer.tsx — Reusable in-popup explainer screen.
 *
 * Used by RemoteButton (Remote Access), SyncPopup (Sync), and ThemeScreen
 * (Appearance) to render a "What is this?" view inside the same modal frame.
 * The host popup keeps a `showInfo` boolean and renders this component instead
 * of its main content, so the user can back out to the original settings.
 *
 * Content is intentionally written in plain layman's terms — DestinCode is
 * built for non-developers and these explainers double as in-app help.
 */

import React from 'react';

export interface ExplainerBullet {
  /** Optional bold lead-in (e.g. a setting name). */
  term?: string;
  /** Body text following the term. */
  text: string;
}

export interface ExplainerSection {
  heading: string;
  /** Plain paragraphs rendered before any bullets. */
  paragraphs?: string[];
  /** Bulleted list of items, each optionally led by a bold term. */
  bullets?: ExplainerBullet[];
}

interface Props {
  /** Subject of the explainer, e.g. "Remote Access". */
  title: string;
  /** One- or two-sentence opening summary. */
  intro: string;
  sections: ExplainerSection[];
  /** Return to the host popup's main view. */
  onBack: () => void;
  /** Close the host popup entirely. */
  onClose: () => void;
}

export default function SettingsExplainer({ title, intro, sections, onBack, onClose }: Props) {
  return (
    <div className="flex flex-col h-full">
      {/* Header — back arrow on the left, "About <title>" centered, close on the right.
          Mirrors the host popup's header layout so the swap feels seamless. */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <button
          onClick={onBack}
          className="text-fg-muted hover:text-fg-2 leading-none w-6 h-6 flex items-center justify-center rounded-sm hover:bg-inset"
          title="Back to settings"
          aria-label="Back to settings"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h2 className="text-sm font-bold text-fg">About {title}</h2>
        <button
          onClick={onClose}
          className="text-fg-muted hover:text-fg-2 text-lg leading-none w-6 h-6 flex items-center justify-center"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {/* Body — intro paragraph, then each section with its own heading. */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        <p className="text-xs text-fg-2 leading-relaxed">{intro}</p>

        {sections.map((section, i) => (
          <section key={i}>
            <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-2">
              {section.heading}
            </h3>
            {section.paragraphs?.map((p, j) => (
              <p key={j} className="text-xs text-fg-2 leading-relaxed mb-2 last:mb-0">{p}</p>
            ))}
            {section.bullets && (
              <ul className="space-y-1.5 mt-1">
                {section.bullets.map((b, j) => (
                  <li key={j} className="text-xs text-fg-2 leading-relaxed pl-3 relative before:content-['•'] before:absolute before:left-0 before:text-fg-faint">
                    {b.term && <span className="font-semibold text-fg">{b.term}</span>}
                    {b.term && ' — '}
                    {b.text}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * Shared info-icon button — drop into a popup header next to the close button.
 * Triggers the host's `onClick` (typically `setShowInfo(true)`).
 */
export function InfoIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-fg-muted hover:text-fg-2 leading-none w-6 h-6 flex items-center justify-center rounded-sm hover:bg-inset"
      title="What is this?"
      aria-label="What is this?"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 11v5" />
        <circle cx="12" cy="8" r="0.5" fill="currentColor" />
      </svg>
    </button>
  );
}
