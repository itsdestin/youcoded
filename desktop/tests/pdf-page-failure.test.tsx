// @vitest-environment jsdom
// Card #134 round 4: a PDF page that fails to load or draw says "Couldn’t show page N." (the curly
// apostrophe is the component's own). A render that was CANCELLED (zoom change, closing) is the
// expected path and must show nothing. pdf.js is mocked as in pdf-view-zoom.test.tsx; the real PdfView renders.
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Per-page behaviour is swapped by each test.
let pageImpl: (n: number) => Promise<any>;
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({ numPages: 2, getPage: (n: number) => pageImpl(n), destroy: async () => {} }),
    destroy: async () => {},
  })),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

const goodPage = (n: number, renderPromise: () => Promise<void> = () => Promise.resolve()) => ({
  pageNumber: n,
  getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
  render: vi.fn(() => ({ promise: renderPromise(), cancel: vi.fn() })),
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  (HTMLCanvasElement.prototype as any).getContext = vi.fn(() => ({}));
  (window as any).matchMedia = (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true });
  (window as any).claude = { artifacts: { readBinary: vi.fn(async () => ({ ok: true, base64: 'AAAA' })) } };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderPdf = async () => {
  const { PdfView } = await import('../src/renderer/components/artifact-views/PdfView');
  return render(<PdfView {...({ path: 'a.pdf', absolutePath: '/p/a.pdf', content: null, isEditable: false } as any)} />);
};
const settle = () => new Promise<void>((r) => setTimeout(r, 30));

describe('PDF page failure line', () => {
  it('a page that cannot be loaded says which page, and the good page stays quiet', async () => {
    pageImpl = async (n) => { if (n === 2) throw new Error('bad page'); return goodPage(n); };
    await renderPdf();
    expect(await screen.findByText('Couldn’t show page 2.')).toBeInTheDocument();
    expect(screen.queryByText('Couldn’t show page 1.')).toBeNull();
  });

  it('a page that loads but fails to draw says so', async () => {
    pageImpl = async (n) => goodPage(n, n === 1 ? () => Promise.reject(new Error('draw blew up')) : undefined);
    await renderPdf();
    expect(await screen.findByText('Couldn’t show page 1.')).toBeInTheDocument();
  });

  it('a cancelled render shows nothing', async () => {
    const cancelled = Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' });
    const renders: any[] = [];
    pageImpl = async (n) => { const p = goodPage(n, () => Promise.reject(cancelled)); renders.push(p.render); return p; };
    await renderPdf();
    await vi.waitFor(() => expect(renders.length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(renders.some((r) => r.mock.calls.length > 0)).toBe(true));
    // settle: a negative assertion, so give the rejected render promises time to land before checking nothing appeared.
    await settle();
    expect(screen.queryByText(/Couldn’t show page/)).toBeNull();
  });

  it('pages that draw fine show no notice', async () => {
    const renders: any[] = [];
    pageImpl = async (n) => { const p = goodPage(n); renders.push(p.render); return p; };
    await renderPdf();
    await vi.waitFor(() => expect(renders.some((r) => r.mock.calls.length > 0)).toBe(true));
    // settle: negative assertion after the draws resolve.
    await settle();
    expect(screen.queryByText(/Couldn’t show page/)).toBeNull();
  });
});
