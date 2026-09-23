// The manifest is written by an assistant or a stranger, and what it says is
// what the approval screen promises — so these pin the refusals.
import { describe, expect, it } from 'vitest';
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
