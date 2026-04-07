import React, { useCallback, useEffect, useState } from 'react';
import type { FirstRunState, PrerequisiteState } from '../../shared/first-run-types';

/* ------------------------------------------------------------------ */
/*  StatusIcon                                                        */
/* ------------------------------------------------------------------ */

function StatusIcon({ status }: { status: PrerequisiteState['status'] }) {
  switch (status) {
    case 'installed':
      return <span className="text-green-400">&#10003;</span>;
    case 'installing':
    case 'checking':
      return <span className="text-blue-400 inline-block animate-spin">&#9696;</span>;
    case 'failed':
      return <span className="text-red-400">&#10007;</span>;
    case 'skipped':
      return <span className="text-gray-500">&#8212;</span>;
    case 'waiting':
    default:
      return <span className="text-gray-500">&#9675;</span>;
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
  return (
    <div className="max-w-sm h-2.5 rounded-full bg-gray-800 overflow-hidden">
      <div
        className="h-full rounded-full bg-blue-500 transition-all duration-500"
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
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
      <div className="mt-6 text-center">
        <p className="text-sm text-gray-300 animate-pulse">
          A browser window should have opened. Complete sign-in there...
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6 flex flex-col items-center gap-4">
      <button
        onClick={onOAuth}
        className="px-6 py-3 rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-semibold text-lg transition-colors"
      >
        Log in with Claude
      </button>

      <span className="text-xs text-gray-500">or</span>

      {!showApiKey ? (
        <button
          onClick={() => setShowApiKey(true)}
          className="text-xs text-gray-400 hover:text-gray-200 underline transition-colors"
        >
          I have an API key
        </button>
      ) : (
        <div className="flex flex-col items-center gap-3 max-w-sm w-full">
          <input
            type="password"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-gray-800 border border-gray-700 text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <p className="text-xs text-gray-500 text-center leading-relaxed">
            Your key is passed directly to Claude Code and stored in its secure config.
            DestinCode never stores, logs, or backs up your key.
          </p>
          <button
            onClick={() => onApiKey(apiKey)}
            disabled={!apiKey.trim()}
            className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
    <div className="mt-6 flex flex-col items-center gap-4 max-w-md text-center">
      <p className="text-sm text-gray-300 leading-relaxed">
        Windows Developer Mode allows DestinCode to create symbolic links, which
        the toolkit uses for configuration files. This is a one-time system setting.
      </p>
      <button
        onClick={onEnable}
        className="px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
      >
        Enable Developer Mode
      </button>
      <p className="text-xs text-gray-500 leading-relaxed">
        If the button doesn't work, open <span className="font-mono text-gray-400">Settings &gt; Update &amp; Security &gt; For Developers</span> and
        enable Developer Mode manually, then click retry.
      </p>
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
        <p className="text-sm text-gray-400 animate-pulse">Starting your setup...</p>
      ) : (
        <div className="flex flex-col items-center gap-5 w-full max-w-md px-4">
          <p className="text-sm text-gray-400">This usually takes 2-3 minutes</p>

          {/* Prerequisite checklist */}
          {state && (
            <ul className="w-full space-y-2">
              {state.prerequisites.map((p) => (
                <li key={p.name} className="flex items-center gap-3 text-sm">
                  <StatusIcon status={p.status} />
                  <span className="text-gray-200">{p.displayName}</span>
                  <span className="ml-auto text-xs text-gray-500">
                    {statusLabel(p.status, p.version)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* Progress bar */}
          {state && (
            <div className="w-full flex flex-col items-center gap-1.5">
              <ProgressBar percent={state.overallProgress} />
              <span className="text-xs text-gray-500">{state.overallProgress}%</span>
            </div>
          )}

          {/* Status message */}
          {state?.statusMessage && (
            <p className="text-xs text-gray-400 text-center">{state.statusMessage}</p>
          )}

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
