// The header's Browser button (2026-10-13): opens/closes the active
// conversation's Browser panel. Shown on every chat where the Browser exists:
// the person can open the panel and browse there themselves (Destin,
// 2026-10-13), not only watch the assistant. Styling mirrors the Session Files and
// Games toggles (HeaderBar.tsx): bg-inset pill, accent fill while open. A dot
// says the browser did something while its panel was closed.
import { memo } from 'react';
import { toggleBrowserPane, useBrowserButton } from '../../state/browser-store';
import { ON_INSET_CONTROL } from '../header/control-states';
import { Tooltip } from '../ui';
import { GlobeIcon } from '../Icons';

const BrowserHeaderButton = memo(function BrowserHeaderButton({ sessionId }: { sessionId: string | null }) {
  const { show, open, dot } = useBrowserButton(sessionId);
  if (!show || !sessionId) return null;
  return (
    <div className="bg-inset rounded-md p-0.5">
      <Tooltip text={dot ? 'Browser — needs a look' : 'Browser'} placement="bottom">
        <button
          type="button"
          aria-label="Browser"
          aria-pressed={open}
          onClick={() => toggleBrowserPane(sessionId)}
          // Same corner as the other header toggles, via the theme variable (no arbitrary class).
          style={{ borderRadius: 'var(--radius-toggle)' }}
          className={`px-2 py-1 transition-colors flex items-center gap-1 ${open ? 'bg-accent text-on-accent' : ON_INSET_CONTROL}`}
        >
          <GlobeIcon className="w-4 h-4" />
          {dot && !open && <span className="w-1.5 h-1.5 rounded-full bg-accent" aria-hidden />}
        </button>
      </Tooltip>
    </div>
  );
});

export default BrowserHeaderButton;
