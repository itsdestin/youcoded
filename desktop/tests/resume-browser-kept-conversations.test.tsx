// @vitest-environment jsdom
// The Resume browser's speed, pinned as behaviour (2026-09-11). A click used to
// re-render every card in the list several times, and read and format its
// conversation from scratch — even one just looked at. Each test below is one
// of those costs that must not come back.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Counts card renders: every list card with a recorded model resolves its brand
// once per render, keyed by a model id unique to that card.
const brandCalls = vi.hoisted(() => new Map<string, number>());
vi.mock('../src/renderer/components/provider-brand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/components/provider-brand')>();
  return {
    ...actual,
    resolveModelBrand: (modelId: string, providerType?: any) => {
      brandCalls.set(modelId, (brandCalls.get(modelId) ?? 0) + 1);
      return actual.resolveModelBrand(modelId, providerType);
    },
  };
});

import ResumeBrowser from '../src/renderer/components/ResumeBrowser';

beforeAll(() => {
  // Wide viewport, declared (narrow-viewport rule): the panel only exists there.
  (window as any).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} });
  Element.prototype.scrollIntoView = vi.fn();
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => { cleanup(); brandCalls.clear(); });

const idFor = (i: number) => `a3f2aaaa-1111-4111-8111-${String(i).padStart(12, '0')}`;
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
  sessionId: idFor(i),
  name: `Conversation ${i}`,
  projectSlug: 'proj',
  projectPath: '/tmp/youcoded',
  lastModified: Date.now() - i * 60_000,
  size: 200,
  provider: 'claude',
  lastUsedModel: { modelId: `model-for-row-${i}`, providerLabel: 'Test', providerType: 'anthropic' },
}));

function mockClaude(sessions: any[]) {
  const read = vi.fn(async (req: { id: string }) => ({
    ok: true,
    messages: [{ role: 'user', content: `text of ${req.id}`, timestamp: 1, seq: 0, droppedToolCalls: 0 }],
    hasMore: false,
  }));
  (window as any).claude = {
    session: {
      browse: vi.fn().mockResolvedValue(sessions),
      setFlag: vi.fn().mockResolvedValue({ ok: true }),
      setTag: vi.fn().mockResolvedValue({ ok: true }),
      setNote: vi.fn().mockResolvedValue({ ok: true }),
      getMeta: vi.fn().mockResolvedValue({ tags: [], note: '' }),
    },
    tags: { list: vi.fn().mockResolvedValue([]) },
    providers: { catalog: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([]) },
    chatsearch: { read },
    on: {},
  };
  return read;
}

const open = () => render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} defaultModel="sonnet" />);
const readsOf = (read: ReturnType<typeof mockClaude>, id: string) => read.mock.calls.filter(([req]) => req.id === id).length;
// The layer showing a conversation is the one not hidden.
const isShown = (id: string) => {
  const text = screen.queryByText(`text of ${id}`);
  const layer = text?.closest('[style*="visibility"]') as HTMLElement | null;
  return !!layer && layer.style.visibility === 'visible';
};

describe('Resume browser — conversations kept built', () => {
  it('brings back a conversation read a moment ago without reading it again', async () => {
    const read = mockClaude(rows(3));
    open();
    fireEvent.click(await screen.findByText('Conversation 0'));
    await waitFor(() => expect(isShown(idFor(0))).toBe(true));
    fireEvent.click(screen.getByText('Conversation 1'));
    await waitFor(() => expect(isShown(idFor(1))).toBe(true));
    expect(isShown(idFor(0))).toBe(false);

    fireEvent.click(screen.getByText('Conversation 0'));
    await waitFor(() => expect(isShown(idFor(0))).toBe(true));
    expect(readsOf(read, idFor(0))).toBe(1);
  });

  it('starts reading a row the pointer rests on, so the click finds it ready', async () => {
    const read = mockClaude(rows(3));
    open();
    const card = (await screen.findByText('Conversation 2')).closest('.rounded-lg')!;
    fireEvent.pointerEnter(card, { pointerType: 'mouse' });
    await waitFor(() => expect(readsOf(read, idFor(2))).toBe(1));
    // Warming is silent: nothing is on screen until the row is picked.
    expect(isShown(idFor(2))).toBe(false);

    fireEvent.click(screen.getByText('Conversation 2'));
    await waitFor(() => expect(isShown(idFor(2))).toBe(true));
    expect(readsOf(read, idFor(2))).toBe(1);
  });

  it('passes the row’s project folder so main can open the file without a lookup', async () => {
    const read = mockClaude(rows(1));
    open();
    fireEvent.click(await screen.findByText('Conversation 0'));
    await waitFor(() => expect(read).toHaveBeenCalledWith(expect.objectContaining({ id: idFor(0), projectSlug: 'proj' })));
  });
});

describe('Resume browser — a click re-renders only the cards it changes', () => {
  it('leaves every card whose highlight did not move alone', async () => {
    mockClaude(rows(20));
    open();
    fireEvent.click(await screen.findByText('Conversation 0'));
    await waitFor(() => expect(isShown(idFor(0))).toBe(true));

    brandCalls.clear();
    fireEvent.click(screen.getByText('Conversation 1'));
    await waitFor(() => expect(isShown(idFor(1))).toBe(true));

    // Row 0 lost its highlight and row 1 gained it (and row 1 is drawn again
    // as the sheet's header card). Rows 2–19 changed nothing; before this they
    // re-rendered on every state change the click caused.
    for (let i = 2; i < 20; i++) expect(brandCalls.get(`model-for-row-${i}`) ?? 0).toBe(0);
    expect(brandCalls.get('model-for-row-1') ?? 0).toBeGreaterThan(0);
  });
});
