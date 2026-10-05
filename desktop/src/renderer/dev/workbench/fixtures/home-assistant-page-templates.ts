// The two Home Assistant templates the Home page sends (kept apart from
// home-assistant-page.ts so it stays inside the line budget).

/** One request that answers "every room, and the lights, thermostats, players
 *  and cameras in it". `.get()` rather than `.attr` so a missing attribute is
 *  null in the JSON, never a template error. */
export const ROOMS_TEMPLATE = `{%- set ns = namespace(rooms=[]) -%}
{%- for a in areas() -%}
{%- set ens = namespace(items=[], scenes=[]) -%}
{%- for e in area_entities(a) -%}
{%- set d = e.split('.')[0] -%}
{%- if d == 'scene' and states[e] is not none -%}
{%- set ens.scenes = ens.scenes + [{'id': e, 'name': states[e].name, 'last': states[e].state}] -%}
{%- endif -%}
{%- if d in ['light','climate','media_player','camera','remote'] and states[e] is not none -%}
{%- set s = states[e] -%}
{%- set ce = device_attr(device_id(e), 'config_entries') -%}
{%- set ens.items = ens.items + [{'id': e, 'maker': device_attr(device_id(e), 'manufacturer'), 'entry': (ce | list | first) if ce else none, 'since': s.last_changed.isoformat(), 'upd': s.last_updated.isoformat(), 'name': s.name, 'state': s.state, 'brightness': s.attributes.get('brightness'), 'modes': s.attributes.get('supported_color_modes'), 'cur': s.attributes.get('current_temperature'), 'target': s.attributes.get('temperature'), 'min': s.attributes.get('min_temp'), 'max': s.attributes.get('max_temp'), 'step': s.attributes.get('target_temp_step'), 'vol': s.attributes.get('volume_level'), 'title': s.attributes.get('media_title'), 'features': s.attributes.get('supported_features', 0), 'rgb': s.attributes.get('rgb_color'), 'k': s.attributes.get('color_temp_kelvin'), 'modesHvac': s.attributes.get('hvac_modes'), 'action': s.attributes.get('hvac_action'), 'device': device_id(e), 'model': device_attr(device_id(e), 'model'), 'dc': s.attributes.get('device_class'), 'activity': s.attributes.get('current_activity'), 'app': s.attributes.get('app_name'), 'source': s.attributes.get('source'), 'cid': s.attributes.get('media_content_id'), 'pos': s.attributes.get('media_position'), 'posAt': (s.attributes.get('media_position_updated_at').isoformat() if s.attributes.get('media_position_updated_at') else none), 'muted': s.attributes.get('is_volume_muted'), 'group': s.attributes.get('group_members'), 'sw': device_attr(device_id(e), 'sw_version')}] -%}
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
