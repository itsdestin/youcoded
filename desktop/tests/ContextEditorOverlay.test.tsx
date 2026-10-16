// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
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
