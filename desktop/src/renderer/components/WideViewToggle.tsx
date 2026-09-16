import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ChatIcon, TerminalIcon } from './Icons';
import { Tooltip } from './ui';

export type ViewMode = 'chat' | 'terminal';

export interface WideViewToggleProps {
  viewMode: ViewMode;
  onToggleView: (view: ViewMode) => void;
  showLabels: boolean;
}

export type ToggleEndpoints = Record<ViewMode, { left: number; width: number }>;

export interface ToggleMeasurementInput {
  container: DOMRect;
  chat: DOMRect;
  terminal: DOMRect;
}

const GEOMETRY_TOLERANCE_PX = 0.5;

export function measureToggleEndpoints({
  container,
  chat,
  terminal,
}: ToggleMeasurementInput): ToggleEndpoints | null {
  const values = [
    container.left, container.width, container.height,
    chat.left, chat.width,
    terminal.left, terminal.width,
  ];
  if (values.some(value => !Number.isFinite(value))) return null;
  if (container.width <= 0 || container.height <= 0 || chat.width <= 0 || terminal.width <= 0) {
    return null;
  }
  return {
    chat: { left: chat.left - container.left, width: chat.width },
    terminal: { left: terminal.left - container.left, width: terminal.width },
  };
}

export function endpointsEqual(
  current: ToggleEndpoints | null,
  next: ToggleEndpoints,
  tolerance = GEOMETRY_TOLERANCE_PX,
): boolean {
  if (!current) return false;
  return (['chat', 'terminal'] as const).every(mode =>
    Math.abs(current[mode].left - next[mode].left) <= tolerance
      && Math.abs(current[mode].width - next[mode].width) <= tolerance,
  );
}

// WHY: the visible row and both sizing rows must share these layout primitives
// exactly — any drift in padding, gap, icon size, or label maximums silently
// produces endpoints that don't match where the buttons actually land. ROW_CLASS
// deliberately omits `position` so each consumer can add its own (`relative` for
// the visible row, `absolute` for the inert copies) without the two competing:
// Tailwind emits `.relative` after `.absolute`, so a combined string would leave
// the sizing rows in normal flow.
const ROW_CLASS = 'flex bg-inset rounded-md p-0.5 gap-0.5';
const CONTAINER_CLASS = `relative ${ROW_CLASS}`;
const BUTTON_LAYOUT_CLASS = 'px-1.5 sm:px-2.5 py-1 rounded-[var(--radius-toggle)] flex items-center gap-1.5';
const LABEL_LAYOUT_CLASS = 'text-xs font-medium overflow-hidden whitespace-nowrap';
const ICON_CLASS = 'w-3.5 h-3.5 shrink-0';
const CHAT_LABEL_MAX = '3rem';
const TERMINAL_LABEL_MAX = '4.5rem';

// WHY: `shrink-0` is load-bearing, not cosmetic. An endpoint box must always
// report the width its option WOULD occupy when active. The sizing rows are
// `inset-0`, so they inherit the container's current width — which is sized by
// the visible row, where only one label is expanded. The row whose label is
// expanded therefore wants more width than the container has, and a shrinkable
// box would be squeezed to fit and measured too narrow. Worse, its width would
// then track the container, which animates for 300ms during the label rollout —
// reintroducing exactly the live-follow stutter this component exists to avoid
// (see the failed attempts named below). It overflows instead; the row is
// invisible and the app root is `overflow: hidden`, so nothing is visible.
// Kept off BUTTON_LAYOUT_CLASS deliberately: that constant is shared with the
// visible buttons, which must keep their normal flex behavior.
const ENDPOINT_BOX_CLASS = `${BUTTON_LAYOUT_CLASS} shrink-0`;

interface EndpointRowProps {
  mode: ViewMode;
  showLabels: boolean;
  activeRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * One inert copy of the toggle in a completed state: the row's own mode has its
 * label fully rolled out, the other is collapsed. Nothing here transitions, so a
 * ResizeObserver on the active box sees only real environmental geometry
 * changes (font, theme, zoom, label mode) — never a frame of the 300ms rollout.
 */
function EndpointRow({ mode, showLabels, activeRef }: EndpointRowProps) {
  const chatActive = mode === 'chat';
  return (
    <div className={`${ROW_CLASS} absolute inset-0`}>
      <div
        ref={chatActive ? activeRef : undefined}
        className={ENDPOINT_BOX_CLASS}
        data-testid={chatActive ? 'chat-endpoint' : undefined}
      >
        <ChatIcon className={ICON_CLASS} />
        <span
          data-sizing-label
          className={`${LABEL_LAYOUT_CLASS} ${showLabels ? 'inline-block' : 'hidden'}`}
          style={{ maxWidth: chatActive ? CHAT_LABEL_MAX : '0' }}
        >Chat</span>
      </div>
      <div
        ref={!chatActive ? activeRef : undefined}
        className={ENDPOINT_BOX_CLASS}
        data-testid={!chatActive ? 'terminal-endpoint' : undefined}
      >
        <TerminalIcon className={ICON_CLASS} />
        <span
          data-sizing-label
          className={`${LABEL_LAYOUT_CLASS} ${showLabels ? 'inline-block' : 'hidden'}`}
          style={{ maxWidth: !chatActive ? TERMINAL_LABEL_MAX : '0' }}
        >Terminal</span>
      </div>
    </div>
  );
}

export default function WideViewToggle({
  viewMode,
  onToggleView,
  showLabels,
}: WideViewToggleProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chatEndpointRef = useRef<HTMLDivElement>(null);
  const terminalEndpointRef = useRef<HTMLDivElement>(null);
  const endpointsRef = useRef<ToggleEndpoints | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const syncEndFrameRef = useRef<number | null>(null);
  const [endpoints, setEndpoints] = useState<ToggleEndpoints | null>(null);
  const [geometrySyncing, setGeometrySyncing] = useState(true);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const chat = chatEndpointRef.current;
    const terminal = terminalEndpointRef.current;
    if (!container || !chat || !terminal) return;

    const next = measureToggleEndpoints({
      container: container.getBoundingClientRect(),
      chat: chat.getBoundingClientRect(),
      terminal: terminal.getBoundingClientRect(),
    });
    // WHY: an invalid sample (detached, zero-sized, mid-teardown) is ignored
    // rather than committed — otherwise it would overwrite good geometry with
    // zeros and make a correctly-placed indicator collapse to nothing.
    if (!next || endpointsEqual(endpointsRef.current, next)) return;

    // WHY: font/theme/zoom corrections are geometry maintenance, not user
    // selections. Suppress the slide for this commit so the indicator cannot
    // visibly chase a newly loaded font, then re-arm selection motion next frame.
    endpointsRef.current = next;
    setGeometrySyncing(true);
    setEndpoints(next);
    if (syncEndFrameRef.current !== null) cancelAnimationFrame(syncEndFrameRef.current);
    syncEndFrameRef.current = requestAnimationFrame(() => {
      syncEndFrameRef.current = null;
      setGeometrySyncing(false);
    });
  }, []);

  const scheduleMeasure = useCallback(() => {
    if (measureFrameRef.current !== null) return;
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measure();
    });
  }, [measure]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const chat = chatEndpointRef.current;
    const terminal = terminalEndpointRef.current;
    if (!container || !chat || !terminal) return;

    // WHY: stable endpoint copies change for every relevant cause—font load,
    // theme, zoom, label mode, or container geometry—without observing the
    // visible 300ms label animation that caused the historical stutter.
    // Never observe the visible buttons or the container: commits ae5776ee,
    // 68462e9b, and a0103014 each tried gluing the indicator to the animating
    // active button and produced a stutter or a teleport. That history is the
    // reason this inert sizing layer exists — don't "simplify" it away.
    measure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(chat);
    observer.observe(terminal);
    return () => {
      observer.disconnect();
      // Null after cancelling: a stale non-null id would make scheduleMeasure
      // think a frame is still pending (and geometry-sync mode never end) if
      // this effect were ever re-run on the same instance.
      if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
      measureFrameRef.current = null;
      if (syncEndFrameRef.current !== null) cancelAnimationFrame(syncEndFrameRef.current);
      syncEndFrameRef.current = null;
    };
  }, [measure, scheduleMeasure]);

  // WHY: read at render time, so a correction that lands mid-selection always
  // resolves against the newest viewMode instead of one captured in a closure.
  const activeEndpoint = endpoints?.[viewMode] ?? null;

  return (
    // data-view-toggle: what ViewToggleHint's coach mark points at. Both toggle
    // variants carry it so the hint follows the narrow-breakpoint swap.
    <div
      ref={containerRef}
      data-testid="wide-view-toggle"
      data-view-toggle
      data-geometry-syncing={geometrySyncing ? 'true' : undefined}
      className={`${CONTAINER_CLASS} wide-view-toggle`}
    >
      <div
        data-testid="toggle-indicator"
        className="wide-view-toggle-indicator absolute top-0.5 bottom-0.5 bg-accent rounded-[var(--radius-toggle)] transition-[left,width] duration-300 ease-in-out"
        style={{
          left: activeEndpoint ? `${activeEndpoint.left}px` : undefined,
          width: activeEndpoint ? `${activeEndpoint.width}px` : undefined,
          // Hidden until this mount has measured its own geometry — a fresh
          // wide mount must never inherit a prior node's readiness.
          opacity: activeEndpoint ? 1 : 0,
        }}
      />
      {/* The hint matters most in icon-only mode (<560px header), where the
          visible label is hidden. aria-label still supplies the a11y name. */}
      <Tooltip text="Chat" placement="bottom">
      <button
        type="button"
        aria-label="Chat"
        aria-pressed={viewMode === 'chat'}
        onClick={() => onToggleView('chat')}
        className={`relative z-10 ${BUTTON_LAYOUT_CLASS} transition-colors duration-300 ${
          viewMode === 'chat' ? 'text-on-accent' : 'text-fg-dim hover:text-fg-2'
        }`}
      >
        <ChatIcon className={ICON_CLASS} />
        <span
          data-testid="chat-label"
          className={`wide-view-toggle-label ${LABEL_LAYOUT_CLASS} transition-[max-width,opacity] duration-300 ease-in-out ${showLabels ? 'inline-block' : 'hidden'}`}
          style={{ maxWidth: viewMode === 'chat' ? CHAT_LABEL_MAX : '0', opacity: viewMode === 'chat' ? 1 : 0 }}
        >Chat</span>
      </button>
      </Tooltip>
      <Tooltip text="Terminal" placement="bottom">
      <button
        type="button"
        aria-label="Terminal"
        aria-pressed={viewMode === 'terminal'}
        onClick={() => onToggleView('terminal')}
        className={`relative z-10 ${BUTTON_LAYOUT_CLASS} transition-colors duration-300 ${
          viewMode === 'terminal' ? 'text-on-accent' : 'text-fg-dim hover:text-fg-2'
        }`}
      >
        <TerminalIcon className={ICON_CLASS} />
        <span
          data-testid="terminal-label"
          className={`wide-view-toggle-label ${LABEL_LAYOUT_CLASS} transition-[max-width,opacity] duration-300 ease-in-out ${showLabels ? 'inline-block' : 'hidden'}`}
          style={{ maxWidth: viewMode === 'terminal' ? TERMINAL_LABEL_MAX : '0', opacity: viewMode === 'terminal' ? 1 : 0 }}
        >Terminal</span>
      </button>
      </Tooltip>
      {/* Inert measuring layer: absolute + invisible + pointer-events-none, so it
          has real geometry but never paints, never takes a tab stop, and never
          contributes to the container's intrinsic width. */}
      <div
        data-testid="toggle-sizing-layer"
        data-labels={showLabels ? 'shown' : 'hidden'}
        aria-hidden="true"
        className="absolute inset-0 invisible pointer-events-none"
      >
        <EndpointRow mode="chat" showLabels={showLabels} activeRef={chatEndpointRef} />
        <EndpointRow mode="terminal" showLabels={showLabels} activeRef={terminalEndpointRef} />
      </div>
    </div>
  );
}
