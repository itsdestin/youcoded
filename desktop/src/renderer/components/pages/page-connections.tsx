// Page connections — the words, the approval screen and the per-page list
// (Pages Phase 2; decided on two questions decks, 2026-09-19).
//
// ONE function writes the sentence for a connection, so the approval screen,
// the card's list and Settings can never describe the same access two ways.
// The wording rules come from the decks and are load-bearing:
//   - access is a plain sentence per thing reached, no levels or badges;
//   - "look-up only" is enforced by the app, so "Cannot send changes" is true
//     as written — but never "read-only" or "safe" for an outside service;
//   - the whole internet is its own blunt line, never softened;
//   - Remove "stops future use", never "revokes": the app cannot take back
//     what a service already received.
import React, { useState } from 'react';
import type { PageConnection, PageConnectionStatus, PageSummary, PagesBridge } from '../../../shared/pages-types';
import { isRemoteMode } from '../../platform';
import { isWorkbenchMode } from '../../workbench-mode';
import { Badge, Button, TextInput } from '../ui';
import { Dialog } from '../ui/Dialog';
import { PageGlyph } from './page-icons';
import { publishPages } from './use-pages';

function bridge(): PagesBridge | undefined {
  return (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
}

/** A new key is typed on the computer only (deck Q-phone): over remote access
 *  the approval says "Finish setting this up on your computer" instead of
 *  showing a key box. `?pagesPhone=1` shows that state in the workbench. */
export function keysEnteredHere(): boolean {
  if (isWorkbenchMode() && new URLSearchParams(location.search).get('pagesPhone') === '1') return false;
  return !isRemoteMode();
}

/** The sentence for one connection. `what` is the main clause; `limit` is the
 *  quieter second sentence. Written to follow "This page can…". */
export function describeConnection(c: PageConnection): { what: string; limit: string } {
  switch (c.kind) {
    case 'youcoded':
      return { what: "Look things up on YouCoded's own service using your YouCoded sign-in.", limit: 'Cannot send changes.' };
    case 'key':
      return c.access === 'lookup'
        ? { what: `Look things up on ${c.address} using your ${c.service} key.`, limit: 'Cannot send changes.' }
        : { what: `Look up and change things on ${c.address} using your ${c.service} key.`, limit: 'It can do whatever that key allows.' };
    case 'public':
      return { what: `Read public information from ${c.address}.`, limit: 'No key or sign-in is used.' };
    case 'github':
      return c.access === 'lookup'
        ? { what: 'Look things up on GitHub using your GitHub sign-in.', limit: 'Cannot send changes.' }
        : { what: 'Look up and change things on GitHub using your GitHub sign-in.', limit: 'That includes your repositories.' };
    case 'open':
      return { what: 'Reach any website.', limit: 'Anything shown in this page, or typed into it, could be sent anywhere.' };
  }
}

/** True while any line is waiting for a yes — the page stays closed until then. */
export function needsApproval(page: PageSummary | null): boolean {
  return !!page?.connections?.some((c) => !c.approved);
}

function ConnectionGlyph({ kind }: { kind: PageConnection['kind'] }) {
  const common = { className: 'w-4 h-4', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (kind === 'key') return <svg {...common}><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3L20 3M16.5 6.5l3 3M13.5 9.5l2.5 2.5" /></svg>;
  if (kind === 'youcoded' || kind === 'github') return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>;
  // public and open: the globe
  return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></svg>;
}

function ConnectionLine({ c, children, small }: { c: PageConnectionStatus; children?: React.ReactNode; small?: boolean }) {
  const words = describeConnection(c);
  return (
    <div className="flex items-start gap-2.5" data-page-connection={c.kind}>
      <span className="text-fg-dim inline-flex mt-0.5 shrink-0"><ConnectionGlyph kind={c.kind} /></span>
      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        <div className={`${small ? 'text-xs' : 'text-sm'} text-fg-2 leading-relaxed`}>
          {words.what} <span className="text-fg-dim">{words.limit}</span>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Shown IN PLACE OF the page until every line is approved (decks Q-own-pages,
 *  S-change, S-key-entry). Same card species as the library's welcome card;
 *  actions stack full width, primary over secondary, like the app's dialogs. */
export function PageApproval({ page, onNotNow }: { page: PageSummary; onNotNow: () => void }) {
  const all = page.connections ?? [];
  const asking = all.filter((c) => !c.approved);
  const already = all.filter((c) => c.approved);
  // A re-ask after an edit shows what was already allowed too, so the new line
  // is read in context; the first ask has nothing approved yet.
  const isChange = already.length > 0;
  const open = asking.some((c) => c.kind === 'open');
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [pasteInstead, setPasteInstead] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const here = keysEnteredHere();

  const keyLines = asking.filter((c): c is PageConnectionStatus & { kind: 'key' } => c.kind === 'key');
  const wantsNewKey = (c: PageConnectionStatus) => c.kind === 'key' && (!c.savedKey || pasteInstead[c.id]);
  const blockedOnComputer = !here && keyLines.some(wantsNewKey);
  const missingKey = keyLines.some((c) => wantsNewKey(c) && !(keys[c.id] ?? '').trim());

  const allow = async () => {
    const b = bridge();
    if (!b?.approve) return;
    setBusy(true);
    const sent: Record<string, string> = {};
    for (const c of keyLines) sent[c.id] = wantsNewKey(c) ? keys[c.id].trim() : 'saved';
    try { publishPages(await b.approve(page.id, sent)); } finally { setBusy(false); }
  };

  return (
    <div className="absolute inset-0 overflow-y-auto flex items-center justify-center max-sm:items-start p-4 select-none" data-page-approval>
      <div className="w-full max-w-xl bg-panel border border-edge rounded-lg p-5 sm:p-6 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="shrink-0 inline-flex w-10 h-10 rounded-md bg-inset border border-edge-dim items-center justify-center text-fg-2">
            <PageGlyph icon={page.icon} className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <div className="text-2xs font-medium text-fg-muted tracking-wider uppercase">{isChange ? 'This page changed' : 'Before this page opens'}</div>
            <h3 className="text-base font-semibold text-fg leading-snug">
              {isChange ? `${page.name} wants one more thing` : `${page.name} wants to connect`}
            </h3>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-xs text-fg-dim">{isChange ? 'New — this page would also be able to:' : 'This page would be able to:'}</div>
          <div className="rounded-lg border border-edge bg-inset/40 p-3 flex flex-col gap-3">
            {asking.map((c) => (
              <ConnectionLine key={c.id} c={c}>
                {c.kind === 'key' && c.savedKey && !pasteInstead[c.id] && (
                  <div className="flex items-center gap-2 text-xs text-fg-muted">
                    <span>Uses your saved {c.service} key.</span>
                    {here && <Button variant="ghost" size="sm" onClick={() => setPasteInstead((m) => ({ ...m, [c.id]: true }))}>Paste a different one</Button>}
                  </div>
                )}
                {wantsNewKey(c) && c.kind === 'key' && here && (
                  <div className="flex flex-col gap-1">
                    <TextInput
                      type="password"
                      autoComplete="off"
                      aria-label={`Your ${c.service} key`}
                      placeholder={`Paste your ${c.service} key`}
                      value={keys[c.id] ?? ''}
                      onChange={(e) => setKeys((m) => ({ ...m, [c.id]: e.target.value }))}
                      className="select-text"
                    />
                    <div className="text-2xs text-fg-muted leading-relaxed">
                      Kept by YouCoded on this computer and sent only to {c.address}. The page never sees it.
                    </div>
                  </div>
                )}
                {wantsNewKey(c) && !here && (
                  <div className="text-xs text-fg-muted">Needs a {c.kind === 'key' ? c.service : ''} key. Finish setting this up on your computer.</div>
                )}
              </ConnectionLine>
            ))}
          </div>
          {!open && <div className="text-xs text-fg-muted leading-relaxed">Everything else on the internet stays blocked for this page.</div>}
        </div>

        {isChange && (
          <div className="flex flex-col gap-2">
            <div className="text-xs text-fg-dim">Already allowed:</div>
            <div className="flex flex-col gap-2 px-3">
              {already.map((c) => <ConnectionLine key={c.id} c={c} />)}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          {!blockedOnComputer && (
            <Button variant="primary" onClick={() => { void allow(); }} disabled={busy || missingKey} className="w-full py-2.5">
              {busy ? 'Allowing…' : 'Allow and open'}
            </Button>
          )}
          <Button variant="secondary" onClick={onNotNow} className="w-full py-2.5">Not now</Button>
        </div>
      </div>
    </div>
  );
}

/** One page's connections, opened from its library card (deck Q-manage). */
export function PageConnectionsDialog({ page, onClose }: { page: PageSummary | null; onClose: () => void }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const remove = async (connectionId: string) => {
    const b = bridge();
    if (!page || !b?.removeConnection) return;
    publishPages(await b.removeConnection(page.id, connectionId));
    setConfirming(null);
  };
  const list = page?.connections ?? [];
  return (
    <Dialog open={page !== null} onClose={onClose} layer={3} size="panel" title={page ? `${page.name} · connections` : ''}>
      <div className="flex flex-col gap-3">
        {list.length === 0 && <div className="text-sm text-fg-muted">This page reaches nothing outside itself.</div>}
        {list.map((c) => (
          <div key={c.id} className="rounded-lg border border-edge bg-inset/40 p-3 flex flex-col gap-2">
            <ConnectionLine c={c} small>
              {!c.approved && <div><Badge>Waiting for your OK</Badge></div>}
            </ConnectionLine>
            {confirming === c.id ? (
              <div className="flex flex-col gap-2">
                <div className="text-2xs text-fg-2 leading-relaxed">
                  This stops future use. It cannot undo anything the page already sent or received. The page will ask again next time it opens.
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="danger" size="sm" onClick={() => { void remove(c.id); }}>Remove</Button>
                  <Button variant="secondary" size="sm" onClick={() => setConfirming(null)}>Never mind</Button>
                </div>
              </div>
            ) : c.approved && (
              <div className="flex justify-end">
                <Button variant="secondary" size="sm" onClick={() => setConfirming(c.id)}>Remove</Button>
              </div>
            )}
          </div>
        ))}
        {list.length > 0 && <div className="text-2xs text-fg-muted leading-relaxed">Saved keys are kept under Settings › Account › Connected accounts.</div>}
      </div>
    </Dialog>
  );
}
