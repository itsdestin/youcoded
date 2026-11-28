// WHY: hover hints are the app's own <Tooltip> now, not the browser's `title=` bubble, so the
// hint words sit on the control as `data-hint` (see Tooltip.tsx). Testing Library's *ByTitle
// queries look for `title`, so tests that asserted a hint's words use these instead - the
// assertion is unchanged, only where the words are read from.
import { waitFor } from '@testing-library/react';

type Root = ParentNode;
const matches = (value: string | null, want: string | RegExp) =>
  value != null && (typeof want === 'string' ? value === want : want.test(value));

export function queryAllByHint(root: Root, want: string | RegExp): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-hint]')).filter((el) => matches(el.getAttribute('data-hint'), want));
}
export function getAllByHint(root: Root, want: string | RegExp): HTMLElement[] {
  const found = queryAllByHint(root, want);
  if (found.length === 0) throw new Error(`No element has the hint ${String(want)}`);
  return found;
}
export function queryByHint(root: Root, want: string | RegExp): HTMLElement | null {
  return queryAllByHint(root, want)[0] ?? null;
}
export function getByHint(root: Root, want: string | RegExp): HTMLElement {
  return getAllByHint(root, want)[0];
}
export function findByHint(root: Root, want: string | RegExp): Promise<HTMLElement> {
  return waitFor(() => getByHint(root, want));
}
