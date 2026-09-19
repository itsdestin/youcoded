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
import { Button, TextInput } from '../ui';
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

/** What the whole internet means in practice, spelled out under its sentence
 *  (review round 1, C-4: "clearer about what the permission actually means in
 *  practice, and associated risks"). The last line is true because an
 *  open-internet page never also holds a key or sign-in (deck Q-open-mix). */
const OPEN_INTERNET_MEANS = [
  'It can load from, and send to, any site. There is no fixed list.',
  'Anything you type or paste into this page could be sent somewhere you did not choose.',
  'It still cannot see your files, your other pages, or your saved keys and sign-ins.',
];

/** No glyph beside the sentence (review round 1: "remove the key symbol",
 *  "drop icon") — the words carry it. */
function ConnectionLine({ c, children, small }: { c: PageConnectionStatus; children?: React.ReactNode; small?: boolean }) {
  const words = describeConnection(c);
  return (
    <div className="flex flex-col gap-1.5" data-page-connection={c.kind}>
      <div className={`${small ? 'text-xs' : 'text-sm'} text-fg-2 leading-relaxed`}>
        {words.what} <span className="text-fg-dim">{words.limit}</span>
      </div>
      {children}
    </div>
  );
}

/** How to find a key: the page's author may supply the steps (they travel with
 *  the page); otherwise a general pointer. Shown as the author's words, not the
 *  app's, because the app cannot vouch for them. */
function KeyHelp({ c }: { c: PageConnectionStatus & { kind: 'key' } }) {
  const steps = c.keyHelp?.steps ?? [];
  if (steps.length === 0) {
    return (
      <div className="text-sm text-fg-2 leading-relaxed">
        Sign in on {c.service}'s website and look for a section called API, Developer or Integrations. Copy the key shown there.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-fg-dim">Where to find it, from this page's author:</div>
      <ol className="list-decimal pl-5 text-sm text-fg-2 leading-relaxed flex flex-col gap-0.5">
        {steps.map((t, i) => <li key={i}>{t}</li>)}
      </ol>
    </div>
  );
}

/** Shown IN PLACE OF the page until every line is approved (decks Q-own-pages,
 *  S-change, S-key-entry). Same card species as the library's welcome card;
 *  actions stack full width, primary over secondary, like the app's dialogs.
 *
 *  TWO STEPS when a key must be typed (review round 1, C-1: "the explanation of
 *  the permission and the key entry are kinda separate things… just have a
 *  continue button, then a second page that has instructions for how to find
 *  the relevant key"): step 1 is what the page may do, step 2 is the key. */
export function PageApproval({ page, onNotNow }: { page: PageSummary; onNotNow: () => void }) {
  const all = page.connections ?? [];
  const asking = all.filter((c) => !c.approved);
  const already = all.filter((c) => c.approved);
  // A re-ask after an edit shows what was already allowed too, so the new line
  // is read in context; the first ask has nothing approved yet.
  const isChange = already.length > 0;
  const [step, setStep] = useState<'what' | 'keys'>('what');
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [differentKey, setDifferentKey] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const here = keysEnteredHere();

  const keyLines = asking.filter((c): c is PageConnectionStatus & { kind: 'key' } => c.kind === 'key');
  const toType = keyLines.filter((c) => !c.savedKey || differentKey[c.id]);
  const missingKey = toType.some((c) => !(keys[c.id] ?? '').trim());

  const allow = async () => {
    const b = bridge();
    if (!b?.approve) return;
    setBusy(true);
    const sent: Record<string, string> = {};
    for (const c of keyLines) sent[c.id] = toType.includes(c) ? keys[c.id].trim() : 'saved';
    try { publishPages(await b.approve(page.id, sent)); } finally { setBusy(false); }
  };

  const shell = (children: React.ReactNode) => (
    <div className="absolute inset-0 overflow-y-auto flex items-center justify-center max-sm:items-start p-4 select-none" data-page-approval={step}>
      <div className="w-full max-w-xl bg-panel border border-edge rounded-lg p-5 sm:p-6 flex flex-col gap-4">{children}</div>
    </div>
  );
  const heading = (eyebrow: string, title: string) => (
    <div className="flex items-center gap-3">
      <span aria-hidden="true" className="shrink-0 inline-flex w-10 h-10 rounded-md bg-inset border border-edge-dim items-center justify-center text-fg-2">
        <PageGlyph icon={page.icon} className="w-5 h-5" />
      </span>
      <div className="min-w-0">
        <div className="text-2xs font-medium text-fg-muted tracking-wider uppercase">{eyebrow}</div>
        <h3 className="text-base font-semibold text-fg leading-snug">{title}</h3>
      </div>
    </div>
  );

  if (step === 'keys') {
    const names = toType.map((c) => c.service);
    return shell(<>
      {heading('One more step', names.length === 1 ? `Add your ${names[0]} key` : 'Add your keys')}
      {toType.map((c) => (
        <div key={c.id} className="flex flex-col gap-3" data-page-key-step={c.service}>
          {toType.length > 1 && <div className="text-sm font-medium text-fg">{c.service}</div>}
          <KeyHelp c={c} />
          <TextInput
            type="password"
            autoComplete="off"
            aria-label={`Your ${c.service} key`}
            placeholder={`Paste your ${c.service} key`}
            value={keys[c.id] ?? ''}
            onChange={(e) => setKeys((m) => ({ ...m, [c.id]: e.target.value }))}
            className="select-text"
          />
        </div>
      ))}
      <div className="text-xs text-fg-muted leading-relaxed">YouCoded keeps your key. The page never sees it.</div>
      <div className="flex flex-col gap-2">
        <Button variant="primary" onClick={() => { void allow(); }} disabled={busy || missingKey} className="w-full">
          {busy ? 'Allowing…' : 'Allow and open'}
        </Button>
        <Button variant="secondary" onClick={() => setStep('what')} className="w-full">Back</Button>
      </div>
    </>);
  }

  return shell(<>
    {heading(isChange ? 'This page changed' : 'Before this page opens', isChange ? `${page.name} wants additional permissions` : `${page.name} wants to connect`)}

    <div className="flex flex-col gap-2">
      <div className="text-xs text-fg-dim">{isChange ? 'New — this page would also be able to:' : 'This page would be able to:'}</div>
      <div className="rounded-lg border border-edge bg-inset/40 p-3 flex flex-col gap-3">
        {asking.map((c) => (
          <ConnectionLine key={c.id} c={c}>
            {c.kind === 'open' && (
              <ul className="list-disc pl-5 text-xs text-fg-muted leading-relaxed flex flex-col gap-0.5" data-open-internet-means>
                {OPEN_INTERNET_MEANS.map((t) => <li key={t}>{t}</li>)}
              </ul>
            )}
            {c.kind === 'key' && c.savedKey && (
              <div className="flex items-center gap-2 text-xs text-fg-muted" data-saved-key-offer>
                <span>{differentKey[c.id] ? `You'll paste a different ${c.service} key next.` : `Uses your saved ${c.service} key.`}</span>
                {here && (
                  <Button variant="secondary" size="sm" onClick={() => setDifferentKey((m) => ({ ...m, [c.id]: !m[c.id] }))}>
                    {differentKey[c.id] ? 'Use the saved key' : 'Use a different key'}
                  </Button>
                )}
              </div>
            )}
          </ConnectionLine>
        ))}
      </div>
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
      {/* On the phone a key cannot be typed (deck Q-phone). The button sits where
          Allow would, greyed, with the reason under it (review round 1, C-5). */}
      {toType.length > 0 && !here ? (
        <>
          <Button variant="primary" disabled className="w-full" data-finish-on-computer>Finish on your computer</Button>
          <div className="text-xs text-fg-muted leading-relaxed text-center">
            Adding a key isn't supported on the phone yet. Open this page on your computer to set it up.
          </div>
        </>
      ) : toType.length > 0 ? (
        <Button variant="primary" onClick={() => setStep('keys')} className="w-full">Continue</Button>
      ) : (
        <Button variant="primary" onClick={() => { void allow(); }} disabled={busy} className="w-full">
          {busy ? 'Allowing…' : 'Allow and open'}
        </Button>
      )}
      <Button variant="secondary" onClick={onNotNow} className="w-full">Not now</Button>
    </div>
  </>);
}

/** One page's connections, opened from its library card (deck Q-manage). */
export function PageConnectionsDialog({ page, onClose, onConnect }: { page: PageSummary | null; onClose: () => void; onConnect: (pageId: string) => void }) {
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
            <ConnectionLine c={c} small />
            {confirming === c.id ? (
              <div className="flex flex-col gap-2">
                <div className="text-2xs text-fg-2 leading-relaxed" data-remove-confirm>
                  This stops future use. It cannot undo anything the page already sent or received. The page will ask again next time it opens.
                </div>
                {/* Right-aligned, Remove rightmost (review round 1, C-10). */}
                <div className="flex items-center justify-end gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setConfirming(null)}>Never mind</Button>
                  <Button variant="danger" size="sm" onClick={() => { void remove(c.id); }}>Remove</Button>
                </div>
              </div>
            ) : (
              // Not connected yet: offer to connect, bottom right, instead of a
              // "waiting" label (review round 1, C-9). It opens the page, whose
              // approval card is the one place a connection is agreed to.
              <div className="flex justify-end">
                {c.approved
                  ? <Button variant="secondary" size="sm" onClick={() => setConfirming(c.id)}>Remove</Button>
                  : <Button variant="primary" size="sm" data-connect onClick={() => { if (page) onConnect(page.id); }}>Connect</Button>}
              </div>
            )}
          </div>
        ))}
        {list.length > 0 && <div className="text-2xs text-fg-muted leading-relaxed">Saved keys are kept under Settings › Account › Connected services.</div>}
      </div>
    </Dialog>
  );
}
