import { useEffect, useState } from 'react';
import { Button, Dialog, ErrorState, LoadingState } from '../ui';
import { useEscClose } from '../../hooks/use-esc-close';
import { plainMessage } from '../../utils/ipc-error';
import { ContributionWalkthrough } from './ContributionWalkthrough';

type Phase = 'idle' | 'setting-up' | 'ready' | 'failed' | 'open-failed';

export function ContributionDesign({ open, onClose }: { open: boolean; onClose: () => void }) {
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

  const openProject = async () => {
    try {
      await window.claude.dev.openSessionIn({ cwd: path });
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

  return <Dialog open={open} onClose={onClose} size="panel" title="Contribute to YouCoded">
    <div className="p-4 space-y-4">

      {phase === 'idle' && <>
        <p className="text-sm text-fg-2">You don’t need to know how to code. Describe a change to your assistant and try it in a separate project. Your installed app and existing folders stay untouched.</p>
        <ContributionWalkthrough />
        {/* WHY: match the app's own dialog action — full width, primary, no prototype caption.
            It must never reach the legacy installer; that is pinned by DevelopmentDesign.test.tsx. */}
        <Button className="w-full py-2.5" onClick={setup}>Set up development workspace</Button>
      </>}

      {phase === 'setting-up' && <>
        <LoadingState verb="Setting up" what="your development workspace" />
        {/* WHY one line and no per-step feed (Destin, R6-24): the steps were noise.
            What he asked for instead is the reassurance — and it is only honest
            because setup runs in the main process and this screen re-reads its
            status on open, so closing really does leave it running. */}
        <p className="text-xs text-fg-2 text-center">This can take a few minutes. You can close this — setup keeps going, and you’ll find it here when you come back.</p>
      </>}

      {phase === 'ready' && <>
        <p className="text-sm text-fg">Your development workspace is ready.</p>
        <p className="text-xs text-fg-2">It’s one of your projects now, at <code className="text-2xs">{path}</code>. Nothing else on your computer changed.</p>
        <div className="flex flex-col gap-2">
          {/* WHY this calls openSessionIn: contract R10 is "setup finishes and the
              project OPENS". A button labelled "Open it" that only closes the dialog
              is the dead-button shape this whole feature exists to remove — and it is
              what the legacy screen's "Open in New Session" already did. */}
          <Button className="w-full py-2.5" onClick={openProject}>Open it</Button>
          <Button variant="secondary" className="w-full py-2.5" onClick={dismiss}>Not now</Button>
        </div>
      </>}

      {phase === 'open-failed' && <>
        <ErrorState
          title="Your workspace is ready, but it didn’t open"
          explainer={`${error} It is still there, at ${path}.`}
          onRetry={openProject}
        />
      </>}

      {phase === 'failed' && <>
        {/* WHY: the legacy screen offered only Done on failure, which throws away
            what already succeeded and gives no way forward (audit E-08). Retry
            resumes; what was downloaded is kept. */}
        {/* WHY one block and no separate Close: the first cut had Retry and Report
            bug at row size inside the error, then a full-width Close under it —
            three actions at two sizes, which is the "weirdly sized buttons, poor
            visual hierarchy" Destin rejected on this very screen (S-6). The error
            owns its actions; the dialog's ✕ is how you leave. */}
        {/* WHY no Report bug here (code review C3): it was wired to onClose, so the
            button filed nothing and just shut the dialog — a dead control on the
            screen whose whole purpose is honest failure. Reporting belongs to the
            ticket flow, which this screen cannot reach; offering it here would be a
            second lie. Retry is the action this screen actually has. */}
        <ErrorState
          title="Setup didn’t finish"
          explainer={`${error} Nothing was left behind, so trying again starts cleanly.`}
          onRetry={setup}
        />
      </>}

    </div>
  </Dialog>;
}
