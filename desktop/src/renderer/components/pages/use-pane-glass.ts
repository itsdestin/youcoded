// Is the app's page pane glass right now? (page-theme.ts → paneIsGlass.)
// Live, because the person can change theme, chrome style or wallpaper while a
// page is open. Watches only while `active`: a closed Pages view does no work
// (performance.md, "hidden means idle").
import { useEffect, useState } from 'react';
import { paneIsGlass } from './page-theme';
import { PAGES_SOLID_ATTR } from '../../themes/look-overrides';

export function usePaneGlass(active: boolean): boolean {
  const [glass, setGlass] = useState(() => paneIsGlass());
  useEffect(() => {
    if (!active) return;
    const check = () => setGlass(paneIsGlass()); // bails out when unchanged
    check();
    const mo = new MutationObserver(check);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-wallpaper', PAGES_SOLID_ATTR] });
    mo.observe(document.body, { attributes: true, attributeFilter: ['data-chrome-style'] });
    return () => mo.disconnect();
  }, [active]);
  return glass;
}
