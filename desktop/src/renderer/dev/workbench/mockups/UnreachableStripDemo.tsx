// src/renderer/dev/workbench/mockups/UnreachableStripDemo.tsx
//
// Card #182 review (2026-11-13). The shipped strip after about 20 s of silence says exactly Destin's words and drops the older
// strips' reassurance ("Your draft is kept. Press Send again once you're reconnected."). Two pictures to choose between:
//   A. as built — his sentence alone.
//   B. his sentence as the main line, with the existing draft reassurance as the smaller detail line the other strips use.
// NOT WIRED IN: B exists only here. Both draw the real StatusStrip at phone width.
// Reached at ?mode=workbench&child=1&view=unreachable-strip (routing in index.tsx). Dev-only.
import React from 'react';
import { StatusStrip } from '../../../components/ui';
import { ThemeBg } from '../../../components/ThemeBg';
import { UNREACHABLE_MESSAGE } from '../../../components/ConnectionStrip';

export function UnreachableStripDemo() {
  const variant = new URLSearchParams(window.location.search).get('variant') ?? 'a';
  return (
    <div className="relative min-h-screen text-fg p-3">
      <ThemeBg />
      <div className="relative">
        <h1 className="text-sm font-semibold mb-0.5">{variant === 'b' ? 'B. With the draft line' : 'A. As built'}</h1>
        <p className="text-2xs text-fg-dim mb-3">{variant === 'b' ? 'His sentence, then the smaller line the other strips use.' : 'His sentence alone.'}</p>
        <div className="px-2 pb-1.5">
          <StatusStrip tone="warn" detail={variant === 'b' ? 'Your draft is kept. Press Send again once you’re reconnected.' : undefined}>
            {UNREACHABLE_MESSAGE}
          </StatusStrip>
        </div>
      </div>
    </div>
  );
}
