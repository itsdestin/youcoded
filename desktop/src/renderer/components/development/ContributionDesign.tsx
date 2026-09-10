import { useEffect, useState } from 'react';
import { Button, Dialog, ErrorState, LoadingState } from '../ui';
import { useEscClose } from '../../hooks/use-esc-close';
import { ContributionWalkthrough } from './ContributionWalkthrough';

type Phase = 'idle' | 'setting-up' | 'ready' | 'failed';

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
    const status = window.claude?.dev?.setupStatus?.();
    if (!status) return;
    void status.then(s => {
      if (!live || s.state === 'idle') return;
      setPath(s.path ?? '');
      setError(s.error ?? '');
      setPhase(s.state === 'running' ? 'setting-up' : s.state);
    }).catch(() => {/* a status read that fails leaves the normal start screen */});
    return () => { live = false; };
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
    } catch (e: any) {
      // WHY: a rejection used to fall through a try/finally with no catch, so the
      // screen sat on the progress state for ever (audit E-02).
      setError(String(e?.message || e));
      setPhase('failed');
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
          <Button className="w-full py-2.5" onClick={onClose}>Open it</Button>
          <Button variant="secondary" className="w-full py-2.5" onClick={onClose}>Not now</Button>
        </div>
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
        <ErrorState
          title="Setup didn’t finish"
          explainer={`${error} Anything already downloaded is kept, so trying again picks up where it stopped.`}
          onRetry={setup}
          onReportBug={onClose}
        />
      </>}

    </div>
  </Dialog>;
}
