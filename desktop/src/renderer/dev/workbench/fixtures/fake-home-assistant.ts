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
  modesHvac?: string[]; action?: string | null;
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
      // A Google TV paired for remote control: its Cast tile, and the remote.
      { id: 'media_player.destins_room_google_tv', name: "Destin's Room TV", state: 'playing', features: 4, vol: 0.4, title: 'YouTube' },
      { id: 'remote.destins_room_tv_remote', name: "Destin's Room TV remote", state: 'on' },
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
      { id: 'climate.thermostat', name: 'Thermostat', state: 'cool', cur: 74, target: 72, min: 50, max: 90, step: 1, modesHvac: ['off', 'cool', 'heat', 'heat_cool'], action: 'cooling' },
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
  // Rooms with nothing in them are left out, as the real template does; each
  // item carries the id of the device it belongs to (`device_id(e)`), which
  // a room move needs (fakeHomeAssistantSocket).
  if (url.pathname === '/api/template') {
    return ok(JSON.stringify(ROOMS.filter((r) => r.items.length).map((r) => ({ ...r, items: r.items.map((t) => ({ ...t, device: deviceOf(t.id) })) }))));
  }
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
      if (action === 'set_hvac_mode' && typeof data.hvac_mode === 'string') {
        t.state = data.hvac_mode;
        t.action = data.hvac_mode === 'off' ? 'off' : data.hvac_mode === 'heat' ? 'heating' : data.hvac_mode === 'cool' ? 'cooling' : 'idle';
      }
      if (action === 'volume_set' && typeof data.volume_level === 'number') t.vol = data.volume_level;
      if (action === 'set_temperature' && typeof data.temperature === 'number') t.target = data.temperature;
    }
    return ok('[]');
  }
  return null;
}

// ── The socket: renames and room moves (home-page-v2 deck, Q-where) ──────
// Home Assistant changes names and rooms only over its websocket. The real
// app opens it, sends the connection's greeting with the key, then the
// page's messages; this answers the same messages the same way, so the page
// can be operated end to end with no house. Areas are kept apart from ROOMS
// so a room created empty still exists before anything is moved into it.

const AREAS = ROOMS.map((r) => ({ area_id: r.id, name: r.name }));

/** The pretend device behind an entity: one device per entity, which is
 *  how most single-light bulbs and speakers appear in Home Assistant. */
function deviceOf(entityId: string): string {
  return `dev_${entityId.replace(/[^a-z0-9]/g, '_')}`;
}

function moveTo(entityId: string, areaId: string): boolean {
  const area = AREAS.find((a) => a.area_id === areaId);
  if (!area) return false;
  let thing: Thing | undefined;
  for (const r of ROOMS) {
    const i = r.items.findIndex((t) => t.id === entityId);
    if (i >= 0) [thing] = r.items.splice(i, 1);
  }
  if (!thing) return false;
  let room = ROOMS.find((r) => r.id === areaId);
  if (!room) { room = { id: areaId, name: area.name, items: [] }; ROOMS.push(room); }
  room.items.push(thing);
  return true;
}

function reply(id: unknown, result: unknown, error?: string): string {
  return JSON.stringify(error
    ? { id, type: 'result', success: false, error: { code: 'not_found', message: error } }
    : { id, type: 'result', success: true, result });
}

function answerOne(raw: string): string | null {
  let m: Record<string, unknown>;
  try { m = JSON.parse(raw); } catch { return null; }
  const { id, type } = m;
  switch (type) {
    case 'config/area_registry/list': return reply(id, AREAS);
    case 'config/area_registry/create': {
      const name = String(m.name ?? '').trim();
      if (!name) return reply(id, null, 'A room needs a name.');
      let areaId = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      while (AREAS.some((a) => a.area_id === areaId)) areaId += '_2';
      const area = { area_id: areaId, name };
      AREAS.push(area);
      return reply(id, area);
    }
    case 'config/area_registry/update': {
      const area = AREAS.find((a) => a.area_id === m.area_id);
      if (!area) return reply(id, null, 'No such room.');
      if (typeof m.name === 'string' && m.name.trim()) {
        area.name = m.name.trim();
        const room = ROOMS.find((r) => r.id === area.area_id);
        if (room) room.name = area.name;
      }
      return reply(id, area);
    }
    case 'config/entity_registry/update': {
      const t = find(String(m.entity_id ?? ''));
      if (!t) return reply(id, null, 'No such device.');
      // `name: null` puts the device's own name back, as in Home Assistant.
      if (typeof m.name === 'string' && m.name.trim()) t.name = m.name.trim();
      if (typeof m.area_id === 'string' && !moveTo(t.id, m.area_id)) return reply(id, null, 'No such room.');
      return reply(id, { entity_entry: { entity_id: t.id, name: t.name } });
    }
    case 'config/device_registry/update': {
      const entity = ROOMS.flatMap((r) => r.items).find((t) => deviceOf(t.id) === m.device_id);
      if (!entity) return reply(id, null, 'No such device.');
      if (typeof m.area_id === 'string' && !moveTo(entity.id, m.area_id)) return reply(id, null, 'No such room.');
      return reply(id, { id: m.device_id, area_id: m.area_id });
    }
    default: return reply(id, null, `Unknown command ${String(type)}.`);
  }
}

/** Answers a socket exchange with the pretend Home Assistant: the greeting
 *  pair first (`auth_required`, then `auth_ok` — the real app sends the key),
 *  then one answer per message the page sent, cut at `until` like the app. */
export function fakeHomeAssistantSocket(req: PageFetchRequest): PageFetchResult | null {
  let url: URL;
  try { url = new URL(req.url); } catch { return null; }
  if (url.pathname !== '/api/websocket' || !req.socket) return null;
  const frames = [JSON.stringify({ type: 'auth_required', ha_version: '2026.9.0' }), JSON.stringify({ type: 'auth_ok', ha_version: '2026.9.0' })];
  for (const m of req.socket.send) {
    const a = answerOne(m);
    if (a) frames.push(a);
  }
  return { ok: true, status: 101, headers: {}, body: JSON.stringify(frames.slice(0, req.socket.until)) };
}
