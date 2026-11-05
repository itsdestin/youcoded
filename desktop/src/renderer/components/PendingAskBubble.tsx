import type { ReactNode } from 'react';

/** The frosted bubble a pending permission ask sits in at the bottom of the chat.
 *
 *  WHY one shared wrapper (Destin, 2026-11-02, on the browser's form ask: "why is it
 *  transparent instead of frosted?"): the chat's asks are not drawn straight on the chat.
 *  Each sits in an assistant bubble, and theme-engine's glass rule is
 *  `[data-wallpaper] .in-view .bg-inset` - a bubble that is a DESCENDANT of an `.in-view`
 *  element gets the blur. The browser's card had `bg-inset in-view` on the SAME element, so
 *  it got the see-through colour but never the blur (the rule needs the ancestor), and the
 *  wallpaper showed straight through. Both ChatView's tool asks and the browser's asks
 *  now come through this one wrapper, so they cannot drift apart again. */
export function PendingAskBubble({ children }: { children: ReactNode }) {
  return (
    <div className="in-view flex justify-start px-4 py-0.5">
      <div className="assistant-bubble max-w-[85%] rounded-2xl rounded-bl-sm bg-inset px-5 py-3">
        {children}
      </div>
    </div>
  );
}
