// "Open this website?" — asked before a page opens an address in the browser
// (pages-finish deck 1, Q-popups: "Ask, unless the site is already approved").
//
// WHY ask at all: the address itself can carry information. A page that reads
// your chats or uses a saved key could open an address with that information in
// it, and before this any page could open any address with no question. A link
// to a site the page may already reach, or one the person said not to ask
// about again, opens straight away; everything else stops here, with the WHOLE
// address shown so nothing leaves unseen.
//
// Shape: a one-job popup (guide "Popups": Rename session, Connect OpenRouter) —
// one card holding the words, the address, the "don't ask again" switch and the
// two stacked buttons, main on top. The switch is off every time: remembering a
// site is a choice made per ask, and Page settings lists it so it can be undone.
import React, { useState } from 'react';
import type { PageSummary, PagesBridge } from '../../../shared/pages-types';
import { Button, CARD_LEVEL_2, SettingRow, Toggle } from '../ui';
import { Dialog } from '../ui/Dialog';
import { OneJobCard, OneJobText } from '../ui/OneJobCard';
import { splitAddress } from './page-connections';
import { publishPages } from './use-pages';

function bridge(): PagesBridge | undefined {
  return (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
}

/** The address as it is read: the real website solid, its front dim, then the
 *  rest of the address (path and anything after it) in full, so information
 *  riding in it can be seen. */
function FullAddress({ url }: { url: URL }) {
  const { prefix, site } = splitAddress(url.hostname);
  const rest = `${url.port ? `:${url.port}` : ''}${url.pathname === '/' && !url.search && !url.hash ? '' : url.pathname}${url.search}${url.hash}`;
  return (
    <div className={`${CARD_LEVEL_2} px-3 py-2 text-sm leading-relaxed break-all select-text max-h-32 overflow-y-auto scroll-mask`} data-open-address={url.hostname}>
      <span className="text-fg-dim">{url.protocol}//{prefix}</span>
      <span className="text-fg font-medium">{site}</span>
      <span className="text-fg-dim">{rest}</span>
    </div>
  );
}

export function PageOpenWebsite({ page, url, onClose }: { page: PageSummary | null; url: string | null; onClose: () => void }) {
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  let parsed: URL | null = null;
  try { parsed = url ? new URL(url) : null; } catch { parsed = null; }
  const open = page !== null && parsed !== null;
  const close = () => { setRemember(false); onClose(); };
  const go = async () => {
    const b = bridge();
    if (!page || !url) return;
    setBusy(true);
    try {
      if (b?.openWebsite) publishPages(await b.openWebsite(page.id, url, remember));
    } finally {
      setBusy(false);
      close();
    }
  };
  const site = parsed ? splitAddress(parsed.hostname).site : '';
  return (
    <Dialog screen="pages/page/open-website" open={open} onClose={close} layer={3} size="panel" title="Open this website?" onEnter={() => { void go(); }}>
      {page && parsed && (
        <OneJobCard
          actions={<>
            <Button variant="primary" onClick={() => { void go(); }} disabled={busy}>Open in browser</Button>
            <Button variant="secondary" onClick={close}>Cancel</Button>
          </>}
        >
          <OneJobText>{page.name} wants to open this address in your web browser:</OneJobText>
          <FullAddress url={parsed} />
          <OneJobText under>Anything in the address goes to {site} when it opens.</OneJobText>
          <SettingRow
            header
            variant="item"
            title={`Don't ask again for ${site}`}
            description="Only for this page. You can change it in Page settings."
            control={<Toggle checked={remember} onChange={setRemember} aria-label={`Don't ask again for ${site}`} />}
          />
        </OneJobCard>
      )}
    </Dialog>
  );
}
