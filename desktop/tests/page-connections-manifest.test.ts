// The manifest is written by an assistant or a stranger, and what it says is
// what the approval screen promises — so these pin the refusals.
import { describe, expect, it } from 'vitest';
import { kindOf } from '../src/main/pages/page-kinds';
import { applyScheme, covers, fingerprint, keyPlacement, methodAllowed, parseConnections } from '../src/main/pages/page-connections';

const key = { id: 'k', kind: 'key', service: 'OpenWeather', address: 'api.openweathermap.org', access: 'lookup' };

describe('parseConnections', () => {
  it('is empty for anything that is not a list', () => {
    for (const raw of [undefined, null, 'x', 7, {}]) expect(parseConnections(raw)).toEqual([]);
  });

  it('keeps a well-formed list and lower-cases the address', () => {
    const out = parseConnections([{ ...key, address: 'API.OpenWeatherMap.org.' }]);
    expect(out).toEqual([{ id: 'k', kind: 'key', service: 'OpenWeather', address: 'api.openweathermap.org', access: 'lookup', keyHelp: undefined }]);
  });

  it('drops an entry whose address is not a bare hostname', () => {
    for (const address of ['https://api.x.com', 'api.x.com/v1', 'api.x.com:443', '*.x.com', 'user@api.x.com', 'localhost', 'api x.com', '10.0.0.1']) {
      expect(parseConnections([{ ...key, address }]), address).toEqual([]);
    }
  });

  it('drops unknown kinds, missing fields and duplicate ids', () => {
    expect(parseConnections([{ id: 'a', kind: 'files' }])).toEqual([]);
    expect(parseConnections([{ id: 'a', kind: 'key', address: 'api.x.com' }])).toEqual([]);
    expect(parseConnections([{ kind: 'youcoded' }])).toEqual([]);
    expect(parseConnections([{ id: 'a', kind: 'youcoded' }, { id: 'a', kind: 'open' }])).toHaveLength(1);
  });

  it('reads an unrecognised access as look-up only', () => {
    expect(parseConnections([{ ...key, access: 'anything' }])[0]).toMatchObject({ access: 'lookup' });
    expect(parseConnections([{ ...key, access: 'full' }])[0]).toMatchObject({ access: 'full' });
  });

  it('drops the WHOLE list when the whole internet is mixed with a credential', () => {
    expect(parseConnections([{ id: 'o', kind: 'open' }, key])).toEqual([]);
    expect(parseConnections([{ id: 'o', kind: 'open' }, { id: 'y', kind: 'youcoded' }])).toEqual([]);
    expect(parseConnections([{ id: 'o', kind: 'open' }, { id: 'g', kind: 'github', access: 'lookup' }])).toEqual([]);
    // but the whole internet beside public information is fine: no credential.
    expect(parseConnections([{ id: 'o', kind: 'open' }, { id: 'p', kind: 'public', address: 'hnrss.org' }])).toHaveLength(2);
  });

  it('caps the list and the strings', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...key, id: `k${i}` }));
    expect(parseConnections(many)).toHaveLength(8);
    const long = parseConnections([{ ...key, service: 'S'.repeat(200), keyHelp: { steps: Array.from({ length: 20 }, () => 'x'.repeat(500)) } }])[0];
    expect((long as { service: string }).service).toHaveLength(40);
    expect((long as { keyHelp: { steps: string[] } }).keyHelp.steps).toHaveLength(6);
    expect((long as { keyHelp: { steps: string[] } }).keyHelp.steps[0]).toHaveLength(200);
  });
});

describe('fingerprint', () => {
  it('changes when the access or the address widens', () => {
    expect(fingerprint(parseConnections([key])[0])).not.toBe(fingerprint(parseConnections([{ ...key, access: 'full' }])[0]));
    expect(fingerprint(parseConnections([key])[0])).not.toBe(fingerprint(parseConnections([{ ...key, address: 'api.other.com' }])[0]));
  });
  it('does not change when only the id or the help text changes', () => {
    const a = fingerprint(parseConnections([key])[0]);
    expect(fingerprint(parseConnections([{ ...key, id: 'renamed' }])[0])).toBe(a);
    expect(fingerprint(parseConnections([{ ...key, keyHelp: { steps: ['do a thing'] } }])[0])).toBe(a);
  });
});

describe('covers', () => {
  const c = parseConnections([key])[0];
  it('matches only the exact host', () => {
    expect(covers(c, 'api.openweathermap.org')).toBe(true);
    expect(covers(c, 'API.OpenWeatherMap.ORG.')).toBe(true);
    for (const host of ['api.openweathermap.org.attacker.test', 'evil-api.openweathermap.org', 'openweathermap.org', 'xapi.openweathermap.org'])
      expect(covers(c, host), host).toBe(false);
  });
  it('pins the app\'s own credentials to their own hosts', () => {
    const [yc, gh] = [parseConnections([{ id: 'y', kind: 'youcoded' }])[0], parseConnections([{ id: 'g', kind: 'github', access: 'lookup' }])[0]];
    expect(covers(yc, 'api.youcoded.ai')).toBe(true);
    expect(covers(yc, 'attacker.test')).toBe(false);
    expect(covers(gh, 'api.github.com')).toBe(true);
    expect(covers(gh, 'raw.githubusercontent.com')).toBe(false);
  });
  it('lets the whole internet cover anything', () => {
    expect(covers(parseConnections([{ id: 'o', kind: 'open' }])[0], 'anything.test')).toBe(true);
  });
});

describe('methodAllowed', () => {
  it('holds a look-up connection to GET and HEAD', () => {
    const c = parseConnections([key])[0];
    expect(methodAllowed(c, 'get')).toBe(true);
    expect(methodAllowed(c, 'HEAD')).toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(methodAllowed(c, m), m).toBe(false);
  });
  it('allows the ordinary methods on a full connection', () => {
    const c = parseConnections([{ ...key, access: 'full' }])[0];
    expect(methodAllowed(c, 'POST')).toBe(true);
    expect(methodAllowed(c, 'TRACE')).toBe(false);
  });
  it('holds public information and the YouCoded sign-in to look-ups', () => {
    expect(methodAllowed(parseConnections([{ id: 'p', kind: 'public', address: 'hnrss.org' }])[0], 'POST')).toBe(false);
    expect(methodAllowed(parseConnections([{ id: 'y', kind: 'youcoded' }])[0], 'POST')).toBe(false);
  });
});

describe('keyPlacement', () => {
  it('sends a key as "Authorization: Bearer <key>" when the manifest says nothing', () => {
    const p = keyPlacement(parseConnections([key])[0]);
    expect(p).toEqual({ in: 'header', param: 'authorization', scheme: 'bearer' });
    expect(applyScheme(p.scheme, 'abc')).toBe('Bearer abc');
  });
  it('sends a key bare in any other header unless the author names a word', () => {
    expect(keyPlacement(parseConnections([{ ...key, keyParam: 'x-api-key' }])[0]).scheme).toBe('none');
    expect(keyPlacement(parseConnections([{ ...key, keyParam: 'authorization', keyScheme: 'token' }])[0]).scheme).toBe('token');
  });
  it('never puts a word before a key in a query parameter', () => {
    const p = keyPlacement(parseConnections([{ ...key, keyIn: 'query', keyParam: 'appid', keyScheme: 'bearer' }])[0]);
    expect(p).toEqual({ in: 'query', param: 'appid', scheme: 'none' });
  });
  it('ignores a scheme it does not know', () => {
    expect(keyPlacement(parseConnections([{ ...key, keyScheme: 'Basic' }])[0]).scheme).toBe('bearer');
  });
});

describe('a YouCoded connection that may change things', () => {
  const yc = (writePaths: unknown) => parseConnections([{ id: 'y', kind: 'youcoded', writePaths }])[0];
  it('changes only at the places it names, at a / boundary', () => {
    const c = yc(['/admin/analytics/website-campaigns']);
    expect(methodAllowed(c, 'POST', '/admin/analytics/website-campaigns')).toBe(true);
    expect(methodAllowed(c, 'DELETE', '/admin/analytics/website-campaigns/42')).toBe(true);
    for (const p of ['/admin/analytics/website-campaigns-evil', '/account', '/admin', '/admin/analytics/website-campaigns%2F..%2Faccount'])
      expect(methodAllowed(c, 'POST', p), p).toBe(false);
    expect(methodAllowed(c, 'GET', '/anything')).toBe(true);
  });
  it('is look-up only when it names nowhere', () => {
    for (const c of [yc(undefined), yc([]), yc(['../account', 'account', '/a?b', '/a%2e', 42])])
      expect(methodAllowed(c, 'POST', '/account')).toBe(false);
  });
  it('asks again when a place is added, not when nothing changed', () => {
    expect(fingerprint(yc(undefined))).toBe('youcoded');
    expect(fingerprint(yc(['/b', '/a']))).toBe(fingerprint(yc(['/a', '/b'])));
    expect(fingerprint(yc(['/a']))).not.toBe(fingerprint(yc(['/a', '/b'])));
  });
});

// Page start session (spec 2026-10-14): a page may open the new-conversation
// window with a message waiting. It reaches no address, so it has no settings,
// its approval is keyed to the declaration alone, and it is never part of the
// whole-internet mixing rule.
describe('a page that may open a new conversation', () => {
  const session = { id: 'start-session', kind: 'session' };
  it('parses with no settings, whatever else the manifest wrote on it', () => {
    expect(parseConnections([{ ...session, address: 'evil.example', prompt: 'x' }])).toEqual([{ id: 'start-session', kind: 'session' }]);
  });
  it('is approved against the declaration alone', () => {
    expect(fingerprint(parseConnections([session])[0])).toBe('session');
    expect(fingerprint(parseConnections([{ ...session, id: 'renamed' }])[0])).toBe('session');
  });
  it('reaches no address, and allows no request', () => {
    const c = parseConnections([session])[0];
    expect(covers(c, 'api.youcoded.ai')).toBe(false);
    expect(covers(c, new URL('https://example.com/'))).toBe(false);
    expect(methodAllowed(c, 'GET')).toBe(false);
  });
  it('is not a credential, so it sits beside the whole internet', () => {
    expect(parseConnections([{ id: 'o', kind: 'open' }, session])).toHaveLength(2);
  });
  it('is kept once per page', () => {
    expect(parseConnections([session, { ...session, id: 'again' }])).toHaveLength(1);
  });
});

// Pages read and change chats, and run programs (spec 2026-10-16). Two things are pinned: a line the parser
// cannot vouch for is DROPPED (never widened — a typo in a scope must not read as "every chat"), and the
// fingerprint moves exactly when what the person approved would change.
describe('a page that reads chats', () => {
  const chats = { id: 'chats', kind: 'chats' };

  it('takes every chat by default and reads look-up only', () => {
    expect(parseConnections([chats])).toEqual([{ id: 'chats', kind: 'chats', access: 'lookup', scope: { all: true } }]);
    expect(parseConnections([{ ...chats, scope: 'all', access: 'full' }])).toEqual([{ id: 'chats', kind: 'chats', access: 'full', scope: { all: true } }]);
  });

  it('keeps a named list of projects or one tag', () => {
    expect(parseConnections([{ ...chats, scope: { projects: ['Lab', ' Notes ', 'Lab'] } }])[0]).toMatchObject({ scope: { projects: ['Lab', 'Notes'] } });
    expect(parseConnections([{ ...chats, scope: { tag: ' Work ' } }])[0]).toMatchObject({ scope: { tag: 'Work' } });
  });

  it('drops a scope it cannot vouch for rather than widening it to every chat', () => {
    for (const scope of ['everything', 7, {}, { projects: [] }, { projects: [3] }, { projects: ['x'.repeat(81)] }, { tag: '' }, { tag: 4 }, { projects: Array.from({ length: 11 }, (_, i) => `p${i}`) }]) {
      expect(parseConnections([{ ...chats, scope }]), JSON.stringify(scope)).toEqual([]);
    }
  });

  it('is one line per page', () => {
    expect(parseConnections([chats, { ...chats, id: 'again', scope: { tag: 'x' } }])).toHaveLength(1);
  });

  it('is private like a sign-in: the whole list is dropped when it also asks for the whole internet', () => {
    expect(parseConnections([chats, { id: 'o', kind: 'open' }])).toEqual([]);
    expect(parseConnections([{ id: 'o', kind: 'open' }, chats])).toEqual([]);
  });

  it('is asked again when the access or the scope widens, not when the id or the order changes', () => {
    const fp = (o: object) => fingerprint(parseConnections([{ ...chats, ...o }])[0]);
    expect(fp({ access: 'full' })).not.toBe(fp({ access: 'lookup' }));
    expect(fp({ scope: { tag: 'a' } })).not.toBe(fp({ scope: { tag: 'b' } }));
    expect(fp({ scope: { projects: ['A'] } })).not.toBe(fp({ scope: { projects: ['A', 'B'] } }));
    expect(fp({ scope: { projects: ['A', 'B'] } })).toBe(fp({ scope: { projects: ['B', 'A'] } }));
    expect(fp({ id: 'renamed' })).toBe(fp({}));
  });

  it('reaches no address and sends no request', () => {
    const c = parseConnections([chats])[0];
    expect(covers(c, 'api.github.com')).toBe(false);
    expect(methodAllowed(c, 'GET')).toBe(false);
  });
});

describe('a page that runs a program', () => {
  const program = { id: 'work', kind: 'program', file: 'work-items.mjs' };

  it('names one file in its own folder', () => {
    expect(parseConnections([program])).toEqual([{ id: 'work', kind: 'program', file: 'work-items.mjs' }]);
    expect(parseConnections([{ ...program, file: 'sync_all-2.py' }])).toHaveLength(1);
  });

  it('refuses folders, parent paths, hidden files, the page\'s own files and nothing', () => {
    for (const file of ['sub/run.mjs', '../run.mjs', '..', '.hidden.mjs', '', ' ', 'a b.mjs', 'page.html', 'PAGE.JSON', 'data.json', 'x'.repeat(81), 7, null, 'a\\b.sh', '/etc/passwd']) {
      expect(parseConnections([{ ...program, file }]), String(file)).toEqual([]);
    }
  });

  it('allows several different programs but not the same one twice', () => {
    expect(parseConnections([program, { ...program, id: 'b', file: 'other.sh' }])).toHaveLength(2);
    expect(parseConnections([program, { ...program, id: 'b' }])).toHaveLength(1);
  });

  it('is asked again for a different file, not for a renamed id', () => {
    const fp = (o: object) => fingerprint(parseConnections([{ ...program, ...o }])[0]);
    expect(fp({ file: 'other.mjs' })).not.toBe(fp({}));
    expect(fp({ id: 'renamed' })).toBe(fp({}));
  });

  it('reaches no address and may combine with the whole internet (it holds nothing private)', () => {
    const c = parseConnections([program])[0];
    expect(covers(c, 'example.com')).toBe(false);
    expect(methodAllowed(c, 'POST')).toBe(false);
    expect(parseConnections([program, { id: 'o', kind: 'open' }])).toHaveLength(2);
  });
});

describe('service recipes in a manifest', () => {
  const base = { id: 'k', kind: 'key', service: 'Todoist', address: 'api.todoist.com', access: 'full' };
  const allow = [{ method: 'get', path: '/rest/v2/tasks/', does: 'See your tasks' }, { method: 'POST', path: '/rest/v2/tasks', does: 'Add tasks' }];

  it('keeps an allow list, and its fingerprint names what is allowed but not the words', () => {
    const [c] = parseConnections([{ ...base, allow }]);
    expect(c).toMatchObject({ allow: [{ method: 'GET', path: '/rest/v2/tasks' }, { method: 'POST', path: '/rest/v2/tasks' }] });
    expect(fingerprint(c)).toBe('key|Todoist|api.todoist.com|full|allow:GET /rest/v2/tasks,POST /rest/v2/tasks');
    const [reworded] = parseConnections([{ ...base, allow: allow.map((r) => ({ ...r, does: 'Something else' })) }]);
    expect(fingerprint(reworded)).toBe(fingerprint(c));
  });

  it('drops the whole line when any allow entry is invalid', () => {
    for (const bad of [
      [{ method: 'GET', path: '/a/../b', does: 'x' }], [{ method: 'TRACE', path: '/a', does: 'x' }],
      [{ method: 'GET', path: '/a?b=1', does: 'x' }], [{ method: 'GET', path: '/a', does: '' }], [],
    ]) expect(parseConnections([{ ...base, allow: bad }]), JSON.stringify(bad)).toEqual([]);
  });

  it('keeps a Basic sign-in only with both halves, and pins where each part goes', () => {
    const parts = [{ id: 'user', label: 'Email', in: 'basic-user' }, { id: 'pass', label: 'Password', in: 'basic-password', secret: true }];
    const [c] = parseConnections([{ ...base, parts }]);
    expect(fingerprint(c)).toBe('key|Todoist|api.todoist.com|full|parts:pass:basic-password,user:basic-user');
    expect(parseConnections([{ ...base, parts: [parts[0], { id: 'x', label: 'X', in: 'header', param: 'X-Key' }] }])).toEqual([]);
    expect(parseConnections([{ ...base, parts: [parts[0], parts[0]] }])).toEqual([]);
  });

  it('lets a recipe decide methods instead of the general access word', () => {
    const [c] = parseConnections([{ ...base, access: 'lookup', allow: [{ method: 'POST', path: '/rest/v2/tasks', does: 'Add tasks' }] }]);
    expect(methodAllowed(c, 'POST', '/rest/v2/tasks/1')).toBe(true);
    expect(methodAllowed(c, 'GET', '/rest/v2/tasks')).toBe(false);
  });
});


describe('a saved multi-part sign-in', () => {
  const parts = [{ id: 'user', label: 'Email', in: 'basic-user' }, { id: 'pass', label: 'Password', in: 'basic-password' }];
  const [line] = parseConnections([{ id: 'k', kind: 'key', service: 'Cal', address: 'cal.example.com', access: 'full', parts }]);
  const value = JSON.stringify({ user: 'me@example.com', pass: 'secret-pass' });
  const storeWith = (record: object) => ({ savedKey: async () => ({ secretRef: 'r', in: 'header' as const, param: 'authorization', scheme: 'none' as const, ...record }), keyValue: async () => value });

  it('is sent as Basic only to a line with the same layout it was saved for', async () => {
    const same = await kindOf(line).credential(line, { store: storeWith({ parts: [{ id: 'user', in: 'basic-user' }, { id: 'pass', in: 'basic-password' }] }) });
    expect(same).toMatchObject({ in: 'multi', headers: { authorization: `Basic ${Buffer.from('me@example.com:secret-pass').toString('base64')}` } });
    expect(await kindOf(line).credential(line, { store: storeWith({}) })).toBeNull();
    expect(await kindOf(line).credential(line, { store: storeWith({ parts: [{ id: 'user', in: 'header', param: 'x-user' }, { id: 'pass', in: 'basic-password' }] }) })).toBeNull();
  });

  it('is never sent as a plain key by a line without parts', async () => {
    const [plain] = parseConnections([{ id: 'k', kind: 'key', service: 'Cal', address: 'cal.example.com' }]);
    expect(await kindOf(plain).credential(plain, { store: storeWith({ parts: [{ id: 'user', in: 'basic-user' }] }) })).toBeNull();
  });
});
