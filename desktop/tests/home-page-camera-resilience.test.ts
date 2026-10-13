// @vitest-environment jsdom
// Code review F7 / F8 / F9: a thumbnail that failed once is asked for again later; a Nest camera already known to
// have no still picture is not asked for one every 10 seconds; a one-off failure to load events keeps the last good list.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeHomeAssistantCameraEvents, fakeHomeAssistantNestSignedIn } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import { mount, unmount, q, tick } from './home-page-harness';

const OPEN = { startOpen: ['living_room'] };
const LIVING = 'camera.living_room_camera';
const card = () => q(`[data-eid="${LIVING}"]`);
beforeEach(() => { fakeHomeAssistantNestSignedIn(true); fakeHomeAssistantCameraEvents(true); });
afterEach(() => { unmount(); vi.useRealTimers(); fakeHomeAssistantNestSignedIn(false); });
const fail = { ok: false, status: 500, headers: {}, body: '' };

describe('camera card resilience', () => {
  it('F7: asks again for a thumbnail that failed once', async () => {
    let failThumbs = true; const asked: string[] = [];
    await mount({ data: OPEN, video: true, fetchHook: (req) => { if (req.url.includes('/thumbnail')) { asked.push(req.url); if (failThumbs) return fail; } return undefined; } });
    await tick(1000);
    expect(card().querySelectorAll('img[data-thumb][src]').length).toBe(0);
    failThumbs = false;
    await tick(95_000); // the next refresh of the list
    expect(card().querySelectorAll('img[data-thumb][src]').length).toBeGreaterThan(0);
  });

  it('F8: stops asking a Nest camera for a still picture every 10 seconds', async () => {
    const proxy: number[] = [];
    await mount({ data: OPEN, video: true, fetchHook: (req) => { if (req.url.includes(`/camera_proxy/${LIVING}`)) proxy.push(Date.now()); return undefined; } });
    await tick(65_000);
    expect(proxy.length).toBeLessThanOrEqual(2);
  });

  it('F9: keeps the last good events when one refresh fails', async () => {
    let failing = false;
    await mount({ data: OPEN, video: true, fetchHook: (req) => {
      const sent = (req as unknown as { socket?: { send: string[] } }).socket?.send ?? [];
      if (failing && (sent.some((s) => s.includes('browse_media')) || req.url.includes('/api/history/period'))) throw new Error('blip');
      return undefined;
    } });
    await tick(1000);
    const before = card().querySelectorAll('.cam-ev').length;
    expect(before).toBeGreaterThan(5);
    failing = true;
    await tick(70_000);
    expect(card().textContent).not.toContain('Could not load recent events');
    expect(card().querySelectorAll('.cam-ev').length).toBe(before);
  });
});
