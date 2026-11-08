// App overlays, toasts and chat cards that no practice conversation reaches (`shoot dev/overlay#<which>`).
// WHY: the "what changed since the last release" comparison needs a picture of every visible part. These
// pieces appear only after a real failure, a takeover or a slash command, so no practice session ever
// shows them. Each is the REAL component given plain practice data; nothing here is drawn by hand.
// Photo-only build only (index.tsx; guarded by tests/shoot-build-guard.test.ts). Never ships.
import { useEffect, useState } from 'react';
import { ChatProvider, useChatDispatch } from '../../state/chat-context';
import MovedGate from '../../components/MovedGate';
import TrustGate from '../../components/TrustGate';
import { InitializingCover } from '../../components/InitializingCover';
import PendingHandoffView from '../../components/PendingHandoffView';
import RemoteUnsupportedNotice from '../../components/RemoteUnsupportedNotice';
import CompactingCard from '../../components/CompactingCard';
import CopyPicker from '../../components/CopyPicker';
import UsageCard from '../../components/UsageCard';
import ThinkingIndicator from '../../components/ThinkingIndicator';
import ModelLoadingBar from '../../components/ModelLoadingBar';
import SpecialistReportCard from '../../components/SpecialistReportCard';
import { VoiceButton, VoiceListeningStrip } from '../../components/VoiceButton';
import { RootErrorBoundary } from '../../components/RootErrorBoundary';
import ErrorBoundary from '../../components/ErrorBoundary';
import { EscCloseProvider } from '../../hooks/use-esc-close';
import type { VoiceNotice } from '../../hooks/useVoiceInput';
import { REMOTE_UNSUPPORTED_EVENT } from '../../remote-unsupported';
import { TRUST_PROMPT_TITLE } from '../../../shared/ink-select-parser';
import type { UsageSnapshot } from '../../state/chat-types';
import { ScreenMark, useScreenOpen } from '../../shoot-mode';

const noop = () => {};

// A part that fails the moment it draws, so the REAL crash screens (the app's two error boundaries) can be photographed.
// The words are plain practice text, not a made-up cause.
function Boom(): never { throw new Error('Practice crash: this part was made to fail so its crash screen can be photographed.'); }

// A fixed time so the "taking a while" countdown and elapsed counters read the same in every picture.
const usage = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  entryId: 'u1', timestamp: 0, costUsd: 1.37, inputTokens: 48200, outputTokens: 9100, cacheReadTokens: 120000,
  cacheCreationTokens: 8000, contextTokens: 86000, contextPercent: 57, duration: 754, apiDuration: 311,
  linesAdded: 210, linesRemoved: 45, fiveHourUtilization: 42, fiveHourResetsAt: '2030-01-01T18:00:00Z',
  sevenDayUtilization: 18, sevenDayResetsAt: '2030-01-05T09:00:00Z', ...over,
});

// The trust prompt arrives through the same action the app dispatches when it reads Claude Code's menu.
function TrustDemo() {
  const dispatch = useChatDispatch();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    dispatch({
      type: 'SHOW_PROMPT', sessionId: 'sandbox', promptId: 'trust', title: TRUST_PROMPT_TITLE,
      buttons: [{ label: 'Yes, I trust this folder', input: '1' }, { label: 'No, exit', input: '2' }],
    } as never);
    setReady(true);
  }, [dispatch]);
  return ready ? <TrustGate sessionId="sandbox" /> : null;
}

// A chat card sits in a column like the chat's, so its width and corners read as they do in a conversation.
const Column = ({ children }: { children: React.ReactNode }) => (
  <div className="mx-auto pt-16" style={{ maxWidth: 720 }}>{children}</div>
);

// The message box sits at the bottom of the chat, so voice pieces sit there too: the strip above where the box would be, and the
// mic at the box's right edge with its card hanging up and to the left, as VoiceButton places it.
const Bottom = ({ children }: { children: React.ReactNode }) => (
  <div className="fixed inset-x-0 bottom-0 pb-6"><div className="mx-auto px-4" style={{ maxWidth: 720 }}>{children}</div></div>
);

function Piece({ which }: { which: string }) {
  switch (which) {
    // Voice input after nothing came through: the amber strip while listening, then the card the mic opens.
    case 'voice-silent': return <Bottom><VoiceListeningStrip level={0} seconds={4} micSilent onStop={noop} /></Bottom>;
    case 'voice-no-sound': case 'voice-too-quiet': case 'voice-no-words': {
      const notice = which.slice('voice-'.length) as VoiceNotice;
      // EscCloseProvider: the card closes on Escape through the app's own stack, which this stand-in sits outside of.
      return <Bottom><EscCloseProvider><div className="flex justify-end">
        <VoiceButton phase="idle" readiness={{ state: 'ready', engine: 'Parakeet' }} level={0} seconds={0} error={null} notice={notice}
          onStart={noop} onStop={noop} onDownload={noop} onRecheck={noop} onClearError={noop} />
      </div></EscCloseProvider></Bottom>;
    }
    // The outermost boundary's "YouCoded failed to start" (no theme, inline styles), and the in-app crash box for one part.
    case 'crash-root': return <RootErrorBoundary><Boom /></RootErrorBoundary>;
    case 'crash-panel': return <Column><ErrorBoundary name="Files"><Boom /></ErrorBoundary></Column>;
    case 'moved': return <MovedGate device="Home PC" onExit={noop} onResume={noop} />;
    case 'trust': return <ChatProvider><TrustDemo /></ChatProvider>;
    case 'initializing':
      return <InitializingCover sessionId="sandbox" onOpenTerminal={noop}>
        <p className="text-sm text-fg-dim font-medium select-none">Initializing session...</p>
      </InitializingCover>;
    case 'handoff-waiting': case 'handoff-incomplete':
      return <PendingHandoffView visible drawerOpen={false} expanded={false} gamePane={null} onRetry={noop} onContinue={noop}
        tab={{ tabId: 'h1', conversationId: 'wb-conv-1', provider: 'claude', projectSlug: 'practice', name: 'Plan my week', cwd: '/home/practice',
          phase: which === 'handoff-waiting' ? 'waiting' : 'incomplete' }} />;
    case 'remote-unsupported': return <RemoteUnsupportedNotice />;
    case 'compacting': return <Column><CompactingCard startedAt={Date.now()} /></Column>;
    case 'copy-picker':
      return <Column><CopyPicker id="c1" onCopy={noop} onDismiss={noop} options={[
        { id: 'a', label: 'Full response', preview: 'Here is the plan for the week, starting with Monday…', content: '' },
        { id: 'b', label: 'Code block 1 (python)', preview: 'def total(rows): return sum(r.amount for r in rows)', content: '' },
        { id: 'c', label: 'Code block 2 (bash)', preview: 'npm run build && npm test', content: '' },
      ]} /></Column>;
    case 'usage': return <Column><UsageCard snapshot={usage()} /></Column>;
    case 'usage-chatgpt':
      return <Column><UsageCard snapshot={usage({ costUsd: null, subscriptionPlan: 'chatgpt', fiveHourUtilization: 64, sevenDayUtilization: 31, cacheReadTokens: null, cacheCreationTokens: null })} /></Column>;
    case 'thinking-stalled':
      return <Column><ThinkingIndicator stallWarning={{ retryInMs: 30000, willRetry: true }} lastOutputAt={null} providerType="openrouter" /></Column>;
    case 'thinking-prefill':
      return <Column><ThinkingIndicator promptProcessing={{ promptTokens: 24000, budgetMs: 60000, processed: 9000, cached: 2000, etaMs: 20000, timeMs: 8000 }} lastOutputAt={null} providerType="local" /></Column>;
    case 'model-loading': case 'model-reload':
      return <div className="relative mx-auto" style={{ maxWidth: 720, height: '70vh' }}>
        <ModelLoadingBar ref={undefined} modelState={which === 'model-loading' ? 'loading' : 'unloaded'}
          modelInfo={{ modelId: 'Qwen2.5-Coder-14B-Instruct-Q4_K_M', sizeBytes: 9 * 1024 ** 3 }}
          loadedBytes={which === 'model-loading' ? 5 * 1024 ** 3 : null} everResident={which === 'model-reload'} isThinking={false} onReload={noop} />
      </div>;
    case 'specialist-report': case 'specialist-failed': {
      const failed = which === 'specialist-failed';
      return <Column><SpecialistReportCard sessionId="sandbox" showTimestamps={false} injected="specialist-report"
        message={{ id: 'm1', role: 'user', timestamp: 0, content: failed
          ? '[Background specialist failed] Wren (explorer) could not finish.\n\nThe folder was not readable.'
          : '[Background specialist finished] Wren (explorer) completed the task.\n\nThe settings pages share three layouts; the third is only used by Backup & sync.' }}
        meta={{ childId: 'c1', title: 'Wren the Whistling Worker', agentType: 'explorer', description: 'Map the settings layouts',
          status: failed ? 'failed' : 'completed', steps: 4 }} /></Column>;
    }
    default: return null;
  }
}

export default function OverlaysPractice() {
  const [which, setWhich] = useState<string | null>(null);
  useScreenOpen('dev/overlay', () => setWhich(new URLSearchParams(location.search).get('overlay') ?? 'moved'));
  // The notice listens for this event, so it is raised once its listener is mounted (it clears itself after 6 s).
  useEffect(() => {
    if (which !== 'remote-unsupported') return undefined;
    const t = setTimeout(() => window.dispatchEvent(new CustomEvent(REMOTE_UNSUPPORTED_EVENT, {
      detail: { channel: 'social:list', feature: 'Friends and challenges', message: 'Friends and challenges isn’t available via remote access yet.' },
    })), 50);
    return () => clearTimeout(t);
  }, [which]);
  // Escape closes it like any layer (shoot --check presses it).
  useEffect(() => {
    // WHY not for the voice card: it is a popover with its own Escape (VoiceButton closes it), and Escape must close only the
    // top layer. This stand-in stays behind; the card going is what Escape does there.
    if (which === null || ['voice-no-sound', 'voice-too-quiet', 'voice-no-words'].includes(which)) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setWhich(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [which]);
  if (which === null) return null;
  // The notice floats over the app (it has no page of its own), so it gets no cover; every other piece does.
  const cover = which !== 'remote-unsupported';
  return (
    // WHY a small corner square without the cover: the notice is drawn by its own component over the app, so the mark
    // (which shoot checks is uncovered) must not sit under it, as in ToastPractice.
    <div className={cover ? 'fixed inset-0 text-fg bg-canvas' : 'fixed left-0 top-0 text-fg'}
      // WHY 99 for the voice card: it floats in the app's own popover layer (z 100, portaled out of the page), so a cover above
      // that would hide the very card being photographed. Everything else sits above the whole app.
      style={{ zIndex: which.startsWith('voice-') ? 99 : 100000, ...(cover ? {} : { width: 12, height: 12 }) }} role="dialog" aria-label="Overlay practice">
      <ScreenMark name="dev/overlay" />
      <Piece which={which} />
    </div>
  );
}
