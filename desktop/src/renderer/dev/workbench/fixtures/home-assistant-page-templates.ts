// The two Home Assistant templates the Home page sends (kept apart from
// home-assistant-page.ts so it stays inside the line budget).

/** One request that answers "every room, and the lights, thermostats, players
 *  and cameras in it". `.get()` rather than `.attr` so a missing attribute is
 *  null in the JSON, never a template error. */
// WHY a light's 'members': a Hue room (or a Home Assistant light group) is itself a light whose entity_id attribute lists
// its lights (a SET in a template: "| list" or the whole answer fails to serialise, as it did on the real house);
// the page hides it where those lights already show, or the room gets a tile for itself (Destin, 2026-10-05).
// WHY 'posAt' and 'members' are type-guarded (code review F17): this is rendered by the REAL Home Assistant, where one non-JSON value
// (a set, a datetime) or a template error blanks the WHOLE page. `posAt` is a datetime normally but may arrive as a string (a restored
// state); `members` is normally a list but a plain string would be split into letters by "| list".
// WHY 'sources' (basic controls, 2026-10-05): a player's source_list is the inputs the Input picker offers; guarded like 'members' (a plain
// string would be split into letters by "| list", a missing one is none), and it is JSON-safe (a list of names).
// WHY computers (2026-10-05): a ping sensor and a wake-on-LAN button are the two halves of one "Computer" card. Only entities of those two
// integrations are taken (integration_entities is a list of entity-id strings, JSON-safe), never every button or binary sensor in the house.
// WHY the camera's 'evs': Nest publishes a camera's motion / person / chime events as separate event.* entities on the SAME
// device, and the camera card reads their history so an event with no recording still shows. `[.]` rather than an escaped dot
// because a backslash here would need doubling through two template strings.
export const ROOMS_TEMPLATE = `{%- set ns = namespace(rooms=[]) -%}
{%- set pcs = integration_entities('ping') + integration_entities('wake_on_lan') -%}
{%- set casts = integration_entities('cast') -%}
{%- for a in areas() -%}
{%- set ens = namespace(items=[], scenes=[]) -%}
{%- for e in area_entities(a) -%}
{%- set d = e.split('.')[0] -%}
{%- if d == 'scene' and states[e] is not none -%}
{%- set ens.scenes = ens.scenes + [{'id': e, 'name': states[e].name, 'last': states[e].state}] -%}
{%- endif -%}
{%- if d in ['light','climate','media_player','camera','remote'] and states[e] is not none -%}
{%- set s = states[e] -%}
{%- set pa = s.attributes.get('media_position_updated_at') -%}
{%- set eid = s.attributes.get('entity_id') -%}
{%- set sl = s.attributes.get('source_list') -%}
{%- set ce = device_attr(device_id(e), 'config_entries') -%}
{%- set ens.items = ens.items + [{'id': e, 'maker': device_attr(device_id(e), 'manufacturer'), 'entry': (ce | list | first) if ce else none, 'since': s.last_changed.isoformat(), 'upd': s.last_updated.isoformat(), 'name': s.name, 'state': s.state, 'brightness': s.attributes.get('brightness'), 'modes': s.attributes.get('supported_color_modes'), 'cur': s.attributes.get('current_temperature'), 'target': s.attributes.get('temperature'), 'tlo': s.attributes.get('target_temp_low'), 'thi': s.attributes.get('target_temp_high'), 'min': s.attributes.get('min_temp'), 'max': s.attributes.get('max_temp'), 'step': s.attributes.get('target_temp_step'), 'vol': s.attributes.get('volume_level'), 'title': s.attributes.get('media_title'), 'features': s.attributes.get('supported_features', 0), 'rgb': s.attributes.get('rgb_color'), 'k': s.attributes.get('color_temp_kelvin'), 'modesHvac': s.attributes.get('hvac_modes'), 'action': s.attributes.get('hvac_action'), 'device': device_id(e), 'evs': ((device_entities(device_id(e)) | select('match', 'event[.]') | list) if d == 'camera' and device_id(e) else none), 'model': device_attr(device_id(e), 'model'), 'dc': s.attributes.get('device_class'), 'activity': s.attributes.get('current_activity'), 'app': s.attributes.get('app_name'), 'source': s.attributes.get('source'), 'sources': ((sl | list) if sl is iterable and sl is not string else none), 'cid': s.attributes.get('media_content_id'), 'pos': s.attributes.get('media_position'), 'posAt': ((pa.isoformat() if pa is not string and pa.isoformat is defined else pa) if pa else none), 'muted': s.attributes.get('is_volume_muted'), 'group': s.attributes.get('group_members'), 'members': (([eid] if eid is string else (eid | list)) if d == 'light' and eid else none), 'sw': device_attr(device_id(e), 'sw_version'), 'cast': (e in casts) if d == 'media_player' else none}] -%}
{%- endif -%}
{%- if d in ['button','binary_sensor'] and e in pcs and states[e] is not none -%}
{%- set s = states[e] -%}
{%- set ce = device_attr(device_id(e), 'config_entries') -%}
{%- set ens.items = ens.items + [{'id': e, 'maker': device_attr(device_id(e), 'manufacturer'), 'entry': (ce | list | first) if ce else none, 'since': s.last_changed.isoformat(), 'upd': s.last_updated.isoformat(), 'name': s.name, 'state': s.state, 'device': device_id(e), 'model': device_attr(device_id(e), 'model'), 'dc': s.attributes.get('device_class')}] -%}
{%- endif -%}
{%- endfor -%}
{%- if ens.items -%}{%- set ns.rooms = ns.rooms + [{'id': a, 'name': area_name(a), 'items': ens.items, 'scenes': ens.scenes}] -%}{%- endif -%}
{%- endfor -%}
{{ ns.rooms | to_json }}`;

/** Round 4 (home-page-v3 deck): what the chips need beyond the rooms — the
 *  weather, and batteries running low. One small request per check. The
 *  first line names it so the pretend Home Assistant can tell it apart. */
export const EXTRAS_TEMPLATE = `{#- EXTRAS -#}
{%- set w = states.weather | first -%}
{%- set low = namespace(list=[]) -%}
{%- for s in states.sensor if s.attributes.get('device_class') == 'battery' and s.state | is_number and s.state | float(100) < 20 -%}
{%- set low.list = low.list + [{'id': s.entity_id, 'name': s.name, 'level': s.state | float, 'device': device_id(s.entity_id), 'room': area_name(s.entity_id)}] -%}
{%- endfor -%}
{%- set ppl = namespace(list=[]) -%}
{%- for p in states.person -%}{%- set ppl.list = ppl.list + [{'user': p.attributes.get('user_id'), 'name': p.name}] -%}{%- endfor -%}
{{ {'weather': ({'state': w.state, 'temp': w.attributes.get('temperature'), 'unit': w.attributes.get('temperature_unit'), 'humidity': w.attributes.get('humidity')} if w else none), 'low': low.list, 'people': ppl.list} | to_json }}`;
