// @vitest-environment jsdom
// Pins the artifact-pane read lifecycle (the "no longer on disk" flash fix).
// content === null used to be ONE signal meaning both "read in flight" and
// "file is gone", so EVERY artifact open flashed the alarming missing-file
// message until the read resolved. useArtifactContent + ArtifactContentState
// now keep loading / ready / missing / error apart. Pinned here:
//   1. While the read is pending: NO missing-file message — a quiet
//      loading placeholder instead.
//   2. A read that resolves orphan:true (the handler's genuine not-found
//      signal) shows "This file isn't where it was saved…" (worded 2026-09-11:
//      the read only knows the path is empty, so it no longer claims deletion).
//   3. A read that resolves with content shows the content.
//   4. A read ERROR is surfaced as the real error with Retry — never mapped
//      to the not-found message (a permissions failure is not a missing file).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent, cleanup, renderHook, waitFor } from '@testing-library/react';
import { ActiveArtifactView } from '../src/renderer/components/artifact-views/ActiveArtifactView';
import { useArtifactContent } from '../src/renderer/components/artifact-views/useArtifactContent';

const get = vi.fn();
const save = vi.fn();

const MISSING_MSG = /isn.t where it was saved/i;
const LOADING_MSG = /Loading file/i;

// Minimal real host: the same wiring SessionDrawer and FilesTab use —
// useArtifactContent owns the read, ActiveArtifactView renders the phases.
function Host({ artifact }: { artifact: any }) {
  const { content, setContent, contentInfo, contentState, retryRead } =
    useArtifactContent('/proj', artifact.id, artifact.path);
  return (
    <ActiveArtifactView
      artifact={artifact}
      content={content}
      contentInfo={contentInfo}
      contentState={contentState}
      onRetryRead={retryRead}
      projectRoot="/proj"
      projectId="p1"
      projectName="Proj"
      sessionId="s1"
      onContentChange={setContent}
    />
  );
}

const mdArtifact = { id: 'a1', kind: 'internal', path: 'notes.md' } as any;

// Controllable read: each get() call parks until the test resolves/rejects it.
let pending: Array<{ resolve: (v: any) => void; reject: (e: any) => void }>;
// Latest watcher subscription (ActiveArtifactView's onChanged effect) so tests
// can simulate an external write / file-reappears event.
let changedCb: ((evt: any) => void) | null;

beforeEach(() => {
  pending = [];
  changedCb = null;
  get.mockReset().mockImplementation(
    () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); })
  );
  save.mockReset().mockResolvedValue({ ok: true, mtimeMs: 1 });
  (window as any).claude = {
    artifacts: {
      get, save,
      onChanged: (cb: (evt: any) => void) => { changedCb = cb; return () => {}; },
    },
  };
});

// Queries bind to document.body — without cleanup, renders leak across tests
// and getByText trips on the previous test's tree.
afterEach(cleanup);

async function settle(fn: () => void) {
  await act(async () => { fn(); });
}

describe('artifact pane read lifecycle', () => {
  it('shows a loading placeholder, NOT the missing-file message, while the read is pending', () => {
    const utils = render(<Host artifact={mdArtifact} />);
    expect(get).toHaveBeenCalledTimes(1);
    // The bug this whole change exists to fix:
    expect(utils.queryByText(MISSING_MSG)).toBeNull();
    expect(utils.getByText(LOADING_MSG)).toBeTruthy();
  });

  it('shows "no longer on disk" ONLY once the read genuinely resolved orphan:true', async () => {
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].resolve({ ok: true, content: null, orphan: true }));
    expect(utils.getByText(MISSING_MSG)).toBeTruthy();
    expect(utils.queryByText(LOADING_MSG)).toBeNull();
  });

  it('shows the content once the read resolves with it', async () => {
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].resolve({
      ok: true, content: '# Hello world', orphan: false, binary: false, mtimeMs: 1,
    }));
    expect(await utils.findByText('Hello world')).toBeTruthy();
    expect(utils.queryByText(MISSING_MSG)).toBeNull();
    expect(utils.queryByText(LOADING_MSG)).toBeNull();
  });

  it('surfaces a failed read as the real error with Retry — never as "no longer on disk"', async () => {
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].resolve({ ok: false, error: 'protected-path' }));
    expect(utils.queryByText(MISSING_MSG)).toBeNull();
    expect(utils.getByText(/protected location/i)).toBeTruthy();
    // Retry re-runs the read; a successful second read shows the content.
    await settle(() => { fireEvent.click(utils.getByText('Retry')); });
    expect(get).toHaveBeenCalledTimes(2);
    await settle(() => pending[1].resolve({
      ok: true, content: '# Back now', orphan: false, binary: false, mtimeMs: 2,
    }));
    expect(await utils.findByText('Back now')).toBeTruthy();
  });

  it('surfaces a rejected invoke (thrown handler error) as an error, not a deleted file', async () => {
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].reject(new Error('EACCES: permission denied')));
    expect(utils.queryByText(MISSING_MSG)).toBeNull();
    expect(utils.getByText(/EACCES: permission denied/)).toBeTruthy();
  });

  it('unknown error codes surface verbatim (never a guessed cause)', async () => {
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].resolve({ ok: false, error: 'weird-new-code' }));
    expect(utils.getByText(/weird-new-code/)).toBeTruthy();
  });

  it('legacy callers without contentState keep the old semantics (null = missing)', () => {
    // Back-compat pin: a caller that has not adopted the tri-state must not
    // silently lose the missing-file notice.
    const utils = render(
      <ActiveArtifactView
        artifact={mdArtifact}
        content={null}
        projectRoot="/proj"
        projectId="p1"
        projectName="Proj"
        sessionId="s1"
        onContentChange={() => {}}
      />
    );
    expect(utils.getByText(MISSING_MSG)).toBeTruthy();
  });

  it('switching artifacts returns to loading (no stale missing message from the previous file)', async () => {
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].resolve({ ok: true, content: null, orphan: true }));
    expect(utils.getByText(MISSING_MSG)).toBeTruthy();
    // Switch to another file: the pane must drop back to loading, not keep
    // claiming the NEW file is gone while its read is in flight.
    await settle(() => {
      utils.rerender(<Host artifact={{ id: 'a2', kind: 'internal', path: 'other.md' } as any} />);
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(utils.queryByText(MISSING_MSG)).toBeNull();
    expect(utils.getByText(LOADING_MSG)).toBeTruthy();
  });

  it('ignores a stale resolve from a switched-away artifact (cancelled guard)', async () => {
    const utils = render(<Host artifact={mdArtifact} />);
    // Switch to a2 while a1's read is STILL pending — a1's late resolve must
    // not paint a1's content (or any resolved phase) into a2's pane.
    await settle(() => {
      utils.rerender(<Host artifact={{ id: 'a2', kind: 'internal', path: 'other.md' } as any} />);
    });
    expect(get).toHaveBeenCalledTimes(2);
    await settle(() => pending[0].resolve({
      ok: true, content: '# Hello from a1', orphan: false, binary: false, mtimeMs: 1,
    }));
    expect(utils.queryByText('Hello from a1')).toBeNull();
    expect(utils.getByText(LOADING_MSG)).toBeTruthy();
  });

  it('routes a text-extension file that sniffed BINARY to BinaryFallback, not a blank text viewer', async () => {
    // PR #303 follow-up bug: a .md (or .ts, …) containing NUL bytes resolves
    // with content:null + binary:true. The pane routed by EXTENSION to
    // MarkdownView/CodeEditorView, which rendered an empty pane from the null
    // content — a quiet blank instead of an honest "can't preview".
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].resolve({
      ok: true, content: null, orphan: false, binary: true, sizeBytes: 128,
    }));
    expect(utils.getByText(/contains data that isn.t text/i)).toBeTruthy();
    // Not the pre-#303 false claim, and not the loading placeholder either.
    expect(utils.queryByText(MISSING_MSG)).toBeNull();
    expect(utils.queryByText(LOADING_MSG)).toBeNull();
  });

  it('routes a sniffed-binary .html to BinaryFallback, not a perpetual "Loading…"', async () => {
    // Review gap on the same bug class: HtmlView also renders from the text
    // content prop (srcDoc) and with content:null shows "Loading…" FOREVER —
    // an unresolvable claim, worse than blank. Fallback + "Open in default
    // app" (→ browser) is the honest treatment.
    const utils = render(<Host artifact={{ id: 'a4', kind: 'internal', path: 'page.html' } as any} />);
    await settle(() => pending[0].resolve({
      ok: true, content: null, orphan: false, binary: true, sizeBytes: 128,
    }));
    expect(utils.getByText(/contains data that isn.t text/i)).toBeTruthy();
    expect(utils.queryByText(/^Loading…$/)).toBeNull();
  });

  it('a real binary-viewer extension (.png) routes to its viewer with no text read at all', async () => {
    // Control for the test above: files whose registered viewer already handles
    // bytes (Image/Pdf/…) must NOT land in the fallback. Since 2026-08-25 they
    // also never request text — the hook settles synchronously into
    // binary:true/ready, so there is no pending read to resolve here.
    const utils = render(<Host artifact={{ id: 'a3', kind: 'internal', path: 'shot.png' } as any} />);
    await settle(() => {});
    expect(pending).toHaveLength(0);
    expect(utils.queryByText(/contains data that isn.t text/i)).toBeNull();
    // Proof ImageView mounted: its byte-read path reports 'unavailable'
    // because this test's mock exposes no artifacts.readBinary.
    expect(utils.getByText(/Preview isn.t available/i)).toBeTruthy();
  });

  it('recovers from missing when the file reappears on disk (watcher refetch → onContentChange)', async () => {
    // PR #303 review regression: ActiveArtifactView's onChanged effect hands
    // refetched bytes back via onContentChange WITHOUT re-running the hook's
    // read — the phase must reconcile to ready, not stay stuck on "missing"
    // until reselect. Pre-tri-state this auto-recovered.
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].resolve({ ok: true, content: null, orphan: true }));
    expect(utils.getByText(MISSING_MSG)).toBeTruthy();
    // Agent recreates the file → watcher 'add'/'change' → subscribed handler
    // refetches (the REAL production path, not a synthetic setContent call).
    expect(changedCb).toBeTruthy();
    await settle(() => changedCb!({ projectRoot: '/proj', artifactId: 'a1', kind: 'add' }));
    expect(get).toHaveBeenCalledTimes(2);
    await settle(() => pending[1].resolve({
      ok: true, content: '# Recovered', orphan: false, binary: false, mtimeMs: 2,
    }));
    expect(await utils.findByText('Recovered')).toBeTruthy();
    expect(utils.queryByText(MISSING_MSG)).toBeNull();
  });
});

// ── Byte-only routing: images/PDFs/Office docs never take the text path ──
// THE REPORTED BUG (2026-08-25): a 2.3 MB PNG was refused by the TEXT editor's
// 2 MB cap, even though images are governed by the 50 MB byte ceiling and never
// use the text at all.
describe('byte-only files never take the text path', () => {
  it('does not call artifacts.get for a png', async () => {
    const { result } = renderHook(() => useArtifactContent('/proj', 'a1', 'shot.png'));
    await waitFor(() => expect(result.current.contentState.phase).toBe('ready'));
    expect(get).not.toHaveBeenCalled();
    expect(result.current.content).toBeNull();
    // binary:true is what holds the edit affordance shut downstream.
    expect(result.current.contentInfo?.binary).toBe(true);
  });

  it('still calls artifacts.get for svg, which is editable', async () => {
    renderHook(() => useArtifactContent('/proj', 'a2', 'logo.svg'));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  });

  it('still calls artifacts.get when no path is supplied', async () => {
    renderHook(() => useArtifactContent('/proj', 'a3'));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  });

  // The back door: the watcher re-requests text on EVERY on-disk change for
  // EVERY file type. Its `res.content ?? \'\'` would set an IMAGE's content to
  // the empty string, which downstream reads as an ordinary editable text file.
  it('does not call artifacts.get when an image changes on disk', () => {
    render(
      <ActiveArtifactView
        artifact={{ id: 'a1', kind: 'internal', path: 'shot.png' } as any}
        content={null}
        contentInfo={{ binary: true }}
        contentState={{ phase: 'ready' }}
        projectRoot="/proj"
        projectId="p1"
        projectName="Proj"
        sessionId="s1"
        onContentChange={vi.fn()}
      />
    );
    get.mockClear();
    changedCb!({ projectRoot: '/proj', artifactId: 'a1', kind: 'change' });
    expect(get).not.toHaveBeenCalled();
  });
});

// ── Partial-view metadata must survive the trip from response to banner ──
// Caught in Workbench review 2026-08-25: useArtifactContent copied the get()
// response into contentInfo field by field and silently dropped `truncated`,
// so the banner never rendered for ANY over-cap file. Nothing failed; the
// notice was simply absent.
describe('over-cap text reaches the partial-view banner', () => {
  it('carries truncated and sizeBytes from the response into contentInfo', async () => {
    const { result } = renderHook(() => useArtifactContent('/proj', 'a9', 'server.log'));
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0].resolve({
        ok: true, content: 'first chunk\n', orphan: false, binary: false,
        truncated: true, sizeBytes: 8.4 * 1024 * 1024, mtimeMs: 1,
      });
    });
    await waitFor(() => expect(result.current.contentInfo?.truncated).toBe(true));
    expect(result.current.contentInfo?.sizeBytes).toBe(8.4 * 1024 * 1024);
  });

  it('renders the banner end to end, stating the real size not the prefix size', async () => {
    const utils = render(<Host artifact={{ id: 'a9', kind: 'internal', path: 'logs/server.log' } as any} />);
    await settle(() => pending[0].resolve({
      ok: true, content: 'first chunk\n', orphan: false, binary: false,
      truncated: true, sizeBytes: 8.4 * 1024 * 1024, mtimeMs: 1,
    }));
    expect(utils.getByText(/Showing 3\.0\/8\.4 MB/)).toBeTruthy();
  });

  // A complete file must NOT wear the notice.
  it('shows no banner for a file served whole', async () => {
    const utils = render(<Host artifact={{ id: 'a10', kind: 'internal', path: 'logs/small.log' } as any} />);
    await settle(() => pending[0].resolve({
      ok: true, content: 'all of it\n', orphan: false, binary: false,
      truncated: false, sizeBytes: 10, mtimeMs: 1,
    }));
    expect(utils.queryByText(/Large File/)).toBeNull();
  });
});
