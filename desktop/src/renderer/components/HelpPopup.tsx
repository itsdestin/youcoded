// desktop/src/renderer/components/HelpPopup.tsx
// Settings → Help & feedback (first-run guide design 2026-09-10, §1.6). Same
// shape as DevelopmentPopup: the shared <Dialog> shell with <SettingRow> rows,
// so it picks up every theme's tokens and needs no colours of its own.
import { useEffect, useState } from 'react';
import { Dialog, SettingRow, Toggle } from './ui';
import { useEscClose } from '../hooks/use-esc-close';
import { useGuideReset } from './guide/guide-events';
import { formatVersionLine } from '../../shared/version-line';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Replays the buddy's tour. Absent where there is no tour (phone, browser). */
  onShowMeAround?: () => void;
  /** Opens the app's existing bug-report surface (BugReportPopup). */
  onOpenBug: () => void;
  /** Same fields AboutPopup takes: the desktop passes a build-time constant,
   *  Android an async lookup — an empty version renders no line at all. */
  version?: string;
  build?: string;
  channel?: string;
}

const COMMUNITY_URL = 'https://www.reddit.com/r/youcoded/';
const KNOWN_ISSUES_URL = 'https://github.com/itsdestin/youcoded/issues';

// The switch that arms the new-user tips (design §4). '1' is on; anything else,
// or no key, is off. The wizard hand-off writes it; this row sets and clears it.
const TIPS_KEY = 'youcoded-tips-armed';

function readTipsArmed(): boolean {
  // WHY try/catch: localStorage throws in a sandboxed WebView, a private
  // window and some remote-browser contexts — the switch must just read "off"
  // there instead of taking the whole Settings drawer down with it.
  try {
    return localStorage.getItem(TIPS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeTipsArmed(on: boolean): void {
  try {
    if (on) localStorage.setItem(TIPS_KEY, '1');
    else localStorage.removeItem(TIPS_KEY);
  } catch {
    // Nothing to do: the switch still flips on screen for this sitting.
  }
}

export function HelpPopup({ open, onClose, onShowMeAround, onOpenBug, version, build, channel }: Props) {
  useEscClose(open, onClose);
  // The first-run tour moving on closes this popup (guide-events.ts).
  useGuideReset(onClose);
  const [tipsArmed, setTipsArmed] = useState(readTipsArmed);
  // WHY re-read on open: the tour's hand-off and a tip's "Stop showing tips"
  // both write this key while the popup is closed. Initial state alone would
  // show a stale switch the second time the popup opens.
  useEffect(() => {
    if (open) setTipsArmed(readTipsArmed());
  }, [open]);

  if (!open) return null;
  // WHY the default scrolling body (unlike Development's scrollBody={false}):
  // this popup has twice the rows plus a version line, which sits near the
  // `prompt` height cap on a short window. G-11: a dialog must never switch
  // the body off and then overflow — the shared body scrolls and fades instead.
  return (
    <Dialog open onClose={onClose} size="prompt" title="Help & feedback">
      {/* data-guide-anchor: the tour's last stop rings this page. */}
      <div className="space-y-2" data-guide-anchor="help-popup">
        {/* Only where a tour exists (desktop): a row that visibly does nothing
            on the phone is worse than no row. */}
        {onShowMeAround && (
          <SettingRow
            icon={<CompassIcon />}
            title="Show me around"
            description="The buddy's tour, again"
            onClick={() => { onShowMeAround(); onClose(); }}
          />
        )}
        <SettingRow
          icon={<LightbulbIcon />}
          title="Tips for new users"
          description="Hints as things come up"
          control={
            <Toggle
              checked={tipsArmed}
              onChange={(next) => { writeTipsArmed(next); setTipsArmed(next); }}
              aria-label="Tips for new users"
            />
          }
        />
        <SettingRow
          icon={<PeopleIcon />}
          title="Community on Reddit"
          description="Questions, ideas, other users"
          onClick={() => { window.open(COMMUNITY_URL, '_blank'); onClose(); }}
        />
        <SettingRow
          icon={<BugIcon />}
          title="Report a bug or request a feature"
          description="Send it to the team"
          onClick={() => { onOpenBug(); onClose(); }}
        />
        <SettingRow
          icon={<ClipboardListIcon />}
          title="Known issues and planned features"
          description="See what is known and what is coming"
          onClick={() => { window.open(KNOWN_ISSUES_URL, '_blank'); onClose(); }}
        />
        {/* The version, so a bug report or a Reddit post can quote it without
            a trip to About. Not a row: nothing happens when it is pressed. */}
        {version && (
          <p className="text-2xs text-fg-muted text-center pt-2">
            {formatVersionLine({ version, build, channel })}
          </p>
        )}
      </div>
    </Dialog>
  );
}

// Inline SVG icons in the settings-row style (stroke 1.8, currentColor →
// text-fg-muted). Each viewBox is 24×24, rendered at 16×16, round caps and joins.

function CompassIcon() {
  // A compass — "show me around" is wayfinding.
  return (
    <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5 L13.5 13.5 L8.5 15.5 L10.5 10.5 Z" />
    </svg>
  );
}

function LightbulbIcon() {
  return (
    <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {/* Bulb */}
      <path d="M9 15.5 a6 6 0 1 1 6 0 v1.5 H9 z" />
      {/* Base */}
      <path d="M10 20 H14" />
    </svg>
  );
}

function PeopleIcon() {
  // Two heads — a community, not a single account.
  return (
    <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20 a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5 a3.5 3.5 0 0 1 0 7" />
      <path d="M17.5 13.5 a6 6 0 0 1 4 6.5" />
    </svg>
  );
}

function BugIcon() {
  // Same glyph as Development's Report row, so the two entrances to one
  // surface look the same.
  return (
    <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 8 a4 4 0 0 1 8 0 v8 a4 4 0 0 1 -8 0 z" />
      <path d="M9 7 L7 4" />
      <path d="M15 7 L17 4" />
      <path d="M8 11 L5 11" />
      <path d="M8 14 L4 15" />
      <path d="M8 17 L5 19" />
      <path d="M16 11 L19 11" />
      <path d="M16 14 L20 15" />
      <path d="M16 17 L19 19" />
    </svg>
  );
}

function ClipboardListIcon() {
  return (
    <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5 H7 a2 2 0 0 0 -2 2 v12 a2 2 0 0 0 2 2 h10 a2 2 0 0 0 2 -2 v-12 a2 2 0 0 0 -2 -2 h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 12 H15" />
      <path d="M9 15 H15" />
      <path d="M9 18 H13" />
    </svg>
  );
}
