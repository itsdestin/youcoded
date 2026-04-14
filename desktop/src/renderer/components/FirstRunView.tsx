import React, { useCallback, useEffect, useState } from 'react';
import type { FirstRunState, PrerequisiteState } from '../../shared/first-run-types';
import BrailleSpinner from './BrailleSpinner';
import { describeStep } from './first-run/describe-step';

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
  onApiKey,
}: {
  authMode: FirstRunState['authMode'];
  onOAuth: () => void;
  onApiKey: (key: string) => void;
}) {
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKey, setApiKey] = useState('');

  if (authMode === 'oauth') {
    return (
      <div className="mt-6 text-center flex items-center justify-center gap-2 text-sm text-fg-dim">
        <BrailleSpinner size="sm" />
        <span>A browser window should have opened. Complete sign-in there…</span>
      </div>
    );
  }

  return (
    <div className="mt-6 w-full max-w-md rounded-2xl bg-panel border border-edge p-6 flex flex-col items-center gap-4">
      <p className="text-sm text-fg-dim text-center leading-relaxed">
        Sign in with your Claude Pro or Max plan — no API key or credit card needed.
      </p>

      <button
        onClick={onOAuth}
        className="px-6 py-3 rounded-full bg-accent text-on-accent font-semibold text-base hover:opacity-90 transition-opacity"
      >
        Log in with Claude
      </button>

      {!showApiKey ? (
        <button
          onClick={() => setShowApiKey(true)}
          className="text-xs text-fg-muted hover:text-fg-dim underline transition-colors"
        >
          I have an API key instead
        </button>
      ) : (
        <div className="flex flex-col items-center gap-3 w-full">
          <input
            type="password"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-well border border-edge text-fg text-sm placeholder:text-fg-faint focus:outline-none focus:border-accent"
          />
          <p className="text-xs text-fg-muted text-center leading-relaxed">
            Your key is passed directly to Claude Code and stored in its secure config.
            DestinCode never stores, logs, or backs up your key.
          </p>
          <button
            onClick={() => onApiKey(apiKey)}
            disabled={!apiKey.trim()}
            className="px-4 py-2 rounded-full bg-accent text-on-accent text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            Verify &amp; Continue
          </button>
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
        Windows Developer Mode allows DestinCode to create symbolic links, which
        the toolkit uses for configuration files. This is a one-time system setting.
      </p>
      <button
        onClick={onEnable}
        className="px-5 py-2.5 rounded-full bg-accent text-on-accent font-medium hover:opacity-90 transition-opacity"
      >
        Enable Developer Mode
      </button>
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
      <p className="text-sm text-fg-dim text-center">Here's what to try first:</p>
      <ul className="flex flex-col gap-2 text-sm text-fg-dim">
        <li className="flex gap-2">
          <span className="text-accent">•</span>
          <span><span className="text-fg">Pick a theme</span> — Settings &rarr; Appearance</span>
        </li>
        <li className="flex gap-2">
          <span className="text-accent">•</span>
          <span><span className="text-fg">Install a skill</span> — the marketplace is one click away</span>
        </li>
        <li className="flex gap-2">
          <span className="text-accent">•</span>
          <span><span className="text-fg">Sync across devices</span> — optional, but handy</span>
        </li>
      </ul>
      <div className="flex items-center justify-center gap-2 text-xs text-fg-muted pt-1">
        <BrailleSpinner size="sm" />
        <span>Opening DestinCode…</span>
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

  const handleRetry = useCallback(() => {
    (window as any).claude.firstRun.retry();
  }, []);

  const handleOAuth = useCallback(() => {
    (window as any).claude.firstRun.startAuth('oauth');
  }, []);

  const handleApiKey = useCallback((key: string) => {
    (window as any).claude.firstRun.submitApiKey(key);
  }, []);

  const handleDevMode = useCallback(() => {
    (window as any).claude.firstRun.devModeDone();
  }, []);

  const handleSkip = useCallback(() => {
    (window as any).claude.firstRun.skip();
  }, []);

  const launching =
    state?.currentStep === 'LAUNCH_WIZARD' || state?.currentStep === 'COMPLETE';

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-950 text-gray-100">
      <h1 className="text-4xl font-bold mb-6">DestinCode</h1>

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
              onApiKey={handleApiKey}
            />
          )}

          {/* Developer mode screen */}
          {state?.currentStep === 'ENABLE_DEVELOPER_MODE' && (
            <DevModeScreen onEnable={handleDevMode} />
          )}

          {/* Error display */}
          {state?.lastError && (
            <div className="flex flex-col items-center gap-2 mt-2">
              <p className="text-xs text-red-400 text-center">{state.lastError}</p>
              <button
                onClick={handleRetry}
                className="px-3 py-1.5 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs font-medium transition-colors"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      )}

      {/* Skip link */}
      <button
        onClick={handleSkip}
        className="mt-10 text-xs text-gray-700 hover:text-gray-500 transition-colors"
      >
        Skip setup (I installed via terminal)
      </button>
    </div>
  );
}
