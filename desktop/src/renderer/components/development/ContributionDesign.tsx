import { useEffect, useState } from 'react';
import { Button, CARD_LEVEL_1, Dialog, ErrorState, LoadingState } from '../ui';
import type { ReactNode } from 'react';
import { useEscClose } from '../../hooks/use-esc-close';
import { plainMessage } from '../../utils/ipc-error';
import { ContributionWalkthrough } from './ContributionWalkthrough';

type Phase = 'idle' | 'setting-up' | 'ready' | 'failed' | 'open-failed';

/**
 * A ticket handed over from "Let your assistant try to fix it" (Destin,
 * submit-ticket-3#ST3-Q1 "contribute": one place explains and runs the download; "ensure
 * the contribute page is worded in a way that makes sense for handoff peeps too").
 * `initialInput` is what the new conversation starts with; `onStarted` tells the ticket
 * the assistant began, so it can show "Not sent — your assistant is working on it".
 */
export type ContributionHandover = { title: string; kind: 'bug' | 'feature'; initialInput: string; onStarted: () => void };

export function ContributionDesign({ open, onClose, handover, screen = 'settings/development/contribute' }: {
  open: boolean; onClose: () => void; handover?: ContributionHandover;
  /** WHY overridable: opened from a ticket, this IS the ticket flow's next step, so the
   *  photo-only build marks it as the ticket screen's state (screens/settings.ts). */
  screen?: string;
}) {
  useEscClose(open, onClose);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [path, setPath] = useState('');

  // WHY this exists at all: the setting-up screen promises "you can close this and
  // setup carries on in the background" (Destin, R6-24). That is only true if setup
  // belongs to the main process AND the screen can ask where it got to when it
  // reopens — otherwise reopening would show the start button while a setup ran,
  // and the promise would be a lie the user catches immediately.
  useEffect(() => {
    if (!open) return;
    let live = true;
    // Optional-chained: this now runs on MOUNT, so a caller without the bridge
    // (a test, a surface that renders before preload) would otherwise crash the
    // dialog rather than simply show its start screen.
    // WHY it POLLS while running (code review C7): the status was read exactly once
    // on open, and the only thing that moved the screen off "Setting up…" was the
    // setupWorkspace promise belonging to THIS dialog. Reopen mid-setup and there is
    // no such promise, so the spinner sat there for ever — while the setup it was
    // describing finished perfectly well behind it. Polling is the honest option:
    // the run is not ours to await, so we ask.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const status = window.claude?.dev?.setupStatus?.();
      if (!status) return;
      void status.then(s => {
        if (!live || s.state === 'idle') return;
        setPath(s.path ?? '');
        setError(s.error ?? '');
        setPhase(s.state === 'running' ? 'setting-up' : s.state);
        if (s.state === 'running') timer = setTimeout(read, 1000);
      }).catch(() => {/* a status read that fails leaves the normal start screen */});
    };
    read();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [open]);

  const setup = async () => {
    setPhase('setting-up');
    setError('');
    try {
      const r = await window.claude.dev.setupWorkspace();
      // From a ticket, the button said "Download and start", so a finished download
      // starts the conversation rather than stopping on a second "Start" screen.
      if (r.ok && handover) { setPath(r.path); await openProject(r.path); return; }
      if (r.ok) { setPath(r.path); setPhase('ready'); }
      // WHY: the reason comes from the operation that failed, never from a guess
      // here (docs/error-message-standards.md).
      else { setError(r.error); setPhase('failed'); }
    } catch (e: unknown) {
      // WHY there is a catch at all: a rejection used to fall through a try/finally
      // with none, so the screen sat on the progress state for ever (audit E-02).
      // WHY plainMessage (E-14/E-15): over remote access the bridge rejects with
      // `remote-unsupported: dev:setup-workspace`, a channel name that means nothing
      // to anyone; this says "Developer tools isn't available via remote access yet."
      setError(plainMessage(e, 'Setup could not finish.'));
      setPhase('failed');
    }
  };

  // WHY the outcome is cleared when the user leaves it (code review C12): the
  // status lives in the main process so setup survives closing the dialog, but that
  // means a finished outcome outlives it too — one failure and every later open
  // showed that same old failure, with the start button unreachable for the rest of
  // the session. Acknowledging an outcome is what ends it.
  const dismiss = () => {
    void window.claude.dev.clearSetupStatus?.().catch(() => {});
    onClose();
  };

  const openProject = async (at: string = path) => {
    try {
      await window.claude.dev.openSessionIn(handover ? { cwd: at, initialInput: handover.initialInput } : { cwd: at });
      if (handover) { void window.claude.dev.clearSetupStatus?.().catch(() => {}); handover.onStarted(); return; }
      dismiss();
    } catch (e: unknown) {
      // WHY its own phase (code review C2): this used to set 'failed', so a failure
      // to OPEN was titled "Setup didn't finish" and its Retry re-ran setup — cloning
      // a second entire workspace, ~1GB, for a project that was already sitting on
      // disk. Two false statements and an unrequested download, from one wrong word.
      setError(plainMessage(e, 'It could not be opened.'));
      setPhase('open-failed');
    }
  };

  // ── Words ──────────────────────────────────────────────────────────────────
  // WHY rewritten (submit-ticket-3#ST3-Q1 note): "development workspace", "set up" and a
  // separate project meant nothing to someone who came from a ticket. Every state now says
  // what happens on THEIR computer, how big it is, and what comes next. The size is the
  // code's own estimate (dev-tools.ts: "~1GB with five nested .git directories").
  const forTicket = !!handover;
  const lead = forTicket
    ? <>Your assistant will work on “{handover.title}” in its own copy of YouCoded’s code. Your ticket isn’t sent unless you send it.</>
    : <>You don’t need to know how to code. Describe a change, and your assistant makes it in its own copy of YouCoded’s code.</>;
  const facts: ReactNode[] = [
    'The first time, this downloads YouCoded’s code — about 1 GB, so a few minutes. After that, the same copy is reused.',
    'Your installed app and your own files don’t change.',
    forTicket ? 'Then a new conversation opens with your ticket already in it.' : 'Then you can open it as a new conversation and describe your idea.',
  ];
  const back = forTicket
    ? <Button variant="secondary" className="w-full py-2.5" onClick={onClose}>Back to ticket</Button>
    : null;

  return <Dialog screen={screen} open={open} onClose={onClose} size="panel" title={forTicket ? (handover.kind === 'bug' ? 'Let your assistant try to fix it' : 'Let your assistant try to build it') : 'Contribute to YouCoded'}>
    <div className="space-y-4">{/* WHY no p-4: the Dialog body already pads 16px (doubled margins, 2026-09-28) */}

      {/* WHY one card (nothing-bare rules, 2026-09-28): a small popup holding a single
          card needs no label above it. */}
      {phase === 'idle' && <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
        <p className="text-xs text-fg-2 leading-relaxed">{lead}</p>
        <ul className="list-disc ml-4 space-y-1 text-xs text-fg-2 leading-relaxed">{facts.map((f, i) => <li key={i}>{f}</li>)}</ul>
        {!forTicket && <ContributionWalkthrough />}
        {/* WHY: full width, primary — narrow popups stack (guide "Buttons"). It must never
            reach the legacy installer; that is pinned by DevelopmentDesign.test.tsx. */}
        <div className="flex flex-col gap-2">
          <Button className="w-full py-2.5" onClick={setup}>{forTicket ? 'Download and start' : 'Download YouCoded’s code'}</Button>
          {back}
        </div>
      </div>}

      {phase === 'setting-up' && <div className={`${CARD_LEVEL_1} p-3 space-y-2`}>
        <LoadingState verb="Downloading" what="YouCoded’s code" variant="inline" />
        {/* WHY this promise is honest (Destin, R6-24): the download runs in the main
            process and this screen re-reads its status on open, so leaving does not stop it. */}
        <p className="text-xs text-fg-2">About 1 GB, so this can take a few minutes. You can {forTicket ? 'go back to your ticket' : 'close this'} — the download keeps going{forTicket ? '' : ', and you’ll find it here when you come back'}.</p>
        {back}
      </div>}

      {phase === 'ready' && <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
        <p className="text-sm text-fg">YouCoded’s code is ready on this computer.</p>
        <p className="text-xs text-fg-2">{forTicket
          ? 'A new conversation opens with your ticket in it, and your assistant starts working on it.'
          : <>It’s in your projects, at <code className="text-2xs">{path}</code>. Nothing else on your computer changed.</>}</p>
        <div className="flex flex-col gap-2">
          {/* WHY this calls openSessionIn: contract R10 is "setup finishes and the project
              OPENS" — a button that only closed the dialog would be a dead button. */}
          <Button className="w-full py-2.5" onClick={() => void openProject()}>{forTicket ? 'Start' : 'Open it'}</Button>
          {back ?? <Button variant="secondary" className="w-full py-2.5" onClick={dismiss}>Not now</Button>}
        </div>
      </div>}

      {phase === 'open-failed' && <>
        <ErrorState
          title="The code is ready, but the conversation didn’t open"
          explainer={`${error} The copy is still there, at ${path}.`}
          onRetry={() => void openProject()}
        />
        {back}
      </>}

      {phase === 'failed' && <>
        {/* WHY the purpose line stays (UX review U15): a failure must not erase what this
            screen is for. Retry is the one action this screen has (code review C3). */}
        <p className="text-sm text-fg-2">{lead}</p>
        <ErrorState
          title="The download didn’t finish"
          explainer={`${error} Nothing was left behind, so trying again starts cleanly.`}
          onRetry={setup}
        />
        {back}
      </>}

    </div>
  </Dialog>;
}
