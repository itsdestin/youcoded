import { useState } from 'react';
import { Button } from '../ui';
import { BuddyNewSessionForm } from './BuddyNewSessionForm';
import { BuddyResumeList } from './BuddyResumeList';

/**
 * Buddy empty-state — mirrors the main app's no-active-session screen
 * ("No Active Session" + New Session/Resume buttons — deliberately NO
 * mascot here: the buddy floater right next to this window IS the mascot,
 * a second one read as clutter — Destin 2026-07-16).
 *
 * Both buttons now open something. New Session swaps the CTA cluster for the
 * shared BuddyNewSessionForm (also reused by SessionPill's dropdown, so the two
 * buddy entry points cannot drift); Resume Session swaps it for BuddyResumeList.
 *
 * WHY RESUME CHANGED (Destin, 2026-09-10). Resume used to set an error string —
 * "Open Resume from the main window for now" — and do nothing else: a July
 * placeholder that read as a button and behaved as a label. Asked whether to
 * point it at the main window or build a short list in the floater, Destin
 * chose the list. See BuddyResumeList for what it deliberately leaves out.
 *
 * The buttons are the shared <Button>, not hand-styled inline ones. The
 * hand-styled pair carried a literal `background: 'var(--accent)'` block that
 * duplicated primary/secondary badly enough that no theme pack could restyle
 * them — the same drift that made this whole screen stale.
 */
interface Props {
  /** Called with the session id so BuddyChat can subscribe + set view. Fires for
   *  a freshly-created session AND for a resumed one — both are new live ids. */
  onSessionCreated: (sessionId: string) => void;
}

type Pane = 'buttons' | 'new' | 'resume';

export function BuddyWelcome({ onSessionCreated }: Props) {
  const [pane, setPane] = useState<Pane>('buttons');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        // The two open panes need the full height (the resume list scrolls);
        // only the collapsed CTA cluster is vertically centred.
        justifyContent: pane === 'buttons' ? 'center' : 'flex-start',
        height: '100%',
        gap: 10,
        padding: '0 16px',
      }}
    >
      {pane === 'buttons' && (
        <>
          <p style={{ fontSize: 14, color: 'var(--fg-muted)', margin: 0 }}>No Active Session</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', marginTop: 4 }}>
            {/* panel-glass is a deliberate className override, not a leftover:
                it re-tiers translucency from bubble→panel on wallpaper themes,
                exactly as the main welcome screen's pair does (decision 69). */}
            <Button
              variant="primary"
              size="lg"
              className="panel-glass w-full"
              onClick={() => setPane('new')}
            >
              New Session
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="panel-glass w-full"
              onClick={() => setPane('resume')}
            >
              <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>Resume Session</span>
            </Button>
          </div>
        </>
      )}

      {pane === 'new' && (
        <div className="layer-surface" style={{ width: '100%', padding: 12, marginTop: 4 }}>
          <BuddyNewSessionForm
            onCreated={onSessionCreated}
            onCancel={() => setPane('buttons')}
          />
        </div>
      )}

      {pane === 'resume' && (
        <div
          className="layer-surface"
          style={{ width: '100%', padding: 12, marginTop: 4, display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: '100%' }}
        >
          <BuddyResumeList
            onResumed={onSessionCreated}
            onCancel={() => setPane('buttons')}
          />
        </div>
      )}
    </div>
  );
}
