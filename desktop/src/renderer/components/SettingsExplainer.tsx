import { Tooltip } from './ui';
/**
 * SettingsExplainer.tsx — the explainer payload, and nothing else.
 *
 * Used by Remote Access, Backup & Sync, Appearance and Context to render a
 * "What is this?" view inside the same modal frame. The host keeps a `showInfo`
 * boolean and renders this instead of its main content, so the user can back
 * out to the original settings.
 *
 * K12: this USED to carry its own header (back chevron + "About {title}" +
 * close), its own useScrollFade body and its own Esc handler, because it
 * predates <Dialog>. D1 owns all three now, so hosts render this as ordinary
 * body content and pass `title` + `onBack` to their Dialog instead — which also
 * means the explainer inherits the shell's edge fades and height cap rather
 * than each host remembering to wire them.
 *
 * The spec framed K12 as consolidating five mechanisms into one renderer. That
 * had already happened: four hosts shared this component and this payload
 * before tranche 3 started. What had NOT happened is the part above.
 *
 * Content is intentionally written in plain layman's terms — YouCoded is
 * built for non-developers and these explainers double as in-app help.
 */


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
  /** One- or two-sentence opening summary. */
  intro: string;
  sections: ExplainerSection[];
}

export default function SettingsExplainer({ intro, sections }: Props) {
  return (
    <>
      <p className="text-xs text-fg-2 leading-relaxed">{intro}</p>

      {sections.map((section, i) => (
        <section key={i}>
          {/* h3, matching K1 — the dialog title is h2, so an h3 here announces
              as its child rather than its sibling. */}
          <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">
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
    </>
  );
}

/**
 * Shared info-icon button — drop into a popup header next to the close button.
 * Triggers the host's `onClick` (typically `setShowInfo(true)`).
 */
export function InfoIconButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip text="What is this?">
    <button
      onClick={onClick}
      className="text-fg-muted hover:text-fg-2 leading-none w-6 h-6 flex items-center justify-center rounded-sm hover:bg-inset"
      aria-label="What is this?"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 11v5" />
        <circle cx="12" cy="8" r="0.5" fill="currentColor" />
      </svg>
    </button>
    </Tooltip>
  );
}
