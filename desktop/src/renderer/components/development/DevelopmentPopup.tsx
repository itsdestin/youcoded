// desktop/src/renderer/components/development/DevelopmentPopup.tsx
// L2 popup with three rows: Report, Contribute, Known Issues.
// Uses <Scrim> / <OverlayPanel> primitives from Overlay.tsx so the popup
// picks up theme tokens automatically — no hardcoded colors, blur, or z-indexes
// (PITFALLS overlay invariant).
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel } from '../overlays/Overlay';

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenBug: () => void;
  onOpenContribute: () => void;
}

const KNOWN_ISSUES_URL = 'https://github.com/itsdestin/youcoded/issues';

/**
 * L2 popup with three rows: Report, Contribute, Known Issues. Uses
 * <Scrim> / <OverlayPanel> primitives so the popup picks up the active
 * theme automatically via CSS tokens.
 */
export function DevelopmentPopup({ open, onClose, onOpenBug, onOpenContribute }: Props) {
  if (!open) return null;
  return createPortal(
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel layer={2} className="p-4 w-[320px] mx-4">
        <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Development</h3>
        <div className="space-y-2">
          <Row
            icon="🐞"
            title="Report a Bug or Request a Feature"
            subtitle="Send it to the maintainers"
            onClick={() => { onOpenBug(); }}
          />
          <Row
            icon="🤝"
            title="Contribute to YouCoded"
            subtitle="Set up the dev workspace"
            onClick={() => { onOpenContribute(); }}
          />
          <Row
            icon="📋"
            title="Known Issues and Planned Features"
            subtitle="Browse open issues on GitHub"
            onClick={() => { window.open(KNOWN_ISSUES_URL, '_blank'); onClose(); }}
          />
        </div>
      </OverlayPanel>
    </>,
    document.body,
  );
}

function Row({ icon, title, subtitle, onClick }: { icon: string; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
    >
      <div className="flex items-center justify-center shrink-0 text-base" style={{ width: 32, height: 20 }}>{icon}</div>
      <div className="flex-1 min-w-0">
        <span className="text-xs text-fg font-medium">{title}</span>
        <p className="text-[10px] text-fg-muted">{subtitle}</p>
      </div>
      <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}
