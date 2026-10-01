// A pretend Home Assistant for the workbench, so the Home page can be seen and
// operated with no network and no real house (home-device deck, 2026-10-01).
// It answers only the three things the page asks: the rooms template, service
// calls, and camera snapshots. State lives for the tab, so a switch pressed
// stays pressed and the page's 5-second check agrees with it.
import type { PageFetchRequest, PageFetchResult } from '../../../../shared/pages-types';

interface Thing {
  id: string; name: string; state: string;
  brightness?: number | null; modes?: string[] | null;
  cur?: number | null; target?: number | null; min?: number; max?: number; step?: number;
  vol?: number | null; title?: string | null; features?: number;
  rgb?: number[] | null; k?: number | null;
}

function seed(): Array<{ id: string; name: string; items: Thing[] }> {
  const dim = ['brightness'];
  return [
    { id: 'destins_room', name: "Destin's Room", items: [
      { id: 'light.overhead_light', name: 'Overhead light', state: 'on', brightness: 255, modes: ['color_temp'], k: 3000 },
      { id: 'light.desk_backlight', name: 'Desk backlight', state: 'on', brightness: 102, modes: ['color_temp', 'xy'], rgb: [50, 110, 255] },
      { id: 'light.hue_play_1', name: 'Hue Play 1', state: 'on', brightness: 200, modes: ['color_temp', 'xy'], rgb: [150, 80, 255] },
      { id: 'light.tv_backlight', name: 'TV backlight', state: 'unavailable', modes: dim },
      { id: 'media_player.destins_room_tv', name: "Destin's Samsung TV", state: 'off', features: 4, vol: 0.2 },
      { id: 'media_player.destins_room', name: "Destin's Room speaker", state: 'playing', features: 4, vol: 0.35, title: 'Weightless — Marconi Union' },
    ] },
    { id: 'living_room', name: 'Living Room', items: [
      { id: 'light.living_room_lamp', name: 'Floor lamp', state: 'on', brightness: 180, modes: ['color_temp'], k: 2700 },
      { id: 'light.living_room_ceiling', name: 'Ceiling', state: 'off', brightness: null, modes: dim },
      { id: 'camera.living_room_camera', name: 'Living room camera', state: 'idle' },
    ] },
    { id: 'kitchen', name: 'Kitchen', items: [
      { id: 'light.kitchen_pendants', name: 'Pendants', state: 'off', brightness: null, modes: dim },
      { id: 'light.under_cabinet', name: 'Under cabinet', state: 'on', brightness: 255, modes: ['onoff'] },
    ] },
    { id: 'upstairs', name: 'Upstairs', items: [
      { id: 'climate.thermostat', name: 'Thermostat', state: 'cool', cur: 74, target: 72, min: 50, max: 90, step: 1 },
    ] },
    { id: 'front_door', name: 'Front door', items: [
      { id: 'camera.doorbell', name: 'Doorbell', state: 'unavailable' },
    ] },
  ];
}

const ROOMS = seed();

function find(id: string): Thing | undefined {
  for (const r of ROOMS) for (const t of r.items) if (t.id === id) return t;
  return undefined;
}

/** A drawn "snapshot": a dim room with a timestamp, so a refresh is visible. */
function snapshot(name: string): string {
  const time = new Date().toLocaleTimeString();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b3340"/><stop offset="1" stop-color="#151a22"/></linearGradient></defs>
<rect width="640" height="360" fill="url(#g)"/><rect x="60" y="150" width="220" height="120" rx="8" fill="#39424f"/>
<rect x="380" y="70" width="170" height="110" rx="4" fill="#48607a" opacity=".7"/><rect x="0" y="290" width="640" height="70" fill="#1d232c"/>
<text x="16" y="28" fill="#e6e6e6" font-family="monospace" font-size="16">${name.replace(/[<&]/g, '')}</text>
<text x="624" y="344" fill="#e6e6e6" font-family="monospace" font-size="14" text-anchor="end">${time}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const ok = (body: string): PageFetchResult => ({ ok: true, status: 200, headers: { 'content-type': 'application/json' }, body });

/** Answers a request to the pretend Home Assistant, or null when the request
 *  is not for it (the workbench's usual "no network" answer then applies). */
export function fakeHomeAssistantFetch(req: PageFetchRequest): PageFetchResult | null {
  let url: URL;
  try { url = new URL(req.url); } catch { return null; }
  if (!url.pathname.startsWith('/api/')) return null;
  if (url.pathname === '/api/template') return ok(JSON.stringify(ROOMS));
  const cam = /^\/api\/camera_proxy\/(.+)$/.exec(url.pathname);
  if (cam) {
    const t = find(cam[1]);
    return { ok: true, status: 200, headers: { 'content-type': 'image/svg+xml' }, body: snapshot(t?.name ?? cam[1]) };
  }
  const svc = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(url.pathname);
  if (svc) {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(req.body ?? '{}'); } catch { /* empty body */ }
    const ids = ([] as unknown[]).concat(data.entity_id ?? []).map(String);
    for (const id of ids) {
      const t = find(id);
      if (!t || t.state === 'unavailable') continue;
      const [, action] = svc.slice(1);
      if (action === 'turn_off') t.state = 'off';
      if (action === 'turn_on') {
        t.state = id.startsWith('media_player.') ? 'idle' : 'on';
        if (typeof data.brightness_pct === 'number') t.brightness = Math.round(data.brightness_pct * 2.55);
        else if (id.startsWith('light.') && !t.brightness) t.brightness = 255;
      }
      if (action === 'turn_on' && Array.isArray(data.rgb_color)) { t.rgb = data.rgb_color as number[]; t.k = null; }
      if (action === 'turn_on' && typeof data.color_temp_kelvin === 'number') { t.k = data.color_temp_kelvin; t.rgb = null; }
      if (action === 'volume_set' && typeof data.volume_level === 'number') t.vol = data.volume_level;
      if (action === 'set_temperature' && typeof data.temperature === 'number') t.target = data.temperature;
    }
    return ok('[]');
  }
  return null;
}
