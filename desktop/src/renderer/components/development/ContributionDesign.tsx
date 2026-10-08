import { useEffect, useState } from 'react';
import { Button, Callout, CARD_LEVEL_1, Dialog, FoldRow, LoadingState } from '../ui';
import { networkOnlineNow } from '../../hooks/useNetworkOnline';
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
  // Read only to word a failed download: "no network" only when the computer says so.
  const online = networkOnlineNow();
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

      {/* WHY the guide's notice box in place of the buttons (submit-ticket-5; the ticket's
          approved failure, submit-ticket-1#ST-5): a failure replaces the buttons it came
          from, inside the card it is about — one sentence with the real reason (never a
          guessed cause), its Try again inside it, no title. The card keeps what this screen
          is for (UX review U15). */}
      {/* WHY plain words first and the raw reason folded away (Destin, submit-ticket-5#ST5-9:
          "mock failure dev open session in might scare our users. this error is just confusing
          and unhelpful"): the operation's own text ("spawn claude ENOENT", git's output) is for
          a bug report, not the message. The sentence says what happened and what still holds,
          without guessing a cause (error-message standards); "no network" is said only when
          the computer reports none. The details stay one click away for whoever needs them. */}
      {phase === 'open-failed' && <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
        <p className="text-sm text-fg">YouCoded’s code is ready on this computer.</p>
        <Callout tone="danger" actionsPlacement="below" actions={<>
          {back && <Button size="sm" variant="secondary" onClick={onClose}>Back to ticket</Button>}
          <Button size="sm" onClick={() => void openProject()}>Try again</Button>
        </>}>The new conversation didn’t open. The code is still on this computer, so trying again picks up where this left off.</Callout>
        {error && <FoldRow title="Details">
          <p className="text-2xs text-fg-2 font-mono break-all">{error}</p>
        </FoldRow>}
      </div>}

      {phase === 'failed' && <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
        <p className="text-xs text-fg-2 leading-relaxed">{lead}</p>
        <Callout tone={online ? 'danger' : 'warning'} actionsPlacement="below" actions={<>
          {back && <Button size="sm" variant="secondary" onClick={onClose}>Back to ticket</Button>}
          <Button size="sm" onClick={setup}>Try again</Button>
        </>}>{online
          ? 'The download didn’t finish. Nothing was left behind, so trying again starts cleanly.'
          : 'This computer isn’t connected to a network, so the download couldn’t start.'}</Callout>
        {error && <FoldRow title="Details">
          <p className="text-2xs text-fg-2 font-mono break-all">{error}</p>
        </FoldRow>}
      </div>}

    </div>
  </Dialog>;
}
