// The workbench tool-card gallery as screens (`shoot dev/tools#<section>`). WHY: ToolGallery.tsx
// (every tool card, from the recorded fixtures) was only reachable by URL, so no picture or
// before/after ever covered a tool card's look on its own. One screen per gallery section keeps
// each picture readable. Photo-only build only (index.tsx); never ships.
import { useEffect, useState } from 'react';
import { ToolGallery } from './ToolGallery';
import { ScreenMark, useScreenOpen } from '../../shoot-mode';

export default function ToolsPractice() {
  const [section, setSection] = useState<number | null>(null);
  useScreenOpen('dev/tools', () => {
    const n = Number(new URLSearchParams(location.search).get('section') ?? '0');
    setSection(Number.isFinite(n) ? n : 0);
  });
  // Escape closes it like any layer (shoot --check presses it).
  useEffect(() => {
    if (section === null) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setSection(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [section]);
  if (section === null) return null;
  return (
    <div className="fixed inset-0 bg-canvas text-fg" style={{ zIndex: 100000 }} role="dialog" aria-label="Tool cards">
      <ScreenMark name="dev/tools" />
      <ToolGallery only={section} />
    </div>
  );
}
