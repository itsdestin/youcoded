import { useCallback, useRef } from 'react';
import type { MascotVariant } from '../../themes/theme-types';
import { useThemeMascot } from '../../hooks/useThemeMascot';
import { useAnyAttentionNeeded } from '../../hooks/useAnyAttentionNeeded';

const DRAG_THRESHOLD_PX = 4;

export function BuddyMascot() {
  const attention = useAnyAttentionNeeded();
  // When attention is needed, use the theme's 'shocked' variant. When idle,
  // use the standard 'idle' variant. Theme authors provide mascot assets via
  // mascot-shocked.svg, or fallback to emoji.
  const variant: MascotVariant = attention ? 'shocked' : 'idle';
  const customMascot = useThemeMascot(variant);

  // Track pointer travel so drag doesn't register as click.
  const downRef = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    downRef.current = { x: e.screenX, y: e.screenY };
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const down = downRef.current;
    downRef.current = null;
    if (!down) return;
    const dx = Math.abs(e.screenX - down.x);
    const dy = Math.abs(e.screenY - down.y);
    if (dx + dy <= DRAG_THRESHOLD_PX) {
      // Ignore if buddy API isn't exposed (same guard logic as the hook)
      if (window.claude?.buddy?.toggleChat) {
        window.claude.buddy.toggleChat();
      }
    }
  }, []);

  return (
    <div
      style={{
        width: 80,
        height: 80,
        // OS-level drag handle — lets user reposition the transparent window
        // by dragging the mascot itself. The pointer events below are still
        // delivered to React; both work in parallel.
        WebkitAppRegion: 'drag',
        cursor: 'grab',
        background: 'transparent',
      } as any}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      {customMascot ? (
        <img
          src={customMascot}
          alt=""
          style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
          // Dragging an <img> would otherwise start a file drag. Disable.
          draggable={false}
        />
      ) : (
        <DefaultMascot variant={attention ? 'shocked' : 'idle'} />
      )}
    </div>
  );
}

/**
 * Fallback when the active theme has no mascot override for the current
 * variant. Uses emoji to keep the MVP simple; themes that want branded
 * mascots provide their own idle/welcome assets via useThemeMascot.
 */
function DefaultMascot({ variant }: { variant: 'idle' | 'shocked' }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        fontSize: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
      }}
    >
      {variant === 'shocked' ? '😲' : '🐱'}
    </div>
  );
}
