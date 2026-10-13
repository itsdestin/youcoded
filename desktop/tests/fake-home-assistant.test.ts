// The pretend Home Assistant must answer like the real one where the page can tell the difference
// (2026-10-05 tooling review F3, F6, F7, F13, F14).
import { describe, it, expect, afterEach } from 'vitest';
import { fakeHomeAssistantFetch, fakeHomeAssistantLive, fakeHomeAssistantReset } from '../src/renderer/dev/workbench/fixtures/fake-home-assistant';
import { ROOMS_TEMPLATE } from '../src/renderer/dev/workbench/fixtures/home-assistant-page-templates';

const get = (path: string, body?: string) => fakeHomeAssistantFetch({ url: `http://h.local:8123${path}`, method: body ? 'POST' : 'GET', body } as never) as { ok: true; status: number; body: string };
const rooms = () => JSON.parse(get('/api/template', JSON.stringify({ template: ROOMS_TEMPLATE })).body) as Array<{ items: Array<{ id: string; state: string; brightness: number | null }> }>;
const light = (id: string) => rooms().flatMap((r) => r.items).find((i) => i.id === id)!;
const call = (service: string, data: Record<string, unknown>) => get(`/api/services/light/${service}`, JSON.stringify(data));
const ask = (s: ReturnType<typeof fakeHomeAssistantLive>, m: Record<string, unknown>) => JSON.parse(s.message(JSON.stringify(m))[0]);

afterEach(() => fakeHomeAssistantReset());

describe('the pretend house matches the real one', () => {
  it('brightness 0 turns a light off, and turning it on again brings its brightness back (F6)', () => {
    const id = 'light.living_room_lamp';
    const was = light(id).brightness;
    call('turn_on', { entity_id: id, brightness_pct: 0 });
    expect(light(id).state).toBe('off');
    call('turn_on', { entity_id: id });
    expect(light(id).state).toBe('on');
    expect(light(id).brightness).toBe(was);
  });

  it('a room made or renamed in one test is gone after the reset (F3)', () => {
    const s = fakeHomeAssistantLive();
    ask(s, { id: 1, type: 'config/area_registry/create', name: 'Workshop' });
    ask(s, { id: 2, type: 'config/area_registry/update', area_id: 'kitchen', name: 'Galley' });
    fakeHomeAssistantReset();
    const names = ask(s, { id: 3, type: 'config/area_registry/list' }).result.map((a: { name: string }) => a.name);
    expect(names).not.toContain('Workshop');
    expect(names).not.toContain('Galley');
    expect(ask(s, { id: 4, type: 'config/area_registry/create', name: 'Workshop' }).result.area_id).toBe('workshop');
  });

  it('a made room can be deleted, as the page does to roll back (F7)', () => {
    const s = fakeHomeAssistantLive();
    const made = ask(s, { id: 1, type: 'config/area_registry/create', name: 'Shed' }).result;
    expect(ask(s, { id: 2, type: 'config/area_registry/delete', area_id: made.area_id }).success).toBe(true);
    expect(ask(s, { id: 3, type: 'config/area_registry/list' }).result.some((a: { area_id: string }) => a.area_id === made.area_id)).toBe(false);
    expect(ask(s, { id: 4, type: 'config/area_registry/delete', area_id: made.area_id }).success).toBe(false);
  });

  it('history is empty when nothing changed (F13)', () => {
    const r = get('/api/history/period/2026-10-01T00:00:00Z?filter_entity_id=event.nothing_here');
    expect(JSON.parse(r.body)).toEqual([]);
  });

  it('an unknown template is refused, not answered with the rooms (F14)', () => {
    const r = get('/api/template', JSON.stringify({ template: '{{ states | count }}' }));
    expect(r.status).toBe(400);
  });
});
