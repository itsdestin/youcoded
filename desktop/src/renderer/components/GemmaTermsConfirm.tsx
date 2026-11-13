import React, { useCallback, useState } from 'react';
import { Button, Dialog, OneJobCard, OneJobText } from './ui';
import { useScreenOpen } from '../shoot-mode';
import { gemmaNoticeFor, type GemmaNotice } from '../../shared/gemma-terms';

// The short "before you download" popup for Gemma models (card #45). Cancel and Download, nothing else to fill in.
// WHY a popup and not a line on the screen: Destin, 2026-11-12 ("a short confirmation popup after clicking
// download/continue, that offers cancel/download buttons"). WHY one hook both download buttons share: first-run
// setup, Settings > Local models and "Add from Hugging Face" all draw the same RepoCard / quant rows, so gating
// there covers all three with no way for one to drift.
// WHY the words are two (docs/error-message-standards.md: never present a guess as knowledge): the Gemma 4 wording
// states what the model's own page says (see shared/gemma-terms.ts for the sources); any other Gemma build says
// plainly that its terms were not checked.

function GemmaTermsDialog({ notice, onCancel, onDownload }: { notice: GemmaNotice; onCancel: () => void; onDownload: () => void }) {
  const open = (url: string) => { void (window as any).claude?.shell?.openExternal?.(url); };
  return (
    <Dialog open onClose={onCancel} title={notice.kind === 'apache' ? 'Download Gemma 4?' : 'Download this Gemma model?'} size="panel" layer={3} screen="settings/assistant/local/gemma-terms">
      <OneJobCard actions={<>
        <Button onClick={onDownload}>Download</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </>}>
        <OneJobText>
          {notice.kind === 'apache' ? (
            <>
              <p>Gemma is made by Google. Gemma 4 is shared under the Apache 2.0 licence, which lets you use it freely, including for work.</p>
              <p>By downloading it you agree to that licence.</p>
              <p><button className="text-accent underline link-control" onClick={() => open(notice.licenceUrl)}>Read the licence</button></p>
            </>
          ) : (
            <>
              <p>Gemma is made by Google. Earlier Gemma models were shared under Google&apos;s own Gemma terms, which can pass some limits on use on to you.</p>
              <p>YouCoded has not checked the terms of this exact model. Check its page on Hugging Face before you use it.</p>
            </>
          )}
        </OneJobText>
      </OneJobCard>
    </Dialog>
  );
}

/** `ask(go)`: runs `go` straight away for any model that is not Gemma, otherwise shows the popup and runs it on Download. */
export function useGemmaTermsGate(repo: string, shootOpener = false): { ask: (go: () => void) => void; dialog: React.ReactNode } {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const notice = gemmaNoticeFor(repo);
  const ask = useCallback((go: () => void) => {
    if (!notice) go(); else setPending(() => go);
  }, [notice]);
  // Photo-only build: `shoot` opens the popup by name, on the first Gemma 4 card only (one opener, however many cards mount).
  useScreenOpen('settings/assistant/local/gemma-terms', () => setPending(() => () => {}), undefined, shootOpener && /gemma-4-e4b/i.test(repo));
  const dialog = pending && notice ? (
    <GemmaTermsDialog notice={notice} onCancel={() => setPending(null)} onDownload={() => { const go = pending; setPending(null); go(); }} />
  ) : null;
  return { ask, dialog };
}
