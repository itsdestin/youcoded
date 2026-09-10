import { useCallback, useEffect, useRef, useState } from 'react';
import type { FirstRunState, PrerequisiteState } from '../../shared/first-run-types';
import type { CatalogModel } from '../../shared/provider-types';
import BrailleSpinner from './BrailleSpinner';
import { canRetry, describeStep } from './first-run/describe-step';
import { persistLastBinding, persistRuntimeDefault } from './RuntimeBinding';
import { Button, TextInput } from './ui';

// The ChatGPT kill switch (design §6): main sets `chatgpt.supported` false
// under YOUCODED_CHATGPT=0, and the button must vanish with it — a button whose
// backend is switched off would be a dead button on the first screen. Read as
// `=== true` (the `native.supported` pattern) so a missing namespace, an old
// preload or the remote shim all read as "not supported".
function isChatGptSupported(): boolean {
  return (window as any).claude?.chatgpt?.supported === true;
}

/* ------------------------------------------------------------------ */
/*  StatusIcon                                                        */
/* ------------------------------------------------------------------ */

function StatusIcon({ status }: { status: PrerequisiteState['status'] }) {
  switch (status) {
    case 'installed':
      return <span className="text-accent">&#10003;</span>;
    case 'installing':
    case 'checking':
      return <BrailleSpinner size="sm" />;
    case 'failed':
      // Status colors stay theme-independent per CLAUDE.md.
      return <span className="text-red-500">&#10007;</span>;
    case 'skipped':
      return <span className="text-fg-faint">&#8212;</span>;
    case 'waiting':
    default:
      return <span className="text-fg-faint">&#9675;</span>;
  }
}

/* ------------------------------------------------------------------ */
/*  statusLabel                                                       */
/* ------------------------------------------------------------------ */

function statusLabel(status: PrerequisiteState['status'], version?: string): string {
  switch (status) {
    case 'installed':
      return version ? `installed (${version})` : 'installed';
    case 'installing':
      return 'installing...';
    case 'checking':
      return 'checking...';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'waiting';
  }
}

/* ------------------------------------------------------------------ */
/*  ProgressBar                                                       */
/* ------------------------------------------------------------------ */

function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="w-full flex items-center gap-3">
      <div className="flex-1 h-1.5 rounded-full bg-inset overflow-hidden">
        <div
          className="h-full rounded-full bg-accent transition-all duration-500"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-xs text-fg-muted tabular-nums w-10 text-right">
        {Math.round(clamped)}%
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AuthScreen                                                        */
/* ------------------------------------------------------------------ */

function AuthScreen({
  authMode,
  onOAuth,
  onChatGpt,
  onOpenRouter,
  onApiKey,
}: {
  authMode: FirstRunState['authMode'];
  onOAuth: () => void;
  // Sign in with ChatGPT (design 2026-09-04, Q-1a): a second plan the app can
  // run on from day one, so a ChatGPT-only user is not sent to "Skip setup".
  onChatGpt: () => void;
  // OpenRouter's own sign-in (PKCE against openrouter.ai/auth — spec
  // 2026-08-31-openrouter-connection-trust-design.md, not yet built). Review
  // 2026-09-05 P-5: it belongs on this screen beside the other two plans.
  onOpenRouter: () => void;
  onApiKey: (key: string) => void;
}) {
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKey, setApiKey] = useState('');

  // The waiting line keeps the card around it (P-6): the screen does not
  // change shape between pressing a button and coming back from the browser.
  const card = 'mt-6 w-full max-w-md rounded-2xl bg-panel border border-edge p-6 flex flex-col items-center gap-4';

  if (authMode === 'oauth' || authMode === 'chatgpt' || authMode === 'openrouter') {
    const where = authMode === 'chatgpt' ? 'ChatGPT' : authMode === 'openrouter' ? 'OpenRouter' : 'Claude';
    return (
      <div className={card}>
        <div className="flex items-center justify-center gap-2 text-sm text-fg-dim">
          <BrailleSpinner size="sm" />
          <span>A browser window should have opened. Finish signing in to {where} there…</span>
        </div>
      </div>
    );
  }

  return (
    <div className={card}>
      <p className="text-sm text-fg-dim text-center leading-relaxed">
        Sign in with the plan you already pay for — no API key or credit card needed.
      </p>
      {/* First-run guide design 2026-09-10 §1.1: the one warning nobody can
          skip. It lives on the sign-in step because every install passes
          through here; the app's own dialogs only warn the first time a
          permission switch flips. */}
      <p className="text-sm text-fg-dim text-center leading-relaxed">
        The assistant can create, change and delete files in any folder you point it at.
        Keep your own backups of anything you cannot replace.
      </p>

      {/* Documented pill exception: first-run hero CTAs keep rounded-full and
          their own larger padding. Only the hover and the focus ring normalize —
          hover:opacity-90 faded the label along with the fill.
          One primary per view (G-4): Claude Code is the default engine, so its
          button is the filled one; the other two plans are outlined peers. */}
      {/* Three full-width pills, the filled Claude one first. Side by side the
          two outlined labels wrapped onto two lines at the card's width. */}
      <div className="flex flex-col items-stretch gap-3 w-full">
        <Button onClick={onOAuth} className="px-6 py-3 rounded-full font-semibold text-base w-full">
          Log in with Claude
        </Button>
        {isChatGptSupported() && (
          <Button variant="secondary" onClick={onChatGpt} className="px-6 py-3 rounded-full font-semibold text-base w-full">
            Log in with ChatGPT
          </Button>
        )}
        <Button variant="secondary" onClick={onOpenRouter} className="px-6 py-3 rounded-full font-semibold text-base w-full">
          Log in with OpenRouter
        </Button>
      </div>

      {!showApiKey ? (
        <button
          onClick={() => setShowApiKey(true)}
          className="text-xs text-fg-muted hover:text-fg-dim underline transition-colors"
        >
          Use an API key or local model
        </button>
      ) : (
        <div className="flex flex-col items-center gap-3 w-full">
          {/* Change 20: bg-well + rounded-md → the shared FIELD surface (password
              fields route through TextInput too; type is preserved). NOT an
              InputGroup — the Verify button sits below, with the key-handling
              disclaimer between it and the field. aria-label added: the field had
              only a placeholder for a name. */}
          <TextInput
            type="password"
            size="md"
            aria-label="Anthropic API key"
            className="w-full"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="text-xs text-fg-muted text-center leading-relaxed">
            Your key is passed directly to Claude Code and stored in its secure config.
            YouCoded never stores, logs, or backs up your key.
          </p>
          <Button
            onClick={() => onApiKey(apiKey)}
            disabled={!apiKey.trim()}
            className="px-4 py-2 rounded-full text-sm"
          >
            Verify &amp; Continue
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  DevModeScreen                                                     */
/* ------------------------------------------------------------------ */

function DevModeScreen({ onEnable }: { onEnable: () => void }) {
  return (
    <div className="mt-6 w-full max-w-md rounded-2xl bg-panel border border-edge p-6 flex flex-col items-center gap-4 text-center">
      <p className="text-sm text-fg leading-relaxed">
        Windows Developer Mode allows YouCoded to create symbolic links, which
        the toolkit uses for configuration files. This is a one-time system setting.
      </p>
      <Button onClick={onEnable} className="px-5 py-2.5 rounded-full">
        Enable Developer Mode
      </Button>
      <p className="text-xs text-fg-muted leading-relaxed">
        If the button doesn't work, open{' '}
        <span className="font-mono text-fg-dim">
          Settings &gt; Update &amp; Security &gt; For Developers
        </span>{' '}
        and enable Developer Mode manually, then click retry.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  CompletionCard                                                    */
/* ------------------------------------------------------------------ */

function CompletionCard() {
  return (
    <div className="w-full max-w-md rounded-2xl bg-panel border border-edge p-6 flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-fg text-center">You're all set.</h2>
      {/* First-run guide design 2026-09-10 §1.2: the three "try this first"
          bullets are gone — the buddy's tour covers them once the app opens,
          so listing them here would say everything twice. */}
      <p className="text-sm text-fg-dim text-center">Your buddy will show you around once the app opens.</p>
      <div className="flex items-center justify-center gap-2 text-xs text-fg-muted pt-1">
        <BrailleSpinner size="sm" />
        <span>Opening YouCoded…</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  FirstRunView (default export)                                     */
/* ------------------------------------------------------------------ */

interface FirstRunViewProps {
  onComplete: () => void;
}

export default function FirstRunView({ onComplete }: FirstRunViewProps) {
  const [state, setState] = useState<FirstRunState | null>(null);

  // First launch has no user theme — lock the screen to Creme so the app's
  // theme tokens resolve to a designed onboarding palette. ThemeProvider
  // overrides this once the main app mounts after completion.
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'creme');
    return () => {
      if (prev) root.setAttribute('data-theme', prev);
      else root.removeAttribute('data-theme');
    };
  }, []);

  // Fetch initial state + subscribe to updates
  useEffect(() => {
    const api = (window as any).claude.firstRun;

    api.getState().then((s: FirstRunState) => setState(s));

    const handler = api.onStateChanged((s: FirstRunState) => setState(s));

    return () => {
      (window as any).claude.off('first-run:state', handler);
    };
  }, []);

  // Transition to main app on completion.
  // When the step reaches LAUNCH_WIZARD or COMPLETE, wait 1.5s then transition.
  // If the step changes away (e.g. re-detection on resume), the timer is cleaned
  // up and re-created when the step reaches a terminal state again.
  useEffect(() => {
    if (!state) return;
    if (state.currentStep === 'LAUNCH_WIZARD' || state.currentStep === 'COMPLETE') {
      const timer = setTimeout(onComplete, 1500);
      return () => clearTimeout(timer);
    }
  }, [state?.currentStep]); // eslint-disable-line react-hooks/exhaustive-deps

  // A ChatGPT-only install's first session (design §5, review R2-12). This
  // install has no Claude login, so if the new-session forms opened on "Claude
  // Code" the user's very first session would fail to start. Once setup
  // finishes through ChatGPT: remember 'native' as the runtime default
  // unconditionally, and seed the model picker with the plan's first model
  // ONLY if the catalog already lists one — the callback kicked the model
  // refresh a second ago and it may still be in flight; a missing seed falls
  // back to the first ready provider's first model, which is the same thing.
  // Neither write may delay the hand-off to the app, so the catalog lookup is
  // fire-and-forget and every failure is swallowed. Runs once per mount.
  const seededChatGpt = useRef(false);
  useEffect(() => {
    if (!state || seededChatGpt.current) return;
    const done = state.currentStep === 'LAUNCH_WIZARD' || state.currentStep === 'COMPLETE';
    if (!done || state.authMode !== 'chatgpt') return;
    seededChatGpt.current = true;
    persistRuntimeDefault('native');
    Promise.resolve()
      .then(() => (window as any).claude?.providers?.catalog?.() as Promise<CatalogModel[]> | undefined)
      .then((rows) => {
        const first = Array.isArray(rows) ? rows.find((r) => r?.providerId === 'chatgpt') : undefined;
        if (first?.id) persistLastBinding({ providerId: 'chatgpt', modelId: first.id });
      })
      .catch(() => { /* the catalog is a nicety here; the forms fall back on their own */ });
  }, [state?.currentStep, state?.authMode]);

  // Busy while any prerequisite is actively installing or being checked. The
  // retry path is guarded against re-entry in the main process too, but
  // disabling the button here is the first line of defense against the
  // concurrent-install race (two installers colliding on the same download).
  const busy = !!state?.prerequisites.some(
    (p) => p.status === 'installing' || p.status === 'checking',
  );

  // One predicate, shared with describeStep(), so the button and the
  // "something went wrong" headline always appear together or not at all.
  const retryable = !!state?.lastError && canRetry(state);

  const handleRetry = useCallback(() => {
    if (busy) return;
    (window as any).claude.firstRun.retry();
  }, [busy]);

  const handleOAuth = useCallback(() => {
    (window as any).claude.firstRun.startAuth('oauth');
  }, []);

  // The ChatGPT round-trip: main opens chatgpt.com and waits for OpenAI's
  // callback (docs/active/investigations/2026-09-04-chatgpt-subscription-paths.md §2).
  const handleChatGpt = useCallback(() => {
    (window as any).claude.firstRun.startAuth('chatgpt');
  }, []);

  const handleOpenRouter = useCallback(() => {
    (window as any).claude.firstRun.startAuth('openrouter');
  }, []);

  const handleApiKey = useCallback((key: string) => {
    (window as any).claude.firstRun.submitApiKey(key);
  }, []);

  const handleDevMode = useCallback(() => {
    (window as any).claude.firstRun.devModeDone();
  }, []);

  const launching =
    state?.currentStep === 'LAUNCH_WIZARD' || state?.currentStep === 'COMPLETE';

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-canvas text-fg">
      <h1 className="text-4xl font-semibold tracking-tight mb-6 text-fg">YouCoded</h1>

      {launching ? (
        <CompletionCard />
      ) : (
        <div className="flex flex-col items-center gap-5 w-full max-w-md px-4">
          {state && (
            <p className="text-sm text-fg-dim text-center max-w-md leading-relaxed">
              {describeStep(state)}
            </p>
          )}

          {/* Prerequisite checklist — rounded pills */}
          {state && (
            <ul className="w-full space-y-2">
              {state.prerequisites.map((p) => {
                const active = p.status === 'installing' || p.status === 'checking';
                return (
                  <li
                    key={p.name}
                    className={[
                      'flex items-center gap-3 rounded-full px-4 py-2.5 border transition-colors',
                      active
                        ? 'bg-inset border-edge'
                        : 'bg-panel border-edge-dim',
                    ].join(' ')}
                  >
                    <StatusIcon status={p.status} />
                    <span className="text-sm text-fg">{p.displayName}</span>
                    <span className="ml-auto text-xs text-fg-muted">
                      {statusLabel(p.status, p.version)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Progress bar (percent rendered inline) */}
          {state && <ProgressBar percent={state.overallProgress} />}

          {/* Auth screen */}
          {state?.currentStep === 'AUTHENTICATE' && (
            <AuthScreen
              authMode={state.authMode}
              onOAuth={handleOAuth}
              onChatGpt={handleChatGpt}
              onOpenRouter={handleOpenRouter}
              onApiKey={handleApiKey}
            />
          )}

          {/* Developer mode screen */}
          {state?.currentStep === 'ENABLE_DEVELOPER_MODE' && (
            <DevModeScreen onEnable={handleDevMode} />
          )}

          {/* Error display. The message is always shown; the Try Again button
              only when a PREREQUISITE actually failed. WHY: "Try Again" here
              re-runs the whole Node/Git/Claude install pass, and one click on
              "Log in with OpenRouter" sets an error message ("coming in a later
              update") without anything having failed — offering to reinstall
              the app's plumbing in answer to that is both confusing and slow.
              The sign-in failures (ChatGPT timed out, Claude login timed out)
              DO mark the 'auth' prerequisite failed, so they keep their
              button — and the three sign-in buttons are back on screen too. */}
          {state?.lastError && (
            <div className="flex flex-col items-center gap-2 mt-2">
              {/* Status colors stay theme-independent per CLAUDE.md. */}
              <p className="text-xs text-destructive-fg text-center max-w-md">
                {state.lastError}
              </p>
              {retryable && (
              <button
                onClick={handleRetry}
                disabled={busy}
                className="px-3 py-1.5 rounded-full bg-well border border-edge hover:bg-inset text-fg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy ? 'Working…' : 'Try Again'}
              </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* The "Skip setup (I installed via terminal)" link is gone — review
          2026-09-05 P-6. Three sign-ins and a key/local route cover every way
          in; the skip left people on a screen with nothing signed in. */}
    </div>
  );
}
