import { useCallback, useEffect, useRef, useState } from 'react';
import type { FirstRunState, PrerequisiteState } from '../../shared/first-run-types';
import type { CatalogModel } from '../../shared/provider-types';
import BrailleSpinner from './BrailleSpinner';
import { canRetry, describeStep } from './first-run/describe-step';
import { persistLastBinding, persistRuntimeDefault } from './RuntimeBinding';
import { Button, CARD_LEVEL_1, ErrorState, FieldError, FoldRow } from './ui';
import { BrandLockup } from './brand/BrandLockup';
import { SignInChoices, type WayIn } from './first-run/SignInChoices';
import { StatusStrip } from './ui/StatusStrip';
import { ApiKeySetup } from './first-run/ApiKeySetup';
import { LocalModelSetup } from './first-run/LocalModelSetup';
import type { KeyService } from './first-run/recognise-key';
import { useScreenOpen, ScreenMark } from '../shoot-mode';

// The ChatGPT kill switch (design §6): main sets `chatgpt.supported` false
// under YOUCODED_CHATGPT=0, and the button must vanish with it — a button whose
// backend is switched off would be a dead button on the first screen. Read as
// `=== true` (the `native.supported` pattern) so a missing namespace, an old
// preload or the remote shim all read as "not supported".
function isChatGptSupported(): boolean {
  return (window as any).claude?.chatgpt?.supported === true;
}

/* ------------------------------------------------------------------ */
/*  ProgressBar                                                       */
/* ------------------------------------------------------------------ */

function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));
  // WHY no percentage (first-run deck L-1, "one line and a bar"): the step line says
  // where setup is; a number beside it only invited reading 23% as "stuck".
  return (
    <div className="w-full h-1.5 rounded-full bg-inset border border-edge-dim overflow-hidden" role="progressbar" aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full brand-bar-fill transition-all duration-500" style={{ width: `${clamped}%` }} />
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
  onCancel,
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
  // The wait screen's way back (Destin, 2026-10-03): without it, changing your mind after
  // pressing a sign-in button meant restarting the app.
  onCancel: () => void;
}) {
  const [localOpen, setLocalOpen] = useState(authMode === 'local');
  // Round 3 review (A-7): the API key opens its own page, like Use a local model.
  const [keyOpen, setKeyOpen] = useState(authMode === 'apikey');

  // The waiting line keeps the card around it (P-6): the screen does not
  // change shape between pressing a button and coming back from the browser.
  // Brand rebuild (2026-10-04): the app's first-level card, so setup's boxes are the same
  // boxes the app opens onto.
  const card = `${CARD_LEVEL_1} w-full p-5 flex flex-col items-center gap-4`;

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
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    );
  }

  const pick = (w: WayIn) => {
    if (w === 'claude') onOAuth();
    else if (w === 'chatgpt') onChatGpt();
    else if (w === 'openrouter') onOpenRouter();
    else if (w === 'local') setLocalOpen(true);
    else setKeyOpen(true);
  };
  return (
    <div className="w-full flex flex-col gap-3">
      <SignInChoices chatGpt={isChatGptSupported()} onPick={pick} />
      {/* First-run guide design 2026-09-10 §1.1: the one warning nobody can
          skip. It lives on the sign-in step because every install passes
          through here; the app's own dialogs only warn the first time a
          permission switch flips. Wording is Destin's (review deck 2026-09-10, Z-1). */}
      <p className="text-xs text-fg-muted text-center leading-relaxed">
        With your permission, the assistant may create, change, or delete files on your device.
        Create backups for anything you cannot replace.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  CompletionCard                                                    */
/* ------------------------------------------------------------------ */

function CompletionCard() {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <h2 className="brand-heading text-2xl text-fg">You're all set</h2>
      {/* First-run guide design 2026-09-10 §1.2: the three "try this first"
          bullets are gone — the buddy's tour covers them once the app opens,
          so listing them here would say everything twice. */}
      <p className="text-sm text-fg-dim">Your assistant will show you around once the app opens.</p>
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
  // Photo-only build: the step comes from the `?firstRun=` switch, so opening is a no-op.
  useScreenOpen('first-run', () => {});
  const [state, setState] = useState<FirstRunState | null>(null);

  // First launch has no user theme. The screen itself paints the brand palette
  // (.brand-surface); the page underneath is held on Light so nothing outside it
  // (scrollbars, the window's own colour scheme) shows a different theme. ThemeProvider
  // overrides this once the main app mounts after completion.
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'light');
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

  const handleCancelAuth = useCallback(() => {
    (window as any).claude.firstRun.cancelAuth?.();
  }, []);

  const handleOpenRouter = useCallback(() => {
    (window as any).claude.firstRun.startAuth('openrouter');
  }, []);

  // F-2: the service travels with the key, because a key now runs on YouCoded's
  // own assistant rather than being handed to Claude Code.
  const handleApiKey = useCallback((key: string, service: KeyService) => {
    (window as any).claude.firstRun.submitApiKey(key, service);
  }, []);

  const launching =
    state?.currentStep === 'LAUNCH_WIZARD' || state?.currentStep === 'COMPLETE';

  // The prerequisites this install actually works through. Round 3 review (B-9): Claude
  // Code's on-demand install is shown on the sign-in card, never counted here, and a
  // waiting/skipped Claude Code would never move (Q-5).
  // Node.js joined Claude Code here (Destin, 2026-10-02): it installs with Claude Code now,
  // so it counts only on a machine that already has it or is installing it.
  const steps = (state?.prerequisites ?? []).filter((p) => !((p.name === 'claude' || p.name === 'node') && (state?.currentStep === 'AUTHENTICATE' || p.status === 'waiting' || p.status === 'skipped')));
  const activeAt = steps.findIndex((p) => p.status === 'installing' || p.status === 'checking');
  const failed = steps.find((p) => p.status === 'failed');
  const stopped = !!state?.lastError && retryable;

  // One heading and one line per step (first-run deck L-1, "one line and a bar"): tool
  // names stay out of sight unless one of them fails.
  let heading = 'Getting things ready';
  let line: string | null = null;
  if (stopped) {
    heading = 'Setup stopped';
  } else if (state?.currentStep === 'DETECT_PREREQUISITES') {
    line = "Checking what's already on this computer…";
  } else if (state?.currentStep === 'INSTALL_PREREQUISITES') {
    // On a Mac, Git arrives with Apple's developer tools, whose own window must be answered
    // (installGit, 2026-10-02) — the one step where the line has to say what to do.
    line = activeAt >= 0 && steps[activeAt].name === 'git' && /^Mac/.test(navigator.platform)
      ? 'If macOS asks to install developer tools, click Install. It can take a few minutes.'
      : activeAt >= 0 ? `Step ${activeAt + 1} of ${steps.length}` : 'Getting the next piece ready…';
  } else if (state?.currentStep === 'AUTHENTICATE') {
    heading = 'Choose how your assistant runs';
    line = 'You can add the others later in Settings.';
  }
  const installing = state?.currentStep === 'DETECT_PREREQUISITES' || state?.currentStep === 'INSTALL_PREREQUISITES';

  return (
    // WHY brand-surface (first-run deck B-2, "brand lavender, always"): setup has no
    // theme yet, so it wears the brand's own palette; the app's primitives inside it
    // read the brand colours through the same tokens they use everywhere else.
    <div className="brand-surface absolute inset-0 overflow-y-auto">
      {state && <ScreenMark name="first-run" />}
      <div className="min-h-full flex flex-col items-center justify-center gap-6 px-4 py-10">
        {/* B-1: the stacked logo replaces the plain "YouCoded" title. */}
        <BrandLockup size={36} />

        {launching ? (
          <CompletionCard />
        ) : (
          <div className={`flex flex-col items-center gap-4 w-full ${state?.currentStep === 'AUTHENTICATE' && new URLSearchParams(location.search).get('signIn') === 'C' ? 'max-w-2xl' : 'max-w-md'}`}>
            {state && (
              <div className="text-center">
                <h1 className="brand-heading text-2xl text-fg">{heading}</h1>
                {line && <p className="mt-1 text-sm text-fg-dim">{line}</p>}
              </div>
            )}

            {/* L-2: while setup is stopped the bar goes away, so nothing on screen
                still looks busy. */}
            {state && installing && !stopped && <ProgressBar percent={state.overallProgress} />}

            {state?.currentStep === 'AUTHENTICATE' && (
              <AuthScreen
                authMode={state.authMode}
                onOAuth={handleOAuth}
                onChatGpt={handleChatGpt}
                onOpenRouter={handleOpenRouter}
                onApiKey={handleApiKey}
                onCancel={handleCancelAuth}
                claudeInstalling={state.prerequisites.some((p) => p.name === 'claude' && p.status === 'installing')}
              />
            )}

            {/* E-2: a failure is the app's standard error card — one plain sentence and
                Retry — with the raw text behind "Show details". Retry appears only when
                re-running the install pass is the right answer (canRetry: a refused key
                or a sign-in message must not offer to reinstall the app's plumbing). */}
            {stopped && state?.lastError && (
              <div className="w-full flex flex-col gap-2">
                <ErrorState
                  message={failed && failed.name !== 'auth' ? `${failed.displayName} couldn't be installed.` : "This step didn't finish."}
                  onRetry={handleRetry}
                />
                <FoldRow title="Show details">
                  <p className="text-xs text-fg-dim leading-relaxed select-text break-words">{state.lastError}</p>
                </FoldRow>
              </div>
            )}
            {state?.lastError && !stopped && (
              <FieldError as="p" size="2xs" className="text-center max-w-md">
                {state.lastError}
              </FieldError>
            )}
          </div>
        )}
      </div>

      {/* The "Skip setup (I installed via terminal)" link is gone — review
          2026-09-05 P-6. Three sign-ins and a key/local route cover every way
          in; the skip left people on a screen with nothing signed in. */}
    </div>
  );
}
