// The Browser's ask card, drawn in the chat under the latest message while the
// assistant waits on the person (spec §1 "Asking first", "The assistant needs
// you"). ONE card for both session kinds: the asks are the Browser's own rules,
// not the session's permission system (design review 1 #1).
//
// Kinds: site permission (once per site per chat), final step (every time),
// home-network address, "needs you" hand-off, and "no browser — download one".
// Copy follows the spec glossary; buttons sit on the right with one primary
// (design guide G-4, G-28).
import { memo, useCallback, useState } from 'react';
import type { BrowserPrompt, PromptAnswer } from '../../../shared/browser-types';
import { openBrowserPane, useBrowserPaneOpen, useBrowserState } from '../../state/browser-store';
import { Button, ProgressBar } from '../ui';
import { GlobeIcon } from '../Icons';

function bridge() { return (window as any).claude.browser; }

interface Copy { title: string; body: string }

/** Plain-language title and body for a card (exported for tests). */
export function browserCardCopy(p: BrowserPrompt): Copy {
  switch (p.kind) {
    case 'site':
      return {
        title: p.message,
        body: p.allowAlways === false
          ? 'This is your own Chrome, where you\'re signed in. It still asks before sending, buying or deleting.'
          : 'It still asks before sending, buying or deleting.',
      };
    case 'final':
      return { title: p.message, body: 'This looks like a step that buys, sends, posts, deletes or submits something. It only happens if you allow it.' };
    case 'local':
      return { title: p.message, body: 'These pages can control your router, your devices or programs you\'re running.' };
    case 'handoff':
      return { title: 'The assistant needs you in the browser', body: p.message };
    case 'no-browser':
      return { title: 'Browser needed', body: 'YouCoded can download one for the assistant (about 150 MB, kept inside YouCoded).' };
  }
}

/** The buttons of a card whose answer is a plain choice (site, final step, home address, no browser) — the same
 *  on the computer and a phone. A hand-off's buttons differ by screen, so each card draws its own. */
function askActions(p: BrowserPrompt, answer: (a: PromptAnswer) => void, sending: boolean): React.ReactNode {
  const host = p.host ?? '';
  switch (p.kind) {
    case 'site':
      return (
        <>
          <Button variant="secondary" size="sm" disabled={sending} onClick={() => answer('no')}>Not now</Button>
          {p.allowAlways !== false && host && (
            <Button variant="secondary" size="sm" disabled={sending} onClick={() => answer('allow_always')}>Always allow {host}</Button>
          )}
          <Button variant="primary" size="sm" disabled={sending} onClick={() => answer('allow_chat')}>Allow for this chat</Button>
        </>
      );
    case 'final':
      return (
        <>
          <Button variant="secondary" size="sm" disabled={sending} onClick={() => answer('no')}>Don't allow</Button>
          <Button variant="primary" size="sm" disabled={sending} onClick={() => answer('once')}>Allow this once</Button>
        </>
      );
    case 'local':
      return (
        <>
          <Button variant="secondary" size="sm" disabled={sending} onClick={() => answer('no')}>Don't allow</Button>
          <Button variant="primary" size="sm" disabled={sending} onClick={() => answer('allow_chat')}>Allow for this chat</Button>
        </>
      );
    case 'no-browser':
      return (
        <>
          <Button variant="secondary" size="sm" disabled={sending} onClick={() => answer('no')}>Not now</Button>
          <Button variant="primary" size="sm" disabled={sending} onClick={() => answer('download')}>Download</Button>
        </>
      );
    default:
      return null;
  }
}

/**
 * The same card on a PHONE (2026-10-26, card #205: "build in remote browser approvals like every other approval card"). A phone
 * has no Browser of its own (capabilities.assistantBrowser is false), so the card comes from the conversation's `browserAsk`
 * fact the computer publishes, and the answer goes back over `browser:answer` (the one Browser channel a phone may use).
 * A hand-off needs the browser itself, so the phone says where to do it and offers only "I can't do this".
 */
export const PhoneBrowserAskCard = memo(function PhoneBrowserAskCard({ sessionId, prompt }: { sessionId: string; prompt: BrowserPrompt }) {
  const [sending, setSending] = useState(false);
  const answer = useCallback(async (a: PromptAnswer) => {
    setSending(true);
    try { await bridge().answer(sessionId, prompt.id, a); } finally { setSending(false); }
  }, [prompt.id, sessionId]);
  const copy = browserCardCopy(prompt);
  const body = prompt.kind === 'handoff' ? `${copy.body} Do this in the browser on your computer.` : copy.body;
  const actions = prompt.kind === 'handoff'
    ? <Button variant="secondary" size="sm" disabled={sending} onClick={() => void answer('cant')}>I can't do this</Button>
    : askActions(prompt, (a) => void answer(a), sending);
  return (
    <div className="mx-4 my-2 rounded-lg border border-edge bg-inset p-3 in-view" role="group" aria-label="The browser is asking you">
      <div className="flex items-start gap-2">
        <GlobeIcon className="w-4 h-4 mt-0.5 text-fg-muted shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">{copy.title}</div>
          <p className="text-xs text-fg-2 mt-1">{body}</p>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2 mt-3">{actions}</div>
    </div>
  );
});

const BrowserAskCard = memo(function BrowserAskCard({ sessionId }: { sessionId: string }) {
  const state = useBrowserState(sessionId);
  const paneOpen = useBrowserPaneOpen(sessionId);
  const [sending, setSending] = useState(false);
  const prompt = state?.prompt ?? null;

  const answer = useCallback(async (a: PromptAnswer) => {
    if (!prompt) return;
    setSending(true);
    try { await bridge().answer(sessionId, prompt.id, a); } finally { setSending(false); }
  }, [prompt, sessionId]);

  const openWindow = useCallback(async () => {
    setSending(true);
    try { await bridge().openWindowForHandoff(sessionId); } finally { setSending(false); }
  }, [sessionId]);

  const downloading = state?.downloadPercent != null;
  if (!prompt && !downloading) return null;

  if (!prompt && downloading) {
    return (
      <div className="mx-4 my-2 rounded-lg border border-edge bg-inset p-3 in-view" role="status">
        <div className="flex items-center gap-2 text-sm text-fg">
          <GlobeIcon className="w-4 h-4 text-fg-muted" />
          <span>Downloading a browser for the assistant… {state!.downloadPercent}%</span>
        </div>
        <ProgressBar className="mt-2" percent={state!.downloadPercent ?? 0} />
        <div className="flex justify-end mt-2">
          <Button variant="secondary" size="sm" onClick={() => void bridge().cancelDownload()}>Cancel</Button>
        </div>
      </div>
    );
  }

  const p = prompt!;
  const copy = browserCardCopy(p);
  let actions: React.ReactNode;
  switch (p.kind) {
    case 'handoff':
      actions = (
        <>
          {/* Outlined, never bare text (guide "Buttons": everything less important is outlined). */}
          <Button variant="secondary" size="sm" disabled={sending} onClick={() => void answer('cant')}>I can't do this</Button>
          {!state?.windowShown && !state?.myChrome && (
            <Button variant="secondary" size="sm" disabled={sending} onClick={() => void openWindow()}>Show window</Button>
          )}
          {!paneOpen && (
            <Button variant="secondary" size="sm" disabled={sending} onClick={() => openBrowserPane(sessionId)}>Show the browser</Button>
          )}
          <Button variant="primary" size="sm" disabled={sending} onClick={() => void answer('done')}>I'm done</Button>
        </>
      );
      break;
    case 'no-browser':
      actions = downloading
        ? <Button variant="secondary" size="sm" onClick={() => void bridge().cancelDownload()}>Cancel</Button>
        : askActions(p, answer, sending);
      break;
    default:
      actions = askActions(p, answer, sending);
  }

  return (
    <div className="mx-4 my-2 rounded-lg border border-edge bg-inset p-3 in-view" role="group" aria-label="The browser is asking you">
      <div className="flex items-start gap-2">
        <GlobeIcon className="w-4 h-4 mt-0.5 text-fg-muted shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">{copy.title}</div>
          <p className="text-xs text-fg-2 mt-1">{copy.body}</p>
          {p.kind === 'no-browser' && downloading && (
            <div className="mt-2">
              <div className="text-2xs text-fg-muted">Downloading… {state!.downloadPercent}%</div>
              <ProgressBar className="mt-1" percent={state!.downloadPercent ?? 0} />
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2 mt-3">{actions}</div>
    </div>
  );
});

export default BrowserAskCard;
