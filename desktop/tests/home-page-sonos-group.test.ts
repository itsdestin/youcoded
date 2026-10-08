// @vitest-environment jsdom
// The Home page's Sonos grouping (home-page-v3 Q-sonos "tick-list", built
// 2026-10-04): a speaker's Group bar opens a tick list of the other speakers
// that can play in a group; ticking one joins it, unticking takes it out, and
// a speaker that is asleep is listed but cannot be ticked. The page runs here
// against the workbench's pretend Home Assistant, the way the test app runs it.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { HOME_ASSISTANT_PAGE_HTML } from '../src/renderer/dev/workbench/fixtures/home-assistant-page';
import { fakeHomeAssistantFetch, fakeHomeAssistantSocket } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import type { PageFetchRequest } from '../src/shared/pages-types';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const $$ = (sel: string) => Array.from(document.querySelectorAll<HTMLButtonElement>(sel));
const groupBar = (id: string) => document.querySelector<HTMLButtonElement>(`[data-group="${id}"]`)!;
const item = (member: string) => document.querySelector<HTMLButtonElement>(`[data-join="media_player.destins_room"][data-member="${member}"]`);

beforeAll(async () => {
  // The page's own 5-second checks are faked out; each service call asks
  // again 400 ms later, which is what the tests wait on.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const html = HOME_ASSISTANT_PAGE_HTML;
  document.head.innerHTML = /<head>([\s\S]*?)<\/head>/.exec(html)![1];
  const body = /<body>([\s\S]*?)<script>/.exec(html)![1];
  document.body.innerHTML = body;
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  (window as unknown as { youcoded: unknown }).youcoded = {
    devices: { ha: 'http://100.99.234.114:8123' },
    data: {},
    save: () => undefined,
    onRefresh: () => undefined,
    onData: () => undefined,
    fetch: async (url: string, opts: Omit<PageFetchRequest, 'url'> = {}) => {
      const req = { url, ...opts } as PageFetchRequest;
      if (url.includes('/api/services/')) calls.push({ path: new URL(url).pathname, body: JSON.parse(String(opts.body ?? '{}')) });
      return fakeHomeAssistantSocket(req) ?? fakeHomeAssistantFetch(req) ?? { ok: false, status: 404, headers: {}, body: '' };
    },
  };
  new Function(script)();
  await vi.waitFor(() => expect(document.querySelector('[data-group]')).toBeTruthy());
});
afterAll(() => { vi.useRealTimers(); });

describe('Sonos grouping on the Home page', () => {
  it('gives a groupable speaker a Group bar, closed until pressed', () => {
    const bar = groupBar('media_player.destins_room');
    expect(bar).toBeTruthy();
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    expect(item('media_player.roam_2')).toBeNull();
  });

  it('lists the other speakers, with an asleep one shown but not tickable', async () => {
    groupBar('media_player.destins_room').click();
    expect(item('media_player.roam_2')!.disabled).toBe(false);
    expect(item('media_player.roam_2')!.getAttribute('aria-pressed')).toBe('false');
    expect(item('media_player.move_2')!.disabled).toBe(true);
    expect(item('media_player.move_2')!.textContent).toContain('Asleep');
    // A TV or Google speaker cannot join a Sonos group, so it is not offered.
    expect(item('media_player.living_room_speaker')).toBeNull();
  });

  it('ticking a speaker joins it to the group and says so on both cards', async () => {
    item('media_player.roam_2')!.click();
    expect(item('media_player.roam_2')!.getAttribute('aria-pressed')).toBe('true');
    expect(calls.at(-1)).toEqual({ path: '/api/services/media_player/join', body: { entity_id: 'media_player.destins_room', group_members: ['media_player.roam_2'] } });
    // After Home Assistant's next answer, the tick and both labels hold.
    await vi.waitFor(() => expect(groupBar('media_player.roam_2').textContent).toContain("Playing with Destin's Room"));
    expect(item('media_player.roam_2')!.getAttribute('aria-pressed')).toBe('true');
    expect(groupBar('media_player.destins_room').textContent).toContain('Playing with Roam 2');
    expect(groupBar('media_player.roam_2').textContent).toContain("Playing with Destin's Room");
  });

  it('unticking takes it back out', async () => {
    item('media_player.roam_2')!.click();
    expect(calls.at(-1)).toEqual({ path: '/api/services/media_player/unjoin', body: { entity_id: 'media_player.roam_2' } });
    await vi.waitFor(() => expect(groupBar('media_player.roam_2').textContent).not.toContain('Playing with'));
    expect(item('media_player.roam_2')!.getAttribute('aria-pressed')).toBe('false');
    expect(groupBar('media_player.destins_room').textContent).toContain('Group');
    expect(groupBar('media_player.destins_room').textContent).not.toContain('Playing with');
    expect($$('[data-group]').length).toBe(2);
  });
});
