// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FilesTab } from '../src/renderer/components/project-view/tabs/FilesTab';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { cloudConsentPreview } from '../src/renderer/dev/workbench/cloud-consent-preview';

// WHY: mount identity, not a no-op IntersectionObserver, proves protected fixture
// tiles never reach the content-reading thumbnail component in this UI proposal.
vi.mock('../src/renderer/components/ArtifactThumbnail', () => ({
  ArtifactThumbnail: ({ artifact }: { artifact: { path: string } }) => <span data-testid="thumbnail">{artifact.path} preview</span>,
}));
const dispatch = vi.fn();
const onSelect = vi.fn();
const files = ['README.md', 'latency-chart.png', 'scratch.md'].map((path) => ({
  id: path, path, kind: 'internal', lastModified: '2026-09-01T00:00:00Z',
}));
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  (window as any).claude = { artifacts: {
    listAllFiles: vi.fn(async () => ({ ok: true, files })),
    onChanged: () => () => {}, watchProject: async () => ({ ok: true }), unwatchProject: async () => {},
  } };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
function show(view: 'grid' | 'list', enabled = true, waiting = false) {
  const preview = cloudConsentPreview(new URLSearchParams('cloudConsent=denied'))!;
  render(<ArtifactProvider value={{ state: { activeArtifactBySession: {} } as any, dispatch }}>
    <FilesTab project={{ id: 'p', path: '/project', name: 'Project' } as any} search="" types={new Set()} sortBy="name" view={view} onViewChange={vi.fn()} refreshKey={0}
      cloudPreview={enabled ? { ...preview, state: waiting ? { ...preview.initial, phase: 'waiting', file: 'latency-chart.png' } : preview.initial, onSelect, onAction: vi.fn() } : undefined} />
  </ArtifactProvider>);
}
describe('real Files surface with opt-in cloud fixtures', () => {
  it('never mounts extra thumbnails after approval of a selected action', async () => {
    show('grid', true, true);
    await screen.findByTitle('scratch.md');
    expect(screen.getAllByTestId('thumbnail')).toHaveLength(1);
    expect(screen.getByTestId('cloud-storage-icon')).toHaveAttribute('width', '18');
  });
  it('mounts a thumbnail only for the local file, not cloud or unknown tiles', async () => {
    show('grid');
    await screen.findByTitle('scratch.md');
    expect(screen.getAllByTestId('thumbnail')).toHaveLength(1);
    expect(screen.getByTestId('thumbnail')).toHaveTextContent('README.md');
    expect(screen.getAllByTestId('cloud-file-placeholder')).toHaveLength(2);
    expect(within(screen.getByTitle('latency-chart.png')).getByText('Opening needs a download')).toBeInTheDocument();
    expect(within(screen.getByTitle('scratch.md')).getByText('Opening may need a download')).toBeInTheDocument();
  });
  it.each(['grid', 'list'] as const)('keeps local selection usable and cloud selection inline in %s', async (view) => {
    show(view);
    fireEvent.click(await screen.findByTitle('README.md'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'ACTIVE_ARTIFACT_SET', sessionId: 'project-view', artifactId: 'README.md' });
    dispatch.mockClear();
    fireEvent.click(screen.getByTitle('latency-chart.png'));
    expect(onSelect).toHaveBeenCalledWith('latency-chart.png');
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('scratch.md'));
    expect(onSelect).toHaveBeenCalledWith('scratch.md');
  });
  it('names availability on list rows too, including unknown', async () => {
    show('list');
    expect(within(await screen.findByTitle('latency-chart.png')).getByText('Online-only')).toBeInTheDocument();
    expect(within(screen.getByTitle('scratch.md')).getByText('Availability unknown')).toBeInTheDocument();
  });
  it('does not alter thumbnails without the explicit preview prop', async () => {
    show('grid', false);
    await screen.findByTitle('scratch.md');
    expect(screen.getAllByTestId('thumbnail')).toHaveLength(3);
    expect(screen.queryByTestId('cloud-file-consent')).not.toBeInTheDocument();
  });
  it('does not enable mock state for missing or invalid URL switches', () => {
    expect(cloudConsentPreview(new URLSearchParams())).toBeNull();
    expect(cloudConsentPreview(new URLSearchParams('cloudConsent=invalid'))).toBeNull();
  });
});
