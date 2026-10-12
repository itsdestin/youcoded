// @vitest-environment jsdom
// import-file-dialog.test.tsx
//
// Pins Task 6's Move/Copy dialog for "+ Add file": destination naming, the
// Move/Copy choice (Move hidden on Android), and the once-per-batch collision
// prompt with Keep both as the default (loses nothing). Assertions verbatim
// from the task-6 brief.

// Scaffolding note: the brief's Step 1 draft uses @testing-library/user-event,
// which is not a dependency of this repo (checked node_modules + package-lock —
// absent, not just unhoisted) and no existing test imports it; every other
// renderer test in this repo drives clicks through RTL's own `fireEvent`. Swap
// is scaffolding only — every assertion below is verbatim from the brief.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ImportFileDialog } from '../src/renderer/components/project-view/ImportFileDialog';

vi.mock('../src/renderer/platform', () => ({ getPlatform: vi.fn(() => 'electron') }));
import { getPlatform } from '../src/renderer/platform';

const base = {
  sources: ['/home/d/Downloads/budget.xlsx'],
  destDir: '/home/d/proj/docs',
  destLabel: 'docs/',
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe('ImportFileDialog', () => {
  // RTL doesn't auto-unmount between tests within one file; without this, each
  // render() piles onto the previous test's DOM and role/text queries see
  // duplicates.
  afterEach(cleanup);

  it('names the destination folder so the target is never a guess', () => {
    render(<ImportFileDialog {...base} />);
    expect(screen.getByText(/docs\//)).toBeTruthy();
  });

  it('offers Move and Copy on desktop', () => {
    render(<ImportFileDialog {...base} />);
    expect(screen.getByRole('button', { name: /^Move$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Copy$/ })).toBeTruthy();
  });

  it('hides Move on Android, where the picker already copied the file', () => {
    // Android's picker copies the selection into ~/attachments/ before the
    // renderer ever sees a path, so the "source" is a temp copy. Moving it would
    // delete the temp and leave the user's original untouched — a lie.
    // Defensive today: every artifacts:* channel is not-implemented-on-mobile
    // (mobile Project View is v2), so this tab has no data on Android at all.
    // The gate exists so the wrong affordance is not waiting when v2 lands.
    vi.mocked(getPlatform).mockReturnValue('android');
    render(<ImportFileDialog {...base} />);
    expect(screen.queryByRole('button', { name: /^Move$/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Copy$/ })).toBeTruthy();
    vi.mocked(getPlatform).mockReturnValue('electron');
  });

  it('confirms with the chosen mode', async () => {
    const onConfirm = vi.fn();
    render(<ImportFileDialog {...base} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: /^Copy$/ }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ mode: 'copy' }));
  });

  it('NAMES the colliding files, not just a count', () => {
    // Replace is one choice applied to the whole batch. A bare "2 files already
    // exist" asks the user to approve overwriting files they cannot see — and
    // main now refuses to replace anything absent from this list, so what is
    // shown here is exactly what can be overwritten.
    render(
      <ImportFileDialog
        {...base}
        sources={['/a/notes.md', '/a/todo.md']}
        collisions={['notes.md', 'todo.md']}
      />,
    );
    expect(screen.getByText('notes.md')).toBeTruthy();
    expect(screen.getByText('todo.md')).toBeTruthy();
  });

  it('caps the named list so a huge batch cannot push the buttons off screen', () => {
    const many = Array.from({ length: 12 }, (_, i) => `f${i}.md`);
    render(<ImportFileDialog {...base} sources={many.map((n) => `/a/${n}`)} collisions={many} />);
    expect(screen.getByText('f0.md')).toBeTruthy();
    expect(screen.getByText(/and 4 more/)).toBeTruthy();
    expect(screen.queryByText('f11.md')).toBeNull();
    // The choice itself must still be reachable.
    expect(screen.getByRole('button', { name: /Replace/i })).toBeTruthy();
  });

  it('asks about collisions once for a batch, with apply-to-all', async () => {
    const onConfirm = vi.fn();
    render(
      <ImportFileDialog
        {...base}
        sources={['/a/notes.md', '/a/todo.md']}
        collisions={['notes.md', 'todo.md']}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText(/2 files already exist/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Keep both/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Copy$/ }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'copy', onCollision: 'keep-both' }),
    );
  });
});
