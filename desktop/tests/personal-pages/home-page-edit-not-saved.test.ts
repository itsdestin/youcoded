// @vitest-environment jsdom
// Code review F6: Edit mode is never saved, so a page left in Edit does not reopen as slim rows. A stale "editing: true"
// from an earlier build opens Edit once and is cleared.
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, q, frame, tick } from './home-page-harness';

afterEach(() => { unmount(); vi.useRealTimers(); });

it('pressing Edit writes nothing about editing', async () => {
  const m = await mount();
  const before = m.saves.length;
  q('[data-act="edit"]').click(); await frame();
  expect(q('#root').classList.contains('editing')).toBe(true);
  expect(m.saves.slice(before).some((s) => 'editing' in (s as object) && (s as { editing: boolean }).editing === true)).toBe(false);
});

it('clears a stale saved editing flag after opening in Edit once', async () => {
  const m = await mount({ data: { startOpen: ['living_room'], editing: true } });
  expect(q('#root').classList.contains('editing')).toBe(true);
  await tick(50);
  expect((m.saves.at(-1) as { editing: boolean }).editing).toBe(false);
});
