// The status-tag sheet — every Pill tone on the three surfaces it sits on (a popup, a card,
// a card in a card), at fixed positions, so one picture per theme can be MEASURED (`shoot
// dev/pills --themes all`, sampled by submit-ticket-5's tint check) and judged by eye.
//
// WHY (Destin's "Submitted" tag read grey on YouCoded, submit-ticket-3; proposal 9): the
// green tint is 15% of green-400 over a pale card, and nothing measured how faint each tone
// is on each theme. Photo-only build, like the icon sheet; never ships.
//
// FIXED GEOMETRY (CSS px, at SHOOT_SCALE=1): panel at (40,40), 560×470. Card A (level 1) at
// panel +(20,20), 520×200; card B (level 2, inside A? no — inside card C) — see SAMPLE below.
// Every blank pill's centre and a background point beside it are listed in SAMPLE so the
// numbers are read from pixels, not guessed from tokens.
import { useEffect, useState } from 'react';
import { CARD_LEVEL_1, Pill } from '../../components/ui';
import type { PillTone } from '../../components/ui/Pill';
import { ScreenMark, useScreenOpen } from '../../shoot-mode';

const TONES: PillTone[] = ['neutral', 'info', 'ok', 'warning', 'danger'];
const WORDS: Record<PillTone, string> = { neutral: 'Not sent', info: 'Bug', ok: 'Submitted', warning: 'Folder missing', danger: 'Sync problem' };
const ROW_H = 32;

function Rows({ dots }: { dots?: boolean }) {
  return <>{TONES.map((t) => (
    <div key={t} className="flex items-center gap-3" style={{ height: ROW_H }}>
      <span className="text-3xs text-fg-muted" style={{ width: 60 }}>{t}</span>
      {/* The blank pill is the sample: its middle is pure tint. */}
      <Pill tone={t}><span style={{ display: 'inline-block', width: 40 }}>&nbsp;</span></Pill>
      <Pill tone={t}>{WORDS[t]}</Pill>
      {dots && <Pill tone={t} dot>{WORDS[t]}</Pill>}
    </div>
  ))}</>;
}

export default function PillSheet() {
  const [open, setOpen] = useState(false);
  useScreenOpen('dev/pills', () => setOpen(true));
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-canvas text-fg" style={{ zIndex: 100000 }} role="dialog" aria-label="Status tag sheet">
      <ScreenMark name="dev/pills" />
      <div className="layer-surface absolute rounded-xl" style={{ left: 40, top: 40, width: 600, height: 560, padding: 20 }}>
        <p className="text-xs text-fg-2" style={{ height: 20 }}>On the popup</p>
        <div style={{ paddingLeft: 12 }}><Rows dots /></div>
        <p className="text-xs text-fg-2" style={{ height: 20, marginTop: 8 }}>In a card</p>
        <div className={CARD_LEVEL_1} style={{ padding: 12 }}>
          <Rows dots />
        </div>
      </div>
    </div>
  );
}
