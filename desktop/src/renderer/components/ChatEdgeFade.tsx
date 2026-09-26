import type { CSSProperties } from 'react';
import { useTheme } from '../state/theme-context';

/** Wallpaper-matched edge fade for Minimalist chat, mounted only on the visible tab. */
export default function ChatEdgeFade({ belowFindRow }: { belowFindRow: boolean }) {
  const { bgStyle, patternStyle } = useTheme();
  // WHY: masking the scrollport made it a backdrop root; its bubbles could not
  // blur the wallpaper. Only this stationary sibling is masked, so the bubble
  // filters still sample the real backdrop. One copy per visible chat, no
  // scroll listener or per-message fade/filter nodes.
  return (
    <div className="chat-edge-fade" data-below-find-row={belowFindRow} aria-hidden="true">
      <div className="chat-edge-fade__wallpaper" style={bgStyle as CSSProperties | undefined} />
      {patternStyle && <div className="chat-edge-fade__pattern" style={patternStyle as CSSProperties} />}
    </div>
  );
}
