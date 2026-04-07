import { useTheme } from '../state/theme-context';
import type { IconSlot } from '../themes/theme-types';

/**
 * Returns the resolved asset path for a themed icon override, or null if
 * the active theme doesn't override this icon slot.
 */
export function useThemeIcon(slot: IconSlot): string | null {
  const { activeTheme } = useTheme();
  return activeTheme?.icons?.[slot] ?? null;
}
