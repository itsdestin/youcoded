// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WideViewToggle, {
  endpointsEqual,
  measureToggleEndpoints,
  type ToggleEndpoints,
} from './WideViewToggle';

const rect = (left: number, width: number, height = 28): DOMRect => ({
  x: left,
  y: 0,
  left,
  right: left + width,
  top: 0,
  bottom: height,
  width,
  height,
  toJSON: () => ({}),
} as DOMRect);

class ControlledResizeObserver {
  static instances: ControlledResizeObserver[] = [];
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }

  fire(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let rafQueue: FrameRequestCallback[];
let cancelledFrames: number[];

function flushFrame(time = 16): void {
  const pending = rafQueue;
  rafQueue = [];
  act(() => pending.forEach(callback => callback(time)));
}

function installRects(
  container: HTMLElement,
  chatEndpoint: HTMLElement,
  terminalEndpoint: HTMLElement,
  values: { container: DOMRect; chat: DOMRect; terminal: DOMRect },
): void {
  vi.spyOn(container, 'getBoundingClientRect').mockImplementation(() => values.container);
  vi.spyOn(chatEndpoint, 'getBoundingClientRect').mockImplementation(() => values.chat);
  vi.spyOn(terminalEndpoint, 'getBoundingClientRect').mockImplementation(() => values.terminal);
}

function getGeometryNodes(container: HTMLElement) {
  return {
    root: container.querySelector<HTMLElement>('[data-testid="wide-view-toggle"]')!,
    indicator: container.querySelector<HTMLElement>('[data-testid="toggle-indicator"]')!,
    chatEndpoint: container.querySelector<HTMLElement>('[data-testid="chat-endpoint"]')!,
    terminalEndpoint: container.querySelector<HTMLElement>('[data-testid="terminal-endpoint"]')!,
    sizingLayer: container.querySelector<HTMLElement>('[data-testid="toggle-sizing-layer"]')!,
  };
}

beforeEach(() => {
  ControlledResizeObserver.instances = [];
  rafQueue = [];
  cancelledFrames = [];
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    rafQueue.push(callback);
    return rafQueue.length;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => {
    cancelledFrames.push(id);
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('toggle endpoint geometry', () => {
  it('derives both endpoints relative to the mounted container', () => {
    expect(measureToggleEndpoints({
      container: rect(100, 160),
      chat: rect(102, 64),
      terminal: rect(138, 90),
    })).toEqual({
      chat: { left: 2, width: 64 },
      terminal: { left: 38, width: 90 },
    });
  });

  it.each([
    ['zero container', rect(0, 0), rect(2, 64), rect(38, 90)],
    ['zero chat width', rect(0, 160), rect(2, 0), rect(38, 90)],
    ['zero terminal width', rect(0, 160), rect(2, 64), rect(38, 0)],
    ['non-finite coordinate', rect(0, 160), rect(Number.NaN, 64), rect(38, 90)],
  ])('rejects %s', (_name, containerRect, chatRect, terminalRect) => {
    expect(measureToggleEndpoints({
      container: containerRect,
      chat: chatRect,
      terminal: terminalRect,
    })).toBeNull();
  });

  it('deduplicates subpixel movement at the exact 0.5px tolerance', () => {
    const current: ToggleEndpoints = {
      chat: { left: 2, width: 64 },
      terminal: { left: 38, width: 90 },
    };
    expect(endpointsEqual(current, {
      chat: { left: 2.49, width: 64.5 },
      terminal: { left: 37.51, width: 89.5 },
    })).toBe(true);
    expect(endpointsEqual(current, {
      chat: { left: 2.51, width: 64 },
      terminal: { left: 38, width: 90 },
    })).toBe(false);
  });
});

describe('WideViewToggle', () => {
  function renderToggle(viewMode: 'chat' | 'terminal' = 'chat', showLabels = true) {
    const onToggleView = vi.fn();
    const result = render(
      <WideViewToggle
        viewMode={viewMode}
        onToggleView={onToggleView}
        showLabels={showLabels}
      />,
    );
    return { ...result, onToggleView };
  }

  function makeReady(container: HTMLElement, values = {
    container: rect(100, 160),
    chat: rect(102, 64),
    terminal: rect(138, 90),
  }) {
    const nodes = getGeometryNodes(container);
    installRects(nodes.root, nodes.chatEndpoint, nodes.terminalEndpoint, values);
    act(() => ControlledResizeObserver.instances[0].fire());
    flushFrame();
    return nodes;
  }

  it('stays hidden until the current mount has valid geometry', () => {
    const { container } = renderToggle();
    const { indicator } = getGeometryNodes(container);
    expect(indicator.style.opacity).toBe('0');
  });

  it('initializes at the active endpoint while geometry transitions are suppressed', () => {
    const { container } = renderToggle('chat');
    const nodes = makeReady(container);
    expect(nodes.indicator.style.left).toBe('2px');
    expect(nodes.indicator.style.width).toBe('64px');
    expect(nodes.indicator.style.opacity).toBe('1');
    expect(nodes.root.dataset.geometrySyncing).toBe('true');
    flushFrame(32);
    expect(nodes.root.dataset.geometrySyncing).toBeUndefined();
  });

  it('moves to a cached endpoint on view change without entering geometry-sync mode', () => {
    const { container, rerender, onToggleView } = renderToggle('chat');
    const nodes = makeReady(container);
    flushFrame(32);
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(onToggleView).toHaveBeenCalledWith('terminal');
    rerender(
      <WideViewToggle viewMode="terminal" onToggleView={onToggleView} showLabels />,
    );
    expect(nodes.indicator.style.left).toBe('38px');
    expect(nodes.indicator.style.width).toBe('90px');
    expect(nodes.root.dataset.geometrySyncing).toBeUndefined();
  });

  // The reverse direction is the asymmetric one: the container SHRINKS as the
  // wider Terminal label rolls up, so it is where a shrinkable sizing box would
  // first show up as a wrong endpoint width.
  it('moves back to the chat endpoint on the reverse view change', () => {
    const { container, rerender, onToggleView } = renderToggle('terminal');
    const nodes = makeReady(container);
    flushFrame(32);
    expect(nodes.indicator.style.left).toBe('38px');
    expect(nodes.indicator.style.width).toBe('90px');
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(onToggleView).toHaveBeenCalledWith('chat');
    rerender(<WideViewToggle viewMode="chat" onToggleView={onToggleView} showLabels />);
    expect(nodes.indicator.style.left).toBe('2px');
    expect(nodes.indicator.style.width).toBe('64px');
    expect(nodes.root.dataset.geometrySyncing).toBeUndefined();
  });

  it('coalesces observer bursts and snaps an environmental correction', () => {
    const { container, rerender, onToggleView } = renderToggle('chat');
    const nodes = makeReady(container);
    flushFrame(32);
    const updated = {
      container: rect(100, 180),
      chat: rect(102, 72),
      terminal: rect(146, 104),
    };
    installRects(nodes.root, nodes.chatEndpoint, nodes.terminalEndpoint, updated);
    const observer = ControlledResizeObserver.instances[0];
    act(() => {
      observer.fire();
      observer.fire();
      observer.fire();
    });
    expect(rafQueue).toHaveLength(1);
    flushFrame(48);
    expect(nodes.indicator.style.left).toBe('2px');
    expect(nodes.indicator.style.width).toBe('72px');
    expect(nodes.root.dataset.geometrySyncing).toBe('true');
    // A correction must update BOTH endpoints, not just the active one —
    // otherwise the next selection would slide to the pre-correction geometry.
    rerender(<WideViewToggle viewMode="terminal" onToggleView={onToggleView} showLabels />);
    expect(nodes.indicator.style.left).toBe('46px');
    expect(nodes.indicator.style.width).toBe('104px');
  });

  it('recalibrates endpoints when the label mode changes', () => {
    const { container, rerender, onToggleView } = renderToggle('chat', true);
    const nodes = makeReady(container);
    flushFrame(32);
    expect(nodes.indicator.style.width).toBe('64px');
    // Below the 560px header threshold HeaderBar drops the labels; the sizing
    // spans go `hidden`, the observed boxes shrink, and the observer is the
    // ONLY thing that reports it — nothing re-measures on a prop change.
    rerender(<WideViewToggle viewMode="chat" onToggleView={onToggleView} showLabels={false} />);
    installRects(nodes.root, nodes.chatEndpoint, nodes.terminalEndpoint, {
      container: rect(100, 64),
      chat: rect(102, 28),
      terminal: rect(132, 28),
    });
    act(() => ControlledResizeObserver.instances[0].fire());
    flushFrame(48);
    expect(nodes.indicator.style.left).toBe('2px');
    expect(nodes.indicator.style.width).toBe('28px');
    expect(nodes.root.dataset.geometrySyncing).toBe('true');
  });

  it('ignores invalid samples after readiness instead of hiding valid geometry', () => {
    const { container } = renderToggle('chat');
    const nodes = makeReady(container);
    flushFrame(32);
    installRects(nodes.root, nodes.chatEndpoint, nodes.terminalEndpoint, {
      container: rect(100, 0),
      chat: rect(102, 0),
      terminal: rect(102, 0),
    });
    act(() => ControlledResizeObserver.instances[0].fire());
    flushFrame(48);
    expect(nodes.indicator.style.left).toBe('2px');
    expect(nodes.indicator.style.width).toBe('64px');
    expect(nodes.indicator.style.opacity).toBe('1');
  });

  it('ignores endpoint jitter at or below 0.5px', () => {
    const { container } = renderToggle('chat');
    const nodes = makeReady(container);
    flushFrame(32);
    installRects(nodes.root, nodes.chatEndpoint, nodes.terminalEndpoint, {
      container: rect(100, 160),
      chat: rect(102.5, 64.5),
      terminal: rect(137.5, 89.5),
    });
    act(() => ControlledResizeObserver.instances[0].fire());
    flushFrame(48);
    expect(nodes.root.dataset.geometrySyncing).toBeUndefined();
    expect(nodes.indicator.style.left).toBe('2px');
    expect(nodes.indicator.style.width).toBe('64px');
  });

  it('starts unready with fresh state after unmount and remount', () => {
    const first = renderToggle();
    makeReady(first.container);
    first.unmount();
    const second = renderToggle();
    expect(getGeometryNodes(second.container).indicator.style.opacity).toBe('0');
    expect(ControlledResizeObserver.instances).toHaveLength(2);
  });

  it('disconnects its observer and cancels queued frames on unmount', () => {
    const { container, unmount } = renderToggle();
    const nodes = getGeometryNodes(container);
    installRects(nodes.root, nodes.chatEndpoint, nodes.terminalEndpoint, {
      container: rect(100, 160), chat: rect(102, 64), terminal: rect(138, 90),
    });
    act(() => ControlledResizeObserver.instances[0].fire());
    expect(rafQueue).toHaveLength(1);
    unmount();
    expect(ControlledResizeObserver.instances[0].disconnect).toHaveBeenCalledOnce();
    expect(cancelledFrames.length).toBeGreaterThan(0);
  });

  it('uses icon-only endpoint copies when labels are disabled', () => {
    const { container, rerender, onToggleView } = renderToggle('chat', true);
    const nodes = makeReady(container);
    flushFrame(32);
    rerender(
      <WideViewToggle viewMode="chat" onToggleView={onToggleView} showLabels={false} />,
    );
    expect(nodes.sizingLayer.dataset.labels).toBe('hidden');
    expect(container.querySelectorAll('[data-sizing-label].hidden')).toHaveLength(4);
  });

  it('keeps sizing markup inert and visible controls accessible', () => {
    const { container } = renderToggle('chat');
    const nodes = getGeometryNodes(container);
    expect(nodes.sizingLayer.getAttribute('aria-hidden')).toBe('true');
    expect(nodes.sizingLayer.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Chat' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Terminal' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  // ViewToggleHint anchors to this attribute. Drop it and the coach mark that
  // sends a stuck user back to chat silently never renders — nothing else fails.
  it('carries the coach-mark anchor', () => {
    const { container } = renderToggle('terminal');
    expect(container.querySelector('[data-view-toggle]')).toBeTruthy();
  });

  it('uses the latest view when geometry changes during rapid mode updates', () => {
    const { container, rerender, onToggleView } = renderToggle('chat');
    const nodes = makeReady(container);
    flushFrame(32);
    rerender(<WideViewToggle viewMode="terminal" onToggleView={onToggleView} showLabels />);
    rerender(<WideViewToggle viewMode="chat" onToggleView={onToggleView} showLabels />);
    installRects(nodes.root, nodes.chatEndpoint, nodes.terminalEndpoint, {
      container: rect(100, 180), chat: rect(102, 72), terminal: rect(146, 104),
    });
    act(() => ControlledResizeObserver.instances[0].fire());
    flushFrame(48);
    expect(nodes.indicator.style.left).toBe('2px');
    expect(nodes.indicator.style.width).toBe('72px');
  });

  // The original bug was ownership, not math: HeaderBar cached endpoints on a
  // DOM node it could replace and kept a `measured` flag that outlived it. This
  // pins the architecture, not just the behavior.
  it('keeps endpoint ownership out of HeaderBar', () => {
    const source = readFileSync(join(__dirname, 'HeaderBar.tsx'), 'utf8');
    expect(source).toContain("import WideViewToggle from './WideViewToggle'");
    expect(source).toContain('<WideViewToggle');
    expect(source).not.toContain('measureEndpoints');
    expect(source).not.toContain('--pill-chat-left');
    expect(source).not.toContain('document.fonts.ready');
  });
});
