// The Browser's ask card, drawn in the chat under the latest message while the
// assistant waits on the person (spec §1 "Asking first", "The assistant needs
// you"). ONE card for both session kinds: the asks are the Browser's own rules,
// not the session's permission system (design review 1 #1).
//
// Kinds: site permission (once per site per chat), form submit (until "Always allow"), final step (every time),
// home-network address, "needs you" hand-off, and "no browser — download one".
// WHY the four permission asks are drawn by ToolCard itself (Destin, 2026-11-02, after two
// look-alike attempts were rejected: "this still doesn't match any other permission card. we
// should reuse the existing style"): site, form, final step and home-network address are
// permission asks, so they render THROUGH ToolCard's own ask card (header line, Yes / Always
// allow / No, note, Enter and arrow keys) inside the same frosted PendingAskBubble the chat's
// tool asks sit in. Nothing here draws a button or a box for them. The "needs you" and
// download cards are not permission asks, so they keep their own buttons, but sit in the
// same bubble so they are frosted too.
// Copy follows the spec glossary; buttons sit on the right with one primary
// (design guide G-4, G-28).
import { memo, useCallback, useMemo, useState } from 'react';
import type { BrowserPrompt, PromptAnswer } from '../../../shared/browser-types';
import { openBrowserPane, useBrowserPaneOpen, useBrowserState } from '../../state/browser-store';
import { Button, ProgressBar } from '../ui';
import { GlobeIcon } from '../Icons';
import ToolCard from '../ToolCard';
import { PendingAskBubble } from '../PendingAskBubble';
import type { ToolCallState } from '../../../shared/types';

function bridge() { return (window as any).claude.browser; }

interface Copy { title: string; body: string }

/** Plain-language title and body for a card (exported for tests). For the four permission asks the body is
 *  the small note under the buttons, so it says only what each answer covers. */
export function browserCardCopy(p: BrowserPrompt): Copy {
  switch (p.kind) {
    case 'site':
      return {
        title: p.message,
        body: p.allowAlways === false
          ? 'Yes covers this chat. This is your own Chrome, where you\'re signed in.'
          : `Yes covers this chat.${p.host ? ` Always allow remembers ${p.host}.` : ''} It still asks before sending, buying or deleting.`,
      };
    case 'form':
      return {
        title: p.message,
        body: p.allowAlways === false
          ? 'Yes lets it send this one form. This is your own Chrome, where you\'re signed in.'
          : `Yes lets it send this one form.${p.host ? ` Always allow remembers ${p.host}.` : ''}`,
      };
    case 'final':
      return { title: p.message, body: 'This looks like a step that buys, sends, posts, deletes or submits something.' };
    case 'local':
      return { title: p.message, body: 'Yes covers this chat. These pages can control your router, your devices or programs you\'re running.' };
    case 'handoff':
      return { title: 'The assistant needs you in the browser', body: p.message };
    case 'no-browser':
      return { title: 'Browser needed', body: 'YouCoded can download one for the assistant (about 150 MB, kept inside YouCoded).' };
  }
}

/** The header line of each permission ask (ToolCard's `display.label`; the site is its detail). */
const ASK_LABEL: Partial<Record<BrowserPrompt['kind'], string>> = {
  site: 'Using a website',
  form: 'Sending a form',
  final: 'A final step',
  local: 'Home-network address',
};

/** The four permission asks, drawn by ToolCard itself (see the file header). The ask is shaped as a
 *  tool call that is waiting for an answer; ToolCard's `ask` prop swaps in our words and sends the
 *  answer to the browser instead of the session's permission socket. */
function PermissionAsk({ sessionId, prompt: p, answer }: { sessionId: string; prompt: BrowserPrompt; answer: (a: PromptAnswer) => Promise<void> }) {
  const host = p.host ?? '';
  const copy = browserCardCopy(p);
  // WHY memoised: ToolCard is a memo component; a fresh object on every render would redraw it
  // for nothing and reset its focus ring.
  const tool = useMemo<ToolCallState>(() => ({
    toolUseId: `browser-ask-${p.id}`,
    toolName: 'BrowserAsk',
    input: {},
    status: 'awaiting-approval',
    // 'native-' makes the shared card offer Always allow (it has no Claude Code suggestions to go on).
    requestId: `native-browser-${p.id}`,
    permissionMode: 'ask',
  }), [p.id]);
  // What "Yes" means differs by ask: a form or final step is one time; a site or home-network
  // address covers the chat (the buttons' old "Allow for this chat").
  const yes: PromptAnswer = p.kind === 'form' || p.kind === 'final' ? 'once' : 'allow_chat';
  const canAlways = (p.kind === 'site' || p.kind === 'form') && p.allowAlways !== false && !!host;
  const ask = useMemo(() => ({
    label: ASK_LABEL[p.kind] ?? 'The browser is asking',
    detail: host || undefined,
    question: copy.title,
    note: copy.body,
    noAlways: !canAlways,
    // A step that buys or sends is never answered by a stray Enter.
    noKeyboard: p.kind === 'final',
    answer: async (d: any): Promise<boolean> => {
      const remember = Array.isArray(d?.updatedPermissions) && d.updatedPermissions.length > 0;
      await answer(d?.decision?.behavior === 'deny' ? 'no' : remember ? 'allow_always' : yes);
      return true;
    },
  }), [p.kind, host, copy.title, copy.body, canAlways, answer, yes]);
  return (
    <PendingAskBubble>
      <ToolCard tool={tool} sessionId={sessionId} ask={ask} />
    </PendingAskBubble>
  );
}

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
      <PendingAskBubble>
      <div role="status">
        <div className="flex items-center gap-2 text-sm text-fg">
          <GlobeIcon className="w-4 h-4 text-fg-muted" />
          <span>Downloading a browser for the assistant… {state!.downloadPercent}%</span>
        </div>
        <ProgressBar className="mt-2" percent={state!.downloadPercent ?? 0} />
        <div className="flex justify-end mt-2">
          <Button variant="secondary" size="sm" onClick={() => void bridge().cancelDownload()}>Cancel</Button>
        </div>
      </div>
      </PendingAskBubble>
    );
  }

  const p = prompt!;
  if (p.kind === 'site' || p.kind === 'form' || p.kind === 'final' || p.kind === 'local') {
    return <PermissionAsk key={p.id} sessionId={sessionId} prompt={p} answer={answer} />;
  }
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
      actions = downloading ? (
        <Button variant="secondary" size="sm" onClick={() => void bridge().cancelDownload()}>Cancel</Button>
      ) : (
        <>
          <Button variant="secondary" size="sm" disabled={sending} onClick={() => void answer('no')}>Not now</Button>
          <Button variant="primary" size="sm" disabled={sending} onClick={() => void answer('download')}>Download</Button>
        </>
      );
      break;
  }

  return (
    <PendingAskBubble>
    <div role="group" aria-label="The browser is asking you">
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
    </PendingAskBubble>
  );
});

export default BrowserAskCard;
