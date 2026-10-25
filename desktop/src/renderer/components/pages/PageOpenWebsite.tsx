// "Open this website?" — asked before a page opens an address in the browser
// (pages-finish deck 1, Q-popups: "Ask, unless the site is already approved";
// approved screen S-open-website).
//
// WHY ask at all: the address itself can carry information. A page that reads
// your chats or uses a saved key could open an address with that information in
// it, and before this any page could open any address with no question. A link
// to a site the page may already reach, or one the person said not to ask
// about again, opens straight away (shared/page-open-rule.ts decides); everything
// else stops here, with the WHOLE address shown so nothing leaves unseen.
//
// Shape: a one-job popup (guide "Popups": Rename session, Connect OpenRouter) —
// one card holding the words, the address, the "don't ask again" switch and the
// two stacked buttons, main on top. The switch is off every time: remembering a
// site is a choice made per ask, and Page settings lists it so it can be undone.
//
// WHY no Enter (design review 1, finding 13): the page can raise this while the
// person is typing in it, and an Enter meant for the page must never open a site.
import React, { useState } from 'react';
import type { PageSummary } from '../../../shared/pages-types';
import { Button, CARD_LEVEL_2, ErrorState, SettingRow, Toggle } from '../ui';
import { Dialog } from '../ui/Dialog';
import { OneJobCard, OneJobText } from '../ui/OneJobCard';
import { splitAddress } from './page-connections';

/** The address as it is read: the real website solid, its front dim, then the
 *  rest of the address (path and anything after it) in full, so information
 *  riding in it can be seen. A mail address is shown whole. */
function FullAddress({ url }: { url: URL }) {
  if (url.protocol === 'mailto:') {
    return <div className={`${CARD_LEVEL_2} px-3 py-2 text-sm leading-relaxed break-all select-text max-h-32 overflow-y-auto scroll-mask text-fg`} data-open-address="mailto">{url.href}</div>;
  }
  const { prefix, site } = splitAddress(url.hostname);
  const rest = `${url.port ? `:${url.port}` : ''}${url.pathname === '/' && !url.search && !url.hash ? '' : url.pathname}${url.search}${url.hash}`;
  return (
    <div className={`${CARD_LEVEL_2} px-3 py-2 text-sm leading-relaxed break-all select-text max-h-32 overflow-y-auto scroll-mask`} data-open-address={url.hostname}>
      <span className="text-fg-dim">{`${url.protocol}//${prefix}`}</span>
      <span className="text-fg font-medium">{site}</span>
      <span className="text-fg-dim">{rest}</span>
    </div>
  );
}

/** `onConfirm` does the opening (the host knows whether this screen can open an
 *  address itself) and answers null, or the sentence to show when it failed. */
export function PageOpenWebsite({ page, url, onConfirm, onClose }: {
  page: PageSummary | null;
  url: string | null;
  onConfirm: (url: string, remember: boolean) => Promise<string | null>;
  onClose: (cancelled: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  let parsed: URL | null = null;
  try { parsed = url ? new URL(url) : null; } catch { parsed = null; }
  const open = page !== null && parsed !== null;
  const mail = parsed?.protocol === 'mailto:';
  const close = (cancelled: boolean) => { setRemember(false); setFailure(null); onClose(cancelled); };
  const go = async () => {
    if (!url || busy) return;
    setBusy(true);
    setFailure(null);
    const problem = await onConfirm(url, remember && !mail).catch(() => "The address couldn't be opened.");
    setBusy(false);
    if (problem) setFailure(problem); else close(false);
  };
  const site = parsed && !mail ? splitAddress(parsed.hostname).site : '';
  return (
    <Dialog screen="pages/page/open-website" open={open} onClose={() => close(true)} layer={3} size="panel" title={mail ? 'Write this email?' : 'Open this website?'}>
      {page && parsed && (
        <OneJobCard
          actions={<>
            <Button variant="primary" onClick={() => { void go(); }} disabled={busy}>{mail ? 'Open in mail' : 'Open in browser'}</Button>
            <Button variant="secondary" onClick={() => close(true)}>Cancel</Button>
          </>}
        >
          <OneJobText>{mail ? `${page.name} wants to start an email to this address in your mail program:` : `${page.name} wants to open this address in your web browser:`}</OneJobText>
          <FullAddress url={parsed} />
          <OneJobText under>{mail ? 'Anything in the address goes into the new email, which you see before it is sent.' : `Anything in the address goes to ${site} when it opens.`}</OneJobText>
          {/* No switch for mail: there is no site to remember (design review 1, finding 4). */}
          {!mail && (
            <SettingRow
              header
              variant="item"
              title={`Don't ask again for ${site}`}
              description="Only for this page. You can change it in Page settings."
              control={<Toggle checked={remember} onChange={setRemember} aria-label={`Don't ask again for ${site}`} />}
            />
          )}
          {failure && <ErrorState variant="inline" message={failure} onRetry={() => { void go(); }} />}
        </OneJobCard>
      )}
    </Dialog>
  );
}
