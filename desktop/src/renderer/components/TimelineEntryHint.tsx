// The "archived — not in Claude's context" hover hint on a chat entry, attached
// only to the entries that have one.
//
// WHY this exists (2026-09-23): ChatView used to wrap EVERY timeline entry in a
// <Tooltip>, whose text is empty for everything below the last /compact or
// /clear — i.e. almost always. Each one still ran three pieces of state, five
// refs and its effects on every render of the chat, and a streaming chat renders
// once per word: thousands of do-nothing tooltips per word in a long
// conversation, in every open tab.
//
// WHY not simply `hint ? <Tooltip>{entry}</Tooltip> : entry`: that swaps the
// entry's parent between two component types the moment /compact archives it,
// and React REBUILDS an element whose parent type changed. Every entry above the
// new line would be torn down and recreated — losing its 150 ms fade to 60%
// (the new element would just appear faded), collapsing any card the reader had
// opened, and paying a full re-render of the visible messages at the moment the
// compact lands. So the entry element never moves; this sits BESIDE it and
// hands the real <Tooltip> an invisible stand-in that forwards everything —
// the hover/press handlers, the ref Tooltip measures from, and the `data-hint`
// / aria attributes — onto the entry element itself. The DOM is the same as it
// was with the wrapping Tooltip: Tooltip cloned its child (no wrapper element),
// so the entry carried exactly these attributes and nothing else.
//
// Guard: tests/timeline-entry-hint.test.tsx.
import React, { useLayoutEffect, useRef } from 'react';
import { Tooltip } from './ui';

/** React prop name → the native event it rides on. onFocus/onBlur are React's
 *  bubbling focus events, which are the native focusin/focusout. */
const EVENTS: ReadonlyArray<readonly [string, string]> = [
  ['onPointerEnter', 'pointerenter'],
  ['onPointerLeave', 'pointerleave'],
  ['onPointerDown', 'pointerdown'],
  ['onPointerMove', 'pointermove'],
  ['onPointerUp', 'pointerup'],
  ['onPointerCancel', 'pointercancel'],
  ['onFocus', 'focusin'],
  ['onBlur', 'focusout'],
];

/** Attributes Tooltip puts on its child. */
const ATTRS = ['data-hint', 'aria-label', 'aria-describedby'] as const;

type StandInProps = {
  entryKey: string;
  getEntry: (key: string) => HTMLElement | undefined;
  // Tooltip clones this element with its handlers, attributes and ref.
  ref?: React.Ref<HTMLElement>;
  [prop: string]: unknown;
};

function setRef(ref: React.Ref<HTMLElement> | undefined, node: HTMLElement | null): void {
  if (typeof ref === 'function') ref(node);
  else if (ref && typeof ref === 'object') (ref as React.MutableRefObject<HTMLElement | null>).current = node;
}

/** Renders nothing; applies what Tooltip gave it to the entry element instead. */
function EntryStandIn(props: StandInProps) {
  // Latest props for the listeners below, which are attached once per element:
  // Tooltip hands over fresh handler closures every render.
  const latest = useRef(props);
  latest.current = props;
  const { entryKey, getEntry } = props;

  useLayoutEffect(() => {
    const el = getEntry(entryKey);
    if (!el) return;
    setRef(latest.current.ref, el);
    const bound = EVENTS.map(([prop, type]) => {
      const fn = (e: Event) => {
        const handler = latest.current[prop];
        // Tooltip reads only pointerType / clientX / clientY, which the native
        // event carries under the same names.
        if (typeof handler === 'function') handler(e);
      };
      el.addEventListener(type, fn);
      return [type, fn] as const;
    });
    return () => {
      for (const [type, fn] of bound) el.removeEventListener(type, fn);
      for (const name of ATTRS) el.removeAttribute(name);
      setRef(latest.current.ref, null);
    };
  }, [entryKey, getEntry]);

  // Every commit: Tooltip's attributes change with its open state
  // (aria-describedby) and with the hint text.
  useLayoutEffect(() => {
    const el = getEntry(entryKey);
    if (!el) return;
    for (const name of ATTRS) {
      const value = props[name];
      if (value == null) el.removeAttribute(name);
      else el.setAttribute(name, String(value));
    }
  });

  return null;
}

/**
 * The hover hint for one entry. Render it as the entry element's NEXT SIBLING,
 * inside the same keyed fragment, so the entry keeps its place in the tree
 * whether or not a hint exists.
 */
export function TimelineEntryHint({ text, entryKey, getEntry }: {
  text: string;
  entryKey: string;
  /** The live entry element for a key (ChatView records them as refs attach). */
  getEntry: (key: string) => HTMLElement | undefined;
}) {
  return (
    <Tooltip text={text}>
      <EntryStandIn entryKey={entryKey} getEntry={getEntry} />
    </Tooltip>
  );
}
