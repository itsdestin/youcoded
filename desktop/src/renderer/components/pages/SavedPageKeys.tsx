// SavedPageKeys — the keys pasted for pages, under Settings › Account ›
// Connected accounts (Pages Phase 2, deck Q-manage). This answers "which keys
// have I saved, and who uses them?"; a page's own card answers "what can this
// page reach?". Deleting a key here cuts off every page using it at once.
// The key itself is never shown: it lives in the computer's secure storage
// with the model-provider keys, and nothing in the renderer can read it back.
import React, { useEffect, useState } from 'react';
import type { PagesBridge, SavedPageKey } from '../../../shared/pages-types';
import { Button } from '../ui';

function bridge(): PagesBridge | undefined {
  return (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
}

export function SavedPageKeys() {
  const [keys, setKeys] = useState<SavedPageKey[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void bridge()?.savedKeys?.().then((k) => { if (live) setKeys(k); });
    return () => { live = false; };
  }, []);
  // Nothing saved (or a host without page connections): the section stays away
  // instead of showing an empty heading.
  if (!keys || keys.length === 0) return null;

  // A key is identified by service AND address (design review 1, finding 3), so
  // both the row's identity and the delete carry both: two keys can share a
  // service name and point at different websites, and deleting by name alone
  // would take the wrong one.
  const rowId = (k: SavedPageKey) => `${k.service}|${k.address}`;
  const remove = async (k: SavedPageKey) => {
    const next = await bridge()?.deleteSavedKey?.(k.service, k.address);
    if (next) setKeys(next);
    setConfirming(null);
  };

  return (
    <div className="space-y-2" data-saved-page-keys>
      <div className="text-2xs font-medium text-fg-muted tracking-wider uppercase">Keys saved for pages</div>
      {keys.map((k) => (
        <div key={rowId(k)} className="rounded-lg border border-edge bg-inset/40 p-3 space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-xs text-fg font-medium">{k.service} <span className="text-fg-muted font-normal">· {k.address}</span></div>
              <div className="text-3xs text-fg-muted">
                {k.usedBy.length === 0 ? 'No page uses this key.' : `Used by ${k.usedBy.map((p) => p.name).join(', ')}.`}
              </div>
            </div>
            {confirming !== rowId(k) && (
              <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setConfirming(rowId(k))}>Delete</Button>
            )}
          </div>
          {confirming === rowId(k) && (
            <div className="space-y-2">
              <p className="text-2xs text-fg-2 leading-relaxed">
                This deletes the key from this computer and stops {k.usedBy.length === 1 ? 'that page' : 'those pages'} using it. It does not cancel the key with {k.service}; do that on their website if you need to.
              </p>
              <div className="flex items-center gap-2">
                <Button variant="danger" size="sm" onClick={() => { void remove(k); }}>Delete key</Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirming(null)}>Never mind</Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
