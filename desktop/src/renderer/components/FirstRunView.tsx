import { useCallback, useEffect, useRef, useState } from 'react';
import type { FirstRunState, PrerequisiteState } from '../../shared/first-run-types';
import type { CatalogModel } from '../../shared/provider-types';
import BrailleSpinner from './BrailleSpinner';
import { canRetry, describeStep } from './first-run/describe-step';
import { persistLastBinding, persistRuntimeDefault } from './RuntimeBinding';
import { Button } from './ui';
import { StatusStrip } from './ui/StatusStrip';
import { ApiKeySetup } from './first-run/ApiKeySetup';
import { LocalModelSetup } from './first-run/LocalModelSetup';
import type { KeyService } from './first-run/recognise-key';

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
  claudeInstalling,
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
  // 2026-08-31-openrouter-connection-trust-design.md §3.5). Review
  // 2026-09-05 P-5: it belongs on this screen beside the other two plans.
  onOpenRouter: () => void;
  // F-1/F-2: any key the app supports, run on YouCoded's own assistant.
  onApiKey: (key: string, service: KeyService) => void;
  // S-1: Claude Code installs after "Log in with Claude", not before the screen.
  claudeInstalling: boolean;
}) {
  const [localOpen, setLocalOpen] = useState(authMode === 'local');
  // Round 3 review (A-7): the API key opens its own page, like Use a local model.
  const [keyOpen, setKeyOpen] = useState(authMode === 'apikey');

  // The waiting line keeps the card around it (P-6): the screen does not
  // change shape between pressing a button and coming back from the browser.
  const card = 'mt-6 w-full max-w-md rounded-2xl bg-panel border border-edge p-6 flex flex-col items-center gap-4';

  if (authMode === 'oauth' && claudeInstalling) {
    return (
      <div className={card}>
        <StatusStrip tone="busy" className="w-full" detail="Your browser opens to sign in as soon as it finishes.">
          Installing Claude Code…
        </StatusStrip>
      </div>
    );
  }

  if (localOpen) {
    return (
      <div className={card}>
        <LocalModelSetup onBack={() => setLocalOpen(false)} />
      </div>
    );
  }

  if (keyOpen) {
    return (
      <div className={card}>
        <ApiKeySetup onBack={() => setKeyOpen(false)} onSubmit={onApiKey} />
      </div>
    );
  }

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
      {/* Wording is Destin's (review deck 2026-09-10, Z-1). */}
      <p className="text-sm text-fg-dim text-center leading-relaxed">
        With your permission, the assistant may create, change, or delete files on your device.
        Create backups for anything you cannot replace.
      </p>

      {/* Documented pill exception: first-run hero CTAs are the Button's xl size
          (rounded-full, larger padding, semibold) — a shared size since 2026-09-16
          instead of the same five hand-set className overrides. Only the hover and
          the focus ring normalize — hover:opacity-90 faded the label along with the fill.
          WHY every way in is the same outlined button (Destin, review of the
          first-run local models mockups, 2026-09-14): "log in with claude should
          not be a unique button" — no way in is presented as the default, and
          G-4 allows a view with no filled button at all. */}
      {/* Full-width pills, one per way in. Side by side the outlined labels
          wrapped onto two lines at the card's width. */}
      <div className="flex flex-col items-stretch gap-3 w-full">
        <Button variant="secondary" onClick={onOAuth} size="xl" className="w-full">
          Log in with Claude
        </Button>
        {isChatGptSupported() && (
          <Button variant="secondary" onClick={onChatGpt} size="xl" className="w-full">
            Log in with ChatGPT
          </Button>
        )}
        <Button variant="secondary" onClick={onOpenRouter} size="xl" className="w-full">
          Log in with OpenRouter
        </Button>
        <Button variant="secondary" onClick={() => setLocalOpen(true)} size="xl" className="w-full">
          Use a local model
        </Button>
        {/* WHY a button, not an underlined link (Destin, 2026-09-14): "use an api
            key should be the same as the other buttons, not a link thing". It
            opens its own page (ApiKeySetup), like Use a local model (A-7). */}
        <Button variant="secondary" onClick={() => setKeyOpen(true)} size="xl" className="w-full">
          Use an API key
        </Button>
      </div>
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
      <p className="text-sm text-fg-dim text-center">Your assistant will show you around once the app opens.</p>
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
  // First-run local models (2026-09-14): the same seeding for every native way in —
  // a local model ('local'), a model app already running, or an API key — through
  // `setupProvider`, which main sets to the provider setup finished on.
  const seededChatGpt = useRef(false);
  useEffect(() => {
    if (!state || seededChatGpt.current) return;
    const done = state.currentStep === 'LAUNCH_WIZARD' || state.currentStep === 'COMPLETE';
    const providerId = state.authMode === 'chatgpt' ? 'chatgpt' : state.setupProvider;
    if (!done || !providerId) return;
    seededChatGpt.current = true;
    persistRuntimeDefault('native');
    Promise.resolve()
      .then(() => (window as any).claude?.providers?.catalog?.() as Promise<CatalogModel[]> | undefined)
      .then((rows) => {
        const first = Array.isArray(rows) ? rows.find((r) => r?.providerId === providerId) : undefined;
        if (first?.id) persistLastBinding({ providerId, modelId: first.id });
      })
      .catch(() => { /* the catalog is a nicety here; the forms fall back on their own */ });
  }, [state?.currentStep, state?.authMode, state?.setupProvider]);

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

  // F-2: the service travels with the key, because a key now runs on YouCoded's
  // own assistant rather than being handed to Claude Code.
  const handleApiKey = useCallback((key: string, service: KeyService) => {
    (window as any).claude.firstRun.submitApiKey(key, service);
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
              {state.prerequisites
                // Round 3 review (B-9, "two separate installing cards?"): Claude
                // Code's on-demand install is shown once, on the sign-in card —
                // this checklist no longer lists it on the sign-in step.
                // Nor while it waits or was skipped: setup no longer installs it
                // for everyone (Q-5), so a "waiting" Claude Code row would never move.
                .filter((p) => !(p.name === 'claude' && (state.currentStep === 'AUTHENTICATE' || p.status === 'waiting' || p.status === 'skipped')))
                .map((p) => {
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
              claudeInstalling={state.prerequisites.some((p) => p.name === 'claude' && p.status === 'installing')}
            />
          )}

          {/* Developer mode screen */}
          {state?.currentStep === 'ENABLE_DEVELOPER_MODE' && (
            <DevModeScreen onEnable={handleDevMode} />
          )}

          {/* Error display. The message is always shown; the Try Again button
              only when a PREREQUISITE actually failed. WHY: "Try Again" here
              re-runs the whole Node/Git/Claude install pass, and a refused
              OpenRouter key or sign-in sets an error message without any
              prerequisite having failed — offering to reinstall
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
