import { useTheme } from '../state/theme-context';
import type { MascotVariant } from '../themes/theme-types';

/**
 * Returns the resolved asset path for a themed mascot variant, or null
 * if the active theme doesn't override this mascot.
 */
export function useThemeMascot(variant: MascotVariant): string | null {
  const { activeTheme } = useTheme();
  return activeTheme?.mascot?.[variant] ?? null;
}
