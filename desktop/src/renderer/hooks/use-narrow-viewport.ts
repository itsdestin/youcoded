// Matches Tailwind's sm: boundary at 640px. Returned boolean is true when the
// viewport is < 640px. Single source of truth for the marketplace mobile
// breakpoint — used wherever the DOM structure (not just classes) needs to
// branch between the wide and narrow layouts.

import { useEffect, useState } from 'react';

const QUERY = '(max-width: 639.98px)';

export function useNarrowViewport(): boolean {
  // false during SSR / before mount; updated synchronously inside the effect
  // so first paint after mount reflects the real viewport.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    setNarrow(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
