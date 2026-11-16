// @vitest-environment jsdom
// Destin R3-6b: a long notice puts its buttons on their own row, right-aligned; a short one keeps them beside the words.
// jsdom has no layout, so this pins the pure-CSS recipe (flex-wrap + ml-auto) rather than measuring a line count.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Toast } from '../src/renderer/components/ui/Toast';

afterEach(cleanup);
const noop = () => {};
describe('toast layout', () => {
  it('the global toast wraps its buttons beneath the words, right-aligned', () => {
    const { container } = render(<Toast message="a long notice" actions={[{ label: 'Show file', onClick: noop }]} onDismiss={noop} durationMs={null} />);
    const root = container.querySelector('[role="status"]') as HTMLElement;
    expect(root.className).toContain('flex-wrap');
    expect(root.querySelector('button')!.closest('span')!.className).toContain('ml-auto');
  });
  it('a single action node gets the same right-aligned slot', () => {
    const { container } = render(<Toast message="x" action={<button>Undo</button>} onDismiss={noop} durationMs={null} />);
    expect(container.querySelector('button')!.parentElement!.className).toContain('ml-auto');
  });
  it('the anchored toast is unchanged: one nowrap line, no wrapping', () => {
    const { container } = render(<Toast variant="anchored" message="x" actions={[{ label: 'Undo', onClick: noop }]} onDismiss={noop} durationMs={null} />);
    const root = container.querySelector('[role="status"]') as HTMLElement;
    expect(root.className).toContain('whitespace-nowrap');
    expect(root.className).not.toContain('flex-wrap');
  });
});
