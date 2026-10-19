// WHY: native and MCP must reject the entire request before queue admission,
// startup, asks or mutations. Schemas check shapes; this browser-local preflight
// checks action-specific meaning. Legacy fields are accepted ONLY at this boundary.
import { z } from 'zod';
import { BROWSER_TOOL_SPECS, type BrowserToolName, type BrowserToolArgs } from './browser-tool-specs';
import { normaliseAddress } from './browser-net';

type Operation = { [N in BrowserToolName]: { name: N; args: BrowserToolArgs<N> } }[BrowserToolName];
type Preflight = { operation: Operation; legacyZoom?: number | 'auto' } | { error: string };
const legacyNavigate = z.object({
  url: BROWSER_TOOL_SPECS.BrowserNavigate.schema.shape.url.optional(),
  newTab: BROWSER_TOOL_SPECS.BrowserNavigate.schema.shape.newTab,
  go: z.enum(['back', 'forward']).optional(),
  zoom: BROWSER_TOOL_SPECS.BrowserZoom.schema.shape.zoom.optional(),
}).strict();

export function validateBrowserRequest(name: string, raw: unknown): Preflight {
  if (!Object.hasOwn(BROWSER_TOOL_SPECS, name)) return { error: `Unknown browser tool: ${name}` };
  const schema = name === 'BrowserNavigate' ? legacyNavigate : BROWSER_TOOL_SPECS[name as BrowserToolName].schema;
  const parsed = schema.safeParse(raw);
  const fail = (detail: string): Preflight => ({ error: `${name}: invalid input — ${detail}` });
  if (!parsed.success) return fail(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') + (name === 'BrowserNavigate' ? '. Use BrowserNavigate {"url":"https://example.com"}, BrowserHistory {"direction":"back"}, or BrowserZoom {"zoom":50}.' : '. Omit unrelated fields and supply the required fields for this operation.'));
  if (name === 'BrowserNavigate') {
    const a = parsed.data as z.infer<typeof legacyNavigate>;
    if (a.go !== undefined && (a.url !== undefined || a.zoom !== undefined)) return fail('Do not combine history with URL or zoom. Use BrowserHistory {"direction":"back"}; open URLs separately with BrowserNavigate {"url":"https://example.com"} and set zoom with BrowserZoom {"zoom":50}.');
    if (a.newTab !== undefined && a.url === undefined) return fail('newTab requires url. Use BrowserNavigate {"url":"https://example.com","newTab":true}.');
    if (a.url !== undefined) {
      let url: string;
      try { url = normaliseAddress(a.url); } catch (e) { return fail(`${(e as Error).message}. Use BrowserNavigate {"url":"https://example.com"}.`); }
      return { operation: { name: 'BrowserNavigate', args: { url, ...(a.newTab !== undefined ? { newTab: a.newTab } : {}) } }, ...(a.zoom !== undefined ? { legacyZoom: a.zoom } : {}) };
    }
    if (a.go !== undefined) return { operation: { name: 'BrowserHistory', args: { direction: a.go } } };
    if (a.zoom !== undefined) return { operation: { name: 'BrowserZoom', args: { zoom: a.zoom } } };
    return fail('url is required. Use BrowserNavigate {"url":"https://example.com"}, BrowserHistory {"direction":"back"}, or BrowserZoom {"zoom":50}.');
  }
  if (name === 'BrowserAct') {
    const a = parsed.data as BrowserToolArgs<'BrowserAct'>;
    if (!a.element.trim()) return fail('element must describe the target, e.g. "Search box".');
    if (a.action !== 'press_key' && !a.ref?.trim()) return fail(`${a.action} needs ref from the latest BrowserSnapshot.`);
    if (a.ref !== undefined && !a.ref.trim()) return fail('ref must be nonblank; use the latest BrowserSnapshot.');
    const allowed = a.action === 'type' ? ['text', 'submit'] : a.action === 'select' ? ['values'] : a.action === 'press_key' ? ['key'] : [];
    for (const field of ['text', 'submit', 'values', 'key'] as const) {
      if (a[field] !== undefined && !allowed.includes(field)) return fail(`${field} is not valid for ${a.action}; omit it.`);
    }
    if (a.action === 'type' && a.text === undefined) return fail('type needs text; use text:"" to clear a field.');
    if (a.action === 'select' && !a.values?.length) return fail('select needs a nonempty values array, e.g. ["English"].');
    if (a.action === 'press_key' && !a.key?.trim()) return fail('press_key needs a nonblank key, e.g. "Enter".');
  }
  if (name === 'BrowserWait') {
    const a = parsed.data as BrowserToolArgs<'BrowserWait'>;
    if ([a.text, a.textGone, a.seconds].filter((v) => v !== undefined).length > 1) return fail('Choose only one of text, textGone or seconds; e.g. {"text":"Ready"}.');
    if ((a.text !== undefined && !a.text.trim()) || (a.textGone !== undefined && !a.textGone.trim())) return fail('Text conditions cannot be blank; use {} for a two-second pause or {"seconds":0} for no delay.');
  }
  if (name === 'BrowserTabs') {
    const a = parsed.data as BrowserToolArgs<'BrowserTabs'>;
    const needsIndex = a.action === 'select' || a.action === 'close';
    if (needsIndex && a.index === undefined) return fail(`${a.action} requires index from BrowserTabs {"action":"list"}.`);
    if (!needsIndex && a.index !== undefined) return fail(`${a.action} does not accept index; omit it.`);
  }
  if (name === 'BrowserAskUser' && !(parsed.data as BrowserToolArgs<'BrowserAskUser'>).message.trim()) return fail('message must say what the user needs to do.');
  return { operation: { name, args: parsed.data } as Operation };
}
