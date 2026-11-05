// PageChangeRow — the line that ends a page-assistant reply which changed the page or what it holds, with Undo
// (pages-finish step 3, the Undo round). DESIGN STAGE: Undo flips this row only; putting the page back (a history
// point taken before each reply, restored by Undo) is the build's job.
//
// WHY a quiet line in the reply and not a toast or a card: KeepGoingRow is the app's precedent for "the way on
// after a reply" and sits in the reply's own flow, so it scrolls with the change it belongs to; a toast would
// vanish before someone noticed the change was wrong, and a card would make every small edit look like an event.
import React, { useState } from 'react';
import type { ToolCallState } from '../../../shared/types';
import { Button } from '../ui';
import { workbenchPageUndo } from '../../workbench-mode';

export type PageChangeKind = 'page' | 'data';

/** What a reply changed: the page itself (its files) wins over what it holds, because undoing it undoes both. */
export function pageChangeOf(steps: ToolCallState[]): PageChangeKind | null {
  let kind: PageChangeKind | null = null;
  for (const t of steps) {
    if (t.status === 'failed') continue;
    if (t.toolName === 'Edit' || t.toolName === 'Write' || t.toolName === 'MultiEdit') {
      const path = typeof t.input.file_path === 'string' ? t.input.file_path : '';
      if (/[\\/]Pages[\\/]/.test(path)) return 'page';
    }
    if (t.toolName === 'mcp__youcoded-pages__UpdatePageData') kind = 'data';
  }
  return kind;
}

const LABEL: Record<PageChangeKind, string> = {
  page: 'Changed the page',
  data: 'Changed the page’s information',
};

export function PageChangeRow({ kind }: { kind: PageChangeKind }) {
  // DESIGN STAGE: `?pageUndone=1` starts the page change undone, so the after-state can be photographed.
  const [undone, setUndone] = useState(() => kind === 'page' && workbenchPageUndo().undone);
  return (
    <div className="page-change-row flex items-center gap-2 mt-2 pt-1.5 border-t border-edge-dim select-none" data-page-change={kind}>
      <span className={`flex-1 min-w-0 truncate text-xs ${undone ? 'text-fg-faint line-through' : 'text-fg-muted'}`}>{LABEL[kind]}</span>
      {undone && <span className="text-xs text-fg-muted">Undone</span>}
      <Button size="sm" variant="ghost" onClick={() => setUndone((u) => !u)}>{undone ? 'Redo' : 'Undo'}</Button>
    </div>
  );
}
