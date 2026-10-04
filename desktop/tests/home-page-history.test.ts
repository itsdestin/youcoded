// @vitest-environment jsdom
// The Home page's history (round 5 design deck: a device's pop-up, and the
// Activity tab): what Home Assistant's logbook says, in words, with who did
// it only as far as Home Assistant knows. Runs the real page against the
// workbench's pretend Home Assistant.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { HOME_ASSISTANT_PAGE_HTML } from '../src/renderer/dev/workbench/fixtures/home-assistant-page';
import { fakeHomeAssistantFetch, fakeHomeAssistantSocket } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import type { PageFetchRequest } from '../src/shared/pages-types';

const text = (sel: string) => Array.from(document.querySelectorAll(sel)).map((e) => e.textContent ?? '');

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const html = HOME_ASSISTANT_PAGE_HTML;
  document.head.innerHTML = /<head>([\s\S]*?)<\/head>/.exec(html)![1];
  document.body.innerHTML = /<body>([\s\S]*?)<script>/.exec(html)![1];
  (window as unknown as { youcoded: unknown }).youcoded = {
    devices: { ha: 'http://100.99.234.114:8123' }, data: {},
    save: () => undefined, onRefresh: () => undefined, onData: () => undefined,
    fetch: async (url: string, opts: Omit<PageFetchRequest, 'url'> = {}) => {
      const req = { url, ...opts } as PageFetchRequest;
      return fakeHomeAssistantSocket(req) ?? fakeHomeAssistantFetch(req) ?? { ok: false, status: 404, headers: {}, body: '' };
    },
  };
  new Function(/<script>([\s\S]*?)<\/script>/.exec(html)![1])();
  await vi.waitFor(() => expect(document.querySelector('[data-view="activity"]')).toBeTruthy());
});
afterAll(() => { vi.useRealTimers(); });

describe('the Activity tab', () => {
  it('lists the page devices’ changes in words, saying who did it as far as Home Assistant knows', async () => {
    document.querySelector<HTMLButtonElement>('[data-view="activity"]')!.click();
    await vi.waitFor(() => expect(document.querySelectorAll('.ev').length).toBeGreaterThan(3));
    const rows = text('.ev');
    expect(rows.some((r) => r.includes('Thermostat set to Cool') && r.includes('by Destin'))).toBe(true);
    expect(rows.some((r) => r.includes('Overhead light turned off') && r.includes('by Lights out at 8'))).toBe(true);
    // No source in the logbook: the page says so instead of naming a switch or app.
    expect(rows.some((r) => r.includes('Overhead light turned on') && r.includes('on the device or another app'))).toBe(true);
    // A TV's remote is told as the TV, and a repeat of the same state is dropped.
    expect(rows.some((r) => r.includes('TV remote'))).toBe(false);
    expect(rows.filter((r) => r.includes("Destin's Room TV started playing")).length).toBe(1);
  });

  it('filters by room and by kind, and the same chip again shows everything', () => {
    document.querySelector<HTMLButtonElement>('[data-act-kind="climate"]')!.click();
    expect(text('.ev').every((r) => r.includes('Thermostat'))).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-act-kind="climate"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-act-room="living_room"]')!.click();
    const rows = text('.ev');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.includes('Living Room'))).toBe(true);
  });
});

describe('a device’s pop-up', () => {
  it('opens from a name in the Activity list, with its history and details, and Escape closes it', async () => {
    document.querySelector<HTMLButtonElement>('[data-dev="light.living_room_lamp"]')!.click();
    expect(document.querySelector('.dlg h2')!.textContent).toBe('Floor lamp');
    await vi.waitFor(() => expect(document.querySelectorAll('.dlg .hrow').length).toBeGreaterThan(1));
    expect(document.querySelector('.dlg .about')!.textContent).toContain('Hue go (LLC020)');
    expect(document.querySelector('.dlg .about')!.textContent).toContain('Philips Hue');
    // Its controls are the same card the room shows.
    expect(document.querySelector('.dlg [data-toggle="light.living_room_lamp"]')).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.dlg')).toBeNull();
  });
});
