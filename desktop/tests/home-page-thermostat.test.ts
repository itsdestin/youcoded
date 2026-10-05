// @vitest-environment jsdom
// Redesign round 1 (Destin: "the thermostat on the Home page should match the one on the Climate
// page"): a room card and Favourites draw the Climate page's dial, scaled down, with the same
// controls. Pins that Home renders the dial (arc, now-dot, set point) with its minus / plus and
// modes, that they still send, and that the card still opens the device pop-up from its name.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { HOME_ASSISTANT_PAGE_HTML } from '../src/renderer/dev/workbench/fixtures/home-assistant-page';
import { fakeHomeAssistantFetch, fakeHomeAssistantSocket } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import type { PageFetchRequest } from '../src/shared/pages-types';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const card = () => document.querySelector<HTMLElement>('#rooms .th-compact')!;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const html = HOME_ASSISTANT_PAGE_HTML;
  document.head.innerHTML = /<head>([\s\S]*?)<\/head>/.exec(html)![1];
  document.body.innerHTML = /<body>([\s\S]*?)<script>/.exec(html)![1];
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  (window as unknown as { youcoded: unknown }).youcoded = {
    devices: { ha: 'http://100.99.234.114:8123' }, data: {}, save: () => undefined, onRefresh: () => undefined, onData: () => undefined,
    fetch: async (url: string, opts: Omit<PageFetchRequest, 'url'> = {}) => {
      const req = { url, ...opts } as PageFetchRequest;
      if (url.includes('/api/services/')) calls.push({ path: new URL(url).pathname, body: JSON.parse(String(opts.body ?? '{}')) });
      return fakeHomeAssistantSocket(req) ?? fakeHomeAssistantFetch(req) ?? { ok: false, status: 404, headers: {}, body: '' };
    },
  };
  new Function(script)();
  await vi.waitFor(() => expect(document.querySelector('#rooms .th-compact')).toBeTruthy());
});
afterAll(() => { vi.useRealTimers(); });

describe('the thermostat on the Home page', () => {
  it('draws the Climate page dial with its set point, now-dot, steps and modes', () => {
    const c = card();
    expect(c.querySelector('.th-dial svg .th-track')).toBeTruthy();
    expect(c.querySelector('.th-dial svg .th-fill')).toBeTruthy();
    expect(c.querySelector('.th-dial svg .th-now')).toBeTruthy();
    expect(c.querySelector('.th-set')!.textContent).toMatch(/^\d+°$/);
    expect(c.querySelector('[aria-label="Cooler"]')).toBeTruthy();
    expect(c.querySelector('[aria-label="Warmer"]')).toBeTruthy();
    expect(c.querySelectorAll('.th-mode').length).toBeGreaterThan(1);
    // The old small card is gone from Home.
    expect(document.querySelector('#rooms .clim-top')).toBeNull();
  });

  it('keeps the card key and the name that opens the pop-up', () => {
    expect(card().getAttribute('data-eid')).toBe('climate.thermostat');
    expect(card().querySelector('.line > .name')!.textContent).toBe('Thermostat');
  });

  it('still sends a warmer step and a mode change', async () => {
    const before = calls.length;
    card().querySelector<HTMLButtonElement>('[aria-label="Warmer"]')!.click();
    await vi.waitFor(() => expect(calls.slice(before).some((x) => x.path.includes('set_temperature'))).toBe(true));
    const mode = Array.from(card().querySelectorAll<HTMLButtonElement>('.th-mode')).find((b) => b.getAttribute('aria-pressed') === 'false')!;
    mode.click();
    await vi.waitFor(() => expect(calls.slice(before).some((x) => x.path.includes('set_hvac_mode'))).toBe(true));
  });
});
