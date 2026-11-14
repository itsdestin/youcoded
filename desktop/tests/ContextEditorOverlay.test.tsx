// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ContextFile } from '../src/shared/project-context-types';
import { ContextEditorOverlay } from '../src/renderer/components/project-view/ContextEditorOverlay';

const file: ContextFile = {
  id: 'project:/tmp/CLAUDE.md', scope: 'project', kind: 'claude-md',
  label: 'CLAUDE.md', absolutePath: '/tmp/CLAUDE.md', timing: 'always',
  editable: true, blastRadius: 'project', size: '4.1 KB',
};
afterEach(cleanup);

// WHY: project-only metadata may disappear visually, but global edit scope
// still needs its stronger warning and existing metadata treatment.
it('omits the project-file metadata row but retains its plain edit explanation', () => {
  (window as any).claude = { project: { readContextFile: vi.fn().mockResolvedValue({ ok: true, content: '# Instructions' }) } };
  render(<ContextEditorOverlay project={{ path: '/tmp' }} file={file} onClose={() => {}} />);
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('Project instructions.');
  expect(dialog.textContent).not.toContain('4.1 KB');
  const explanation = screen.getByText(/Editing this changes how Claude behaves/).closest('div')!;
  expect(explanation.className).not.toContain('bg-inset');
});
it('keeps the global-file metadata and warning untouched', () => {
  (window as any).claude = { project: { readContextFile: vi.fn().mockResolvedValue({ ok: true, content: '# Instructions' }) } };
  render(<ContextEditorOverlay project={{ path: '/tmp' }} file={{ ...file, id: 'global:/tmp/CLAUDE.md', scope: 'global', blastRadius: 'global' }} onClose={() => {}} />);
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('4.1 KB');
  expect(dialog.textContent).toContain('Global file — affects every project.');
});

// Card #134 round 4: Copy path says "Couldn't copy the path." when the copy fails, and stays quiet (ticks "Copied") when it works.
import { fireEvent, act } from '@testing-library/react';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';
describe('ContextEditorOverlay — Copy path', () => {
  const clip = (writeText: () => Promise<void>, legacy: boolean) => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    (document as any).execCommand = vi.fn(() => legacy);
  };
  let got: string[]; const on = (e: Event) => got.push((e as CustomEvent).detail.message);
  beforeEach(() => { got = []; window.addEventListener(APP_NOTICE_EVENT, on); vi.spyOn(console, 'warn').mockImplementation(() => {}); (window as any).claude = { project: { readContextFile: vi.fn().mockResolvedValue({ ok: true, content: '# x' }) } }; });
  afterEach(() => { window.removeEventListener(APP_NOTICE_EVENT, on); delete (navigator as any).clipboard; delete (document as any).execCommand; vi.restoreAllMocks(); });
  const press = () => act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy path/ })); });

  it('says so when neither way of copying works', async () => {
    clip(() => Promise.reject(new Error('denied')), false);
    render(<ContextEditorOverlay project={{ path: '/tmp' }} file={file} onClose={() => {}} />);
    await press();
    await vi.waitFor(() => expect(got).toEqual(["Couldn't copy the path."]));
  });
  it('a copy that works ticks "Copied" and says nothing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clip(writeText, false);
    render(<ContextEditorOverlay project={{ path: '/tmp' }} file={file} onClose={() => {}} />);
    await press();
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith('/tmp/CLAUDE.md');
    expect(got).toEqual([]);
  });
});
