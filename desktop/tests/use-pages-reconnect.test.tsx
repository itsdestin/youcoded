// @vitest-environment jsdom
// The pinned-page list refreshes itself after a remote reconnect (sync-fix3): `pages:changed` is a one-shot push a sleeping phone misses.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { REMOTE_RECONNECTED_EVENT } from '../src/renderer/remote-events';

const page = (id: string, pinned: boolean) => ({ id, name: id, pinned }) as any;
// The store listens on window for the page's whole life (that is the point); a test must take its listener off or the next test's event reaches it too.
const added: Array<[string, EventListener]> = [];
const realAdd = window.addEventListener.bind(window);
vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, fn: EventListener, o?: any) => { if (type === REMOTE_RECONNECTED_EVENT) added.push([type, fn]); realAdd(type, fn, o); }) as any);
afterEach(() => { added.splice(0).forEach(([t, f]) => window.removeEventListener(t, f)); vi.resetModules(); delete (window as any).claude; });

async function setup(list: ReturnType<typeof vi.fn>) {
  vi.resetModules();   // the store is module-level and starts once
  (window as any).claude = { pages: { list, onChanged: () => () => {} } };
  const { usePages } = await import('../src/renderer/components/pages/use-pages');
  return renderHook(() => usePages());
}

it('asks the computer for the list again when the connection comes back', async () => {
  const list = vi.fn().mockResolvedValueOnce([page('a', false)]).mockResolvedValueOnce([page('a', true)]);
  const hook = await setup(list);
  await waitFor(() => expect(hook.result.current.pages).toEqual([page('a', false)]));
  await act(async () => { window.dispatchEvent(new Event(REMOTE_RECONNECTED_EVENT)); });
  await waitFor(() => expect(hook.result.current.pages).toEqual([page('a', true)]));
  expect(list).toHaveBeenCalledTimes(2);
});

it('keeps the list on screen when the refresh itself fails (no error banner over a good list)', async () => {
  const list = vi.fn().mockResolvedValueOnce([page('a', true)]).mockRejectedValueOnce(new Error('down'));
  const hook = await setup(list);
  await waitFor(() => expect(hook.result.current.loaded).toBe(true));
  await act(async () => { window.dispatchEvent(new Event(REMOTE_RECONNECTED_EVENT)); });
  expect(list).toHaveBeenCalledTimes(2);
  expect(hook.result.current).toMatchObject({ pages: [page('a', true)], failed: false });
});
