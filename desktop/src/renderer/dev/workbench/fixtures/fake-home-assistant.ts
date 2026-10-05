// A pretend Home Assistant for the workbench, so the Home page can be seen and
// operated with no network and no real house (home-device deck, 2026-10-01).
// It answers only the three things the page asks: the rooms template, service
// calls, and camera snapshots. State lives for the tab, so a switch pressed
// stays pressed and the page's 5-second check agrees with it.
import type { PageFetchRequest, PageFetchResult } from '../../../../shared/pages-types';
import { FAKE_NEST_CLIP_BASE64 } from './fake-nest-clip';

interface Thing {
  id: string; name: string; state: string;
  brightness?: number | null; modes?: string[] | null;
  cur?: number | null; target?: number | null; min?: number; max?: number; step?: number;
  vol?: number | null; title?: string | null; features?: number;
  rgb?: number[] | null; k?: number | null;
  modesHvac?: string[]; action?: string | null;
  model?: string; dc?: string; activity?: string; app?: string; source?: string; muted?: boolean;
  maker?: string; entry?: string; since?: string; upd?: string;
  /** Sonos `group_members`: the speakers playing together, leader first. */
  group?: string[];
  sw?: string;
}

/** Home Assistant's "can play in a group" flag on a media player. */
const GROUPING = 524288;

function seed(): Array<{ id: string; name: string; items: Thing[] }> {
  const dim = ['brightness'];
  return [
    { id: 'destins_room', name: "Destin's Room", items: [
      { id: 'light.overhead_light', name: 'Overhead light', state: 'on', brightness: 255, modes: ['color_temp'], k: 3000 },
      { id: 'light.desk_backlight', name: 'Desk backlight', state: 'on', brightness: 102, modes: ['color_temp', 'xy'], rgb: [50, 110, 255] },
      { id: 'light.hue_play_1', name: 'Hue Play 1', state: 'on', brightness: 200, modes: ['color_temp', 'xy'], rgb: [150, 80, 255] },
      { id: 'light.tv_backlight', name: 'TV backlight', state: 'unavailable', modes: dim },
      { id: 'media_player.destins_room_tv', name: "Destin's Samsung TV", state: 'off', features: 4, vol: 0.2, model: 'QN65Q80CAFXZA', dc: 'tv' },
      // Named like the room, as the real Sonos Beam is: it must never get the
      // TV's remote (round 5 testing).
      { id: 'media_player.destins_room', name: "Destin's Room", state: 'playing', vol: 0.35, title: 'TV', model: 'Sonos Beam', source: 'TV', features: 4 | 8 | 1 | 16 | 32 | GROUPING, group: ['media_player.destins_room'] },
      // A Google TV paired for remote control: its Cast tile, and the remote.
      { id: 'media_player.destins_room_google_tv', name: "Destin's Room TV", state: 'playing', features: 4, vol: 0.4, title: 'Lofi beats to relax to', model: 'Google TV Streamer', dc: 'tv' },
      { id: 'remote.destins_room_tv_remote', name: "Destin's Room TV remote", state: 'on', activity: 'com.google.android.youtube.tv' },
    ] },
    { id: 'living_room', name: 'Living Room', items: [
      { id: 'light.living_room_lamp', name: 'Floor lamp', state: 'on', brightness: 180, modes: ['color_temp'], k: 2700, maker: 'Signify Netherlands B.V.', model: 'Hue go (LLC020)', entry: 'entry_hue', sw: '1.108.7' },
      { id: 'light.living_room_ceiling', name: 'Ceiling', state: 'off', brightness: null, modes: dim },
      { id: 'media_player.living_room_speaker', name: 'Living Room speaker', state: 'paused', features: 4 | 8 | 1 | 16 | 32, vol: 0.3, title: 'Clair de Lune — Debussy', model: 'Google Nest Mini', app: 'Spotify' },
      { id: 'camera.living_room_camera', name: 'Living room camera', state: 'idle', model: 'Nest Cam' },
    ] },
    { id: 'kitchen', name: 'Kitchen', items: [
      { id: 'light.kitchen_pendants', name: 'Pendants', state: 'off', brightness: null, modes: dim },
      { id: 'light.under_cabinet', name: 'Under cabinet', state: 'on', brightness: 255, modes: ['onoff'] },
    ] },
    // Two more Sonos speakers to group with (round 5, Sonos grouping): the
    // Roam 2 awake, the Move 2 asleep, as battery speakers often are.
    { id: 'destins_bathroom', name: "Destin's Bathroom", items: [
      { id: 'media_player.roam_2', name: 'Roam 2', state: 'idle', vol: 0.25, model: 'Roam 2', features: 4 | 8 | 1 | 16 | 32 | GROUPING, group: ['media_player.roam_2'] },
    ] },
    { id: 'patio', name: 'Patio', items: [
      { id: 'media_player.move_2', name: 'Move 2', state: 'unavailable', model: 'Move 2', features: 4 | 8 | 1 | 16 | 32 | GROUPING },
    ] },
    { id: 'upstairs', name: 'Upstairs', items: [
      { id: 'climate.thermostat', name: 'Thermostat', state: 'cool', cur: 74, target: 72, min: 50, max: 90, step: 1, modesHvac: ['off', 'cool', 'heat', 'heat_cool'], action: 'cooling' },
    ] },
    { id: 'front_door', name: 'Front door', items: [
      { id: 'camera.doorbell', name: 'Doorbell', state: 'unavailable', model: 'Nest Doorbell' },
    ] },
  ];
}

const ROOMS: Array<{ id: string; name: string; items: Thing[]; scenes?: Array<{ id: string; name: string; last: string }> }> = seed();
// Round 4: what the page shows about where each thing comes from, and Hue
// scenes per room, so chips, Problems and Scenes have something to show.
const MAKERS: Record<string, [string, string]> = { light: ['Signify Netherlands B.V.', 'entry_hue'], climate: ['Google Nest', 'entry_nest'], camera: ['Google Nest', 'entry_nest'], remote: ['Google', 'entry_atv'] };
for (const r of ROOMS) for (const t of r.items) {
  const d = t.id.split('.')[0];
  const [maker, entry] = MAKERS[d] ?? (t.model?.startsWith('Sonos') ? ['Sonos', 'entry_sonos'] : ['Google Inc.', 'entry_cast']);
  t.maker ??= maker; t.entry ??= entry;
  t.since = new Date(Date.now() - 3 * 3600_000).toISOString();
}
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
ROOMS[0].scenes = ['Tokyo', 'Relax', 'Read', 'Concentrate', 'Energize', 'Nightlight', 'TV Time', 'Sunset Glow', 'Galaxy', 'Malibu pink']
  .map((n, i) => ({ id: `scene.destins_room_${n.toLowerCase().replace(/ /g, '_')}`, name: `Destin's Room ${n}`, last: ago(i === 6 ? 1 : 30 + i) }));
ROOMS[1].scenes = ['Relax', 'Read', 'Bright'].map((n, i) => ({ id: `scene.living_room_${n.toLowerCase()}`, name: `Living Room ${n}`, last: ago(40 + i) }));
// A fresh house for each test: everything above is copied once, and this puts it back
// (tests/home-page-harness.ts calls it after every test, so what one test leaves behind never reaches the next).
const SEED = structuredClone(ROOMS);
export function fakeHomeAssistantReset(): void {
  ROOMS.splice(0, ROOMS.length, ...structuredClone(SEED));
  nestSignedIn = false;
  liveSessions.clear();
}

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
const USER_DESTIN = 'user_destin';
type LogEntry = { entity_id: string; name: string; state: string; when: string; context_user_id?: string; context_entity_id?: string; context_entity_id_name?: string; context_event_type?: string };
function logbook(): LogEntry[] {
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60000).toISOString();
  const you = { context_user_id: USER_DESTIN, context_event_type: 'call_service' };
  const auto = { context_entity_id: 'automation.lights_out', context_entity_id_name: 'Lights out at 8', context_event_type: 'automation_triggered' };
  const rows: Array<[number, string, string, string, object?]> = [
    [1500, 'light.living_room_lamp', 'Floor lamp', 'on'],
    [1440, 'media_player.living_room_speaker', 'Living Room speaker', 'playing', you],
    [1380, 'media_player.living_room_speaker', 'Living Room speaker', 'paused', you],
    [720, 'light.living_room_lamp', 'Floor lamp', 'off', auto],
    [720, 'light.overhead_light', 'Overhead light', 'off', auto],
    [260, 'climate.thermostat', 'Thermostat', 'cool', you],
    [230, 'light.tv_backlight', 'TV backlight', 'unavailable'],
    [130, 'scene.living_room_relax', 'Living Room Relax', at(130), you],
    [120, 'light.living_room_lamp', 'Floor lamp', 'on', you],
    [60, 'light.living_room_lamp', 'Floor lamp', 'off'],
    [70, 'remote.destins_room_tv_remote', "Destin's Room TV remote", 'on', you],
    [69, 'media_player.destins_room_google_tv', "Destin's Room TV", 'idle'],
    [69, 'media_player.destins_room_google_tv', "Destin's Room TV", 'playing'],
    [68, 'media_player.destins_room_google_tv', "Destin's Room TV", 'playing'],
    [45, 'light.overhead_light', 'Overhead light', 'on'],
    [12, 'light.living_room_lamp', 'Floor lamp', 'on'],
  ];
  return rows.map(([m, entity_id, name, state, ctx]) => ({ entity_id, name, state, when: at(m), ...(ctx ?? {}) }));
}

function leaveGroup(id: string): void {
  const t = find(id);
  if (!t?.group || t.group.length < 2) return;
  const rest = t.group.filter((m) => m !== id);
  rest.forEach((m) => { const x = find(m); if (x) x.group = rest; });
  t.group = [id];
  t.state = 'idle'; t.title = null; t.source = undefined;
}

export function fakeHomeAssistantFetch(req: PageFetchRequest): PageFetchResult | null {
  let url: URL;
  try { url = new URL(req.url); } catch { return null; }
  if (!url.pathname.startsWith('/api/')) return null;
  // Rooms with nothing in them are left out, as the real template does; each
  // item carries the id of the device it belongs to (`device_id(e)`), which
  // a room move needs (fakeHomeAssistantSocket).
  // The logbook (round 5: Activity tab, a device's pop-up): a day of made-up
  // changes to the page's own devices, newest last as Home Assistant sends
  // them. Who did it follows the real shapes: a person's id, an automation,
  // or nothing at all when the change came from the device or another app.
  const lb = /^\/api\/logbook\/(.+)$/.exec(url.pathname);
  if (lb) {
    const from = Date.parse(decodeURIComponent(lb[1])) || Date.now() - 86400000;
    const only = url.searchParams.get('entity');
    return ok(JSON.stringify(logbook().filter((e) => Date.parse(e.when) >= from && (!only || e.entity_id === only))));
  }
  if (url.pathname === '/api/template') {
    // The page's second template asks for the weather and low batteries.
    if ((req.body ?? '').includes('EXTRAS')) {
      return ok(JSON.stringify({
        weather: { state: 'clear-night', temp: 77, unit: '°F', humidity: 58 },
        low: [{ id: 'sensor.destin_s_light_switch_battery', name: "Destin's light switch battery", level: 1, device: 'dev_switch', room: "Destin's Room" },
          { id: 'sensor.bathroom_button_battery', name: 'Bathroom button battery', level: 15, device: 'dev_button', room: "Grandma's Bathroom" }],
        people: [{ user: USER_DESTIN, name: 'Destin' }],
      }));
    }
    return ok(JSON.stringify(ROOMS.filter((r) => r.items.length).map((r) => ({ ...r, items: r.items.map((t) => ({ ...t, device: deviceOf(t.id) })) }))));
  }
  // A Nest event's recorded clip and thumbnail (spec 2026-10-04, Part 3). The
  // clip is answered the way the app answers `as: 'video'`: a data: link.
  const media = /^\/api\/nest\/event_media\/([^/]+)\/([^/]+)\/(clip\.mp4|thumbnail)$/.exec(url.pathname);
  if (media) {
    if (media[3] === 'thumbnail') return { ok: true, status: 200, headers: { 'content-type': 'image/svg+xml' }, body: snapshot(decodeURIComponent(media[2]).replace(/^e/, 'Event ')) };
    return { ok: true, status: 200, headers: { 'content-type': 'video/mp4' }, body: `data:video/mp4;base64,${FAKE_NEST_CLIP_BASE64}` };
  }
  const cam = /^\/api\/camera_proxy\/(.+)$/.exec(url.pathname);
  if (cam) {
    const t = find(cam[1]);
    // A Nest camera gives Home Assistant no still picture: it answers with
    // its small blank stand-in, as the real house does.
    if (t?.maker === 'Google Nest') return { ok: true, status: 200, headers: { 'content-type': 'image/jpeg' }, body: 'data:image/jpeg;base64,' + 'A'.repeat(3500) };
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
      const stateBefore = t.state;
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
      if (action === 'volume_up' && t.vol != null) t.vol = Math.min(1, t.vol + 0.02);
      if (action === 'volume_down' && t.vol != null) t.vol = Math.max(0, t.vol - 0.02);
      if (action === 'volume_mute') t.muted = data.is_volume_muted === true;
      if (action === 'set_temperature' && typeof data.temperature === 'number') t.target = data.temperature;
      // Sonos grouping, as Home Assistant does it: `join` adds speakers to
      // this one's group (leaving any group they were in), `unjoin` takes
      // this one out of its group. Every member lists the whole group.
      if (action === 'join' && Array.isArray(data.group_members)) {
        const add = (data.group_members as unknown[]).map(String).filter((m) => m !== id && find(m)?.state !== 'unavailable');
        add.forEach((m) => leaveGroup(m));
        const members = [...new Set([...(t.group ?? [id]), ...add])];
        members.forEach((m) => { const x = find(m); if (x) x.group = members; });
        // A speaker joining picks up what the group plays.
        add.forEach((m) => { const x = find(m); if (x) { x.state = t.state; x.title = t.title; x.source = t.source; } });
      }
      if (action === 'unjoin') leaveGroup(id);
      // Home Assistant stamps "last changed" when the STATE moves (not for a
      // brightness or volume change), and the live push carries it.
      if (t.state !== stateBefore) t.since = new Date().toISOString();
    }
    // Whoever is listening live hears about it now, as with the real one.
    notifyLive();
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

/** Recorded events per camera device, newest first. The Living Room camera has
 *  a few; the Doorbell has none (its Nest account is not sending events), so
 *  both the list and the "No recordings yet" wording can be seen. Titles follow
 *  Home Assistant's own: the local time, then what it saw. */
const nestEvents: Record<string, Array<{ id: string; title: () => string }>> = {};
{
  const stamp = (minAgo: number, what: string) => () => {
    const d = new Date(Date.now() - minAgo * 60000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${what}`;
  };
  nestEvents.dev_camera_living_room_camera = [
    { id: 'e1', title: stamp(55, 'Person') }, { id: 'e2', title: stamp(300, 'Motion') }, { id: 'e3', title: stamp(480, 'Doorbell') },
  ];
  nestEvents.dev_camera_doorbell = [];
}

// ── Instant updates (spec 2026-10-04, Part 1) ─────────────────────────────
// Home Assistant's `subscribe_entities`: the first answer is every state in
// full (`a`), later ones are compressed changes (`c`, with '+' for what is new
// or changed and '-' for attributes that went away) and removals (`r`). This
// pretends to be that, driven by the same ROOMS the template answers from, so
// the page's instant updates can be seen with no house.
type Squashed = { s: string; a: Record<string, unknown>; lc: number; lu: number };
const ATTRS: Array<[keyof Thing, string]> = [
  ['name', 'friendly_name'], ['brightness', 'brightness'], ['modes', 'supported_color_modes'], ['cur', 'current_temperature'], ['target', 'temperature'],
  ['min', 'min_temp'], ['max', 'max_temp'], ['step', 'target_temp_step'], ['vol', 'volume_level'], ['title', 'media_title'], ['rgb', 'rgb_color'],
  ['k', 'color_temp_kelvin'], ['modesHvac', 'hvac_modes'], ['action', 'hvac_action'], ['dc', 'device_class'], ['activity', 'current_activity'],
  ['app', 'app_name'], ['source', 'source'], ['muted', 'is_volume_muted'], ['group', 'group_members'], ['features', 'supported_features'],
];
function squash(t: Thing): Squashed {
  const a: Record<string, unknown> = {};
  for (const [field, attr] of ATTRS) if (t[field] !== undefined) a[attr] = t[field];
  const lc = Date.parse(t.since ?? '') / 1000 || 0;
  // The house's own "last updated" stamp: the template answers with it (`upd`) too, so the page can tell which is newer.
  return { s: t.state, a, lc, lu: Date.parse(t.upd ?? '') / 1000 || lc };
}
interface LiveSub { id: number; ids: Set<string>; last: Map<string, Squashed> }
interface LiveSession { push?: (texts: string[]) => void; subs: LiveSub[] }
const liveSessions = new Set<LiveSession>();

/** Tell every live listener what changed since it last heard, as one compressed
 *  event per subscription. Nothing is sent when nothing differs. */
function notifyLive(): void {
  for (const session of liveSessions) for (const sub of session.subs) {
    const added: Record<string, Squashed> = {};
    const changed: Record<string, { '+'?: Record<string, unknown>; '-'?: { a: string[] } }> = {};
    for (const id of sub.ids) {
      const t = find(id);
      if (!t) continue;
      let now = squash(t);
      const was = sub.last.get(id);
      if (!was) { sub.last.set(id, now); added[id] = now; continue; }
      const plus: Record<string, unknown> = {};
      if (now.s !== was.s) { plus.s = now.s; plus.lc = now.lc; }
      const aPlus: Record<string, unknown> = {};
      for (const k of Object.keys(now.a)) if (JSON.stringify(now.a[k]) !== JSON.stringify(was.a[k])) aPlus[k] = now.a[k];
      if (Object.keys(aPlus).length) plus.a = aPlus;
      const gone = Object.keys(was.a).filter((k) => !(k in now.a));
      if (!Object.keys(plus).length && !gone.length) { sub.last.set(id, now); continue; }
      // Something changed: the house stamps it now (once, however many listeners hear of it).
      if (!t.upd || Date.parse(t.upd) / 1000 <= was.lu) t.upd = new Date().toISOString();
      now = squash(t); plus.lu = now.lu;
      sub.last.set(id, now);
      changed[id] = { ...(Object.keys(plus).length ? { '+': plus } : {}), ...(gone.length ? { '-': { a: gone } } : {}) };
    }
    const event: Record<string, unknown> = {};
    if (Object.keys(added).length) event.a = added;
    if (Object.keys(changed).length) event.c = changed;
    if (Object.keys(event).length) session.push?.([JSON.stringify({ id: sub.id, type: 'event', event })]);
  }
}

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

/** By default the pretend Nest account needs signing in again (that is what the
 *  Problems screen shows). The camera screen and tests turn it on, so the Nest
 *  cameras show their events instead of the sign-in note. */
let nestSignedIn = false;
export function fakeHomeAssistantNestSignedIn(signedIn: boolean): void { nestSignedIn = signedIn; }

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
    // Round 4: Home Assistant's own health, for the Problems chip.
    case 'config_entries/get': return reply(id, [
      { entry_id: 'entry_hue', domain: 'hue', title: 'Hue Bridge', state: 'loaded', disabled_by: null },
      nestSignedIn
        ? { entry_id: 'entry_nest', domain: 'nest', title: 'Gasparac Household', state: 'loaded', disabled_by: null }
        : { entry_id: 'entry_nest', domain: 'nest', title: 'Gasparac Household', state: 'setup_error', reason: 'the sign-in expired', disabled_by: null },
      { entry_id: 'entry_cast', domain: 'cast', title: 'Google Cast', state: 'loaded', disabled_by: null },
      { entry_id: 'entry_sonos', domain: 'sonos', title: 'Sonos', state: 'loaded', disabled_by: null },
    ]);
    case 'config_entries/flow/progress': return reply(id, nestSignedIn ? [] : [
      { flow_id: 'flow_nest', handler: 'nest', step_id: 'reauth_confirm', context: { source: 'reauth', entry_id: 'entry_nest', title_placeholders: { name: 'Gasparac Household' } } },
    ]);
    case 'repairs/list_issues': return reply(id, { issues: [] });
    // Recorded Nest events (spec 2026-10-04, Part 3), the way Home Assistant's
    // media browser lists and then resolves them.
    case 'media_source/browse_media': {
      const dev = /^media-source:\/\/nest\/([^/]+)$/.exec(String(m.media_content_id ?? ''))?.[1];
      if (!dev) return reply(id, null, 'Unknown media source.');
      return reply(id, { title: 'Events', media_class: 'directory', media_content_id: `media-source://nest/${dev}`, can_play: false, can_expand: true,
        children: (nestEvents[dev] ?? []).map((e) => ({ title: e.title(), media_class: 'video', media_content_type: 'video/mp4', media_content_id: `media-source://nest/${dev}/${e.id}`, can_play: true, can_expand: false, thumbnail: `/api/nest/event_media/${dev}/${e.id}/thumbnail` })) });
    }
    case 'media_source/resolve_media': {
      const mm = /^media-source:\/\/nest\/([^/]+)\/([^/]+)$/.exec(String(m.media_content_id ?? ''));
      if (!mm) return reply(id, null, 'Unknown media.');
      return reply(id, { url: `/api/nest/event_media/${mm[1]}/${mm[2]}/clip.mp4?authSig=pretend`, mime_type: 'video/mp4' });
    }
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
      notifyLive();
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

/** A LIVE session with the pretend Home Assistant (the page's live socket in
 *  the workbench). Same conversation as the real one: `opened()` is what the
 *  app's own greeting produces (the app sends the key, so the page sees
 *  `auth_required` then `auth_ok` and sends nothing itself), then each message
 *  is answered through the same table the one-shot exchange uses. A
 *  `subscribe_entities` is answered with the first full snapshot, and changes
 *  made later (a service call, a rename) arrive through `push`, which the
 *  caller delivers like any other message. */
export function fakeHomeAssistantLive(push?: (texts: string[]) => void): { opened: () => string[]; message: (text: string) => string[]; close: () => void } {
  const session: LiveSession = { push, subs: [] };
  liveSessions.add(session);
  return {
    opened: () => [JSON.stringify({ type: 'auth_required', ha_version: '2026.9.0' }), JSON.stringify({ type: 'auth_ok', ha_version: '2026.9.0' })],
    close: () => { liveSessions.delete(session); },
    message: (text) => {
      let m: { type?: unknown; id?: unknown; entity_ids?: unknown; subscription?: unknown };
      try { m = JSON.parse(text); } catch { return []; }
      if (m.type === 'auth') return [JSON.stringify({ type: 'auth_ok', ha_version: '2026.9.0' })];
      if (m.type === 'subscribe_entities' && typeof m.id === 'number') {
        const sub: LiveSub = { id: m.id, ids: new Set(Array.isArray(m.entity_ids) ? m.entity_ids.map(String) : []), last: new Map() };
        session.subs.push(sub);
        const a: Record<string, Squashed> = {};
        for (const id of sub.ids) { const t = find(id); if (t) { a[id] = squash(t); sub.last.set(id, a[id]); } }
        return [reply(m.id, null), JSON.stringify({ id: m.id, type: 'event', event: { a } })];
      }
      if (m.type === 'unsubscribe_events') {
        session.subs = session.subs.filter((x) => x.id !== m.subscription);
        return [reply(m.id, null)];
      }
      const a = answerOne(text);
      return a ? [a] : [];
    },
  };
}

/** Entity ids in the pretend house, for a workbench screen that wants only some
 *  of them (`?pagesHome=camera` hides everything that is not a camera). */
export function fakeHomeAssistantIds(): string[] {
  return ROOMS.flatMap((r) => r.items.map((t) => t.id));
}
