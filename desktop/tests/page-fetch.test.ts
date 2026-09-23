// `pages:fetch` — the one door out of a page, checked in main.
//
// A page's own document cannot open a socket (its CSP takes the network away),
// so everything it wants comes through here. These pin the promise the approval
// screen makes: it reaches exactly what its approval lists, and nothing else —
// and whatever comes back never carries the key that fetched it.
import { describe, it, expect, vi } from 'vitest';
import { performPageFetch, PageRateGate, MAX_PER_PAGE_PER_MINUTE, MAX_CONCURRENT_PER_PAGE, MAX_WAITING_PER_PAGE, REDACTED, redact } from '../src/main/pages/page-fetch';
import { fingerprint, parseConnections } from '../src/main/pages/page-connections';
import type { PageConnection, PageFetchRequest } from '../src/shared/pages-types';

const KEY_VALUE = 'sk-page-secret-value';
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

const weather = parseConnections([{
  id: 'weather', kind: 'key', service: 'OpenWeather',
  address: 'api.openweathermap.org', access: 'lookup', keyIn: 'query', keyParam: 'appid',
}])[0];
const feed = parseConnections([{ id: 'feed', kind: 'public', address: 'hnrss.org' }])[0];
const openAll = parseConnections([{ id: 'open', kind: 'open' }])[0];

/** Everything approved, with the key attached the way the manifest asked. */
function ctx(connections: PageConnection[], fetchImpl: unknown, over: { approved?: Record<string, string> } = {}) {
  return {
    connections,
    approved: over.approved ?? Object.fromEntries(connections.map((c) => [c.id, fingerprint(c)])),
    credential: async (c: PageConnection) =>
      c.kind === 'key' ? ({ in: 'query', param: 'appid', value: KEY_VALUE } as const) : null,
    signal: new AbortController().signal,
    fetchImpl: fetchImpl as typeof fetch,
    lookup: publicLookup,
  };
}

const ok = (body = 'hello', init: ResponseInit = {}) => vi.fn().mockResolvedValue(new Response(body, { status: 200, ...init }));
const get = (url: string, extra: Partial<PageFetchRequest> = {}): PageFetchRequest => ({ url, ...extra });

describe('which address a page may reach', () => {
  it('matches the approved host exactly, never by suffix', async () => {
    const fetchMock = ok();
    for (const host of ['api.openweathermap.org.attacker.test', 'evil-api.openweathermap.org', 'openweathermap.org']) {
      const res = await performPageFetch(get(`https://${host}/data`), ctx([weather], fetchMock));
      expect(res, host).toMatchObject({ ok: false, reason: 'not-approved' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await performPageFetch(get('https://api.openweathermap.org/data'), ctx([weather], fetchMock))).toMatchObject({ ok: true });
  });

  it('refuses an address whose connection has not been approved yet', async () => {
    const fetchMock = ok();
    const res = await performPageFetch(get('https://hnrss.org/newest'), ctx([feed], fetchMock, { approved: {} }));
    expect(res).toMatchObject({ ok: false, reason: 'not-approved' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses once the connection has moved on from what was approved', async () => {
    const widened = parseConnections([{ ...weather, access: 'full' }])[0];
    const fetchMock = ok();
    const res = await performPageFetch(get('https://api.openweathermap.org/data'),
      ctx([widened], fetchMock, { approved: { weather: fingerprint(weather) } }));
    expect(res).toMatchObject({ ok: false, reason: 'not-approved' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses anything that is not an absolute http(s) address', async () => {
    const fetchMock = ok();
    for (const url of ['//evil.example/x', '/relative', 'file:///etc/passwd', 'not a url', '']) {
      expect(await performPageFetch(get(url), ctx([openAll], fetchMock)), url).toMatchObject({ ok: false, reason: 'bad-url' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('what a page may send', () => {
  it('holds a look-up connection to GET and HEAD', async () => {
    const fetchMock = ok();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await performPageFetch(get('https://api.openweathermap.org/data', { method }), ctx([weather], fetchMock));
      expect(res, method).toMatchObject({ ok: false, reason: 'method-not-allowed' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await performPageFetch(get('https://api.openweathermap.org/data', { method: 'head' }), ctx([weather], fetchMock))).toMatchObject({ ok: true });
  });

  it('keeps only three of the page\'s own headers, and never lets it set the credential', async () => {
    const fetchMock = ok();
    await performPageFetch(get('https://hnrss.org/newest', {
      headers: {
        Accept: 'application/json', 'Accept-Language': 'en', 'Content-Type': 'application/json',
        Authorization: 'Bearer forged', Cookie: 'a=b', 'X-Anything': 'no',
      },
    }), ctx([feed], fetchMock));
    const sent = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(sent.accept).toBe('application/json');
    expect(sent['accept-language']).toBe('en');
    expect(sent['content-type']).toBe('application/json');
    expect(sent.Authorization).toBeUndefined();
    expect(sent.authorization).toBeUndefined();
    expect(sent.Cookie).toBeUndefined();
    expect(sent['X-Anything']).toBeUndefined();
    // Replaced, not combined: only ONE spelling of accept reaches the service.
    expect(Object.keys(sent).filter((k) => k.toLowerCase() === 'accept')).toHaveLength(1);
  });

  it('attaches the key where the service takes it, and the page never chose that', async () => {
    const fetchMock = ok();
    await performPageFetch(get('https://api.openweathermap.org/data?q=London'), ctx([weather], fetchMock));
    expect(fetchMock.mock.calls[0][0]).toContain(`appid=${KEY_VALUE}`);
  });
});

describe('a redirect cannot widen the grant', () => {
  it('refuses a hop to a host the connection does not cover, and never makes the second request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://collector.test/steal' } }))
      .mockResolvedValueOnce(new Response('should never happen', { status: 200 }));
    const res = await performPageFetch(get('https://api.openweathermap.org/data'), ctx([weather], fetchMock));
    expect(res).toMatchObject({ ok: false, reason: 'not-approved' });
    expect(res).toMatchObject({ message: expect.stringContaining('collector.test') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a hop the connection does cover', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://api.openweathermap.org/v2' } }))
      .mockResolvedValueOnce(new Response('{"t":7}', { status: 200 }));
    expect(await performPageFetch(get('https://api.openweathermap.org/data'), ctx([weather], fetchMock)))
      .toMatchObject({ ok: true, status: 200, body: '{"t":7}' });
  });
});

describe('the key never comes back out', () => {
  it('is redacted from a body the service echoed it into', async () => {
    const fetchMock = ok(`{"error":"bad key ${KEY_VALUE}"}`, { headers: { 'content-type': 'application/json' } });
    const res = await performPageFetch(get('https://api.openweathermap.org/data'), ctx([weather], fetchMock));
    expect(res).toMatchObject({ ok: true });
    if (!res.ok) throw new Error('unreachable');
    expect(res.body).not.toContain(KEY_VALUE);
    expect(res.body).toContain(REDACTED);
  });

  it('is redacted from an error message', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error(`connect ECONNREFUSED https://api.openweathermap.org/?appid=${KEY_VALUE}`));
    const res = await performPageFetch(get('https://api.openweathermap.org/data'), ctx([weather], fetchMock));
    expect(res).toMatchObject({ ok: false });
    if (res.ok) throw new Error('unreachable');
    expect(res.message).not.toContain(KEY_VALUE);
  });

  it('is redacted from a response header the service reflected', async () => {
    const fetchMock = ok('hi', { headers: { etag: `W/"${KEY_VALUE}"`, 'set-cookie': 'session=abc' } });
    const res = await performPageFetch(get('https://api.openweathermap.org/data'), ctx([weather], fetchMock));
    if (!res.ok) throw new Error('unreachable');
    expect(res.headers.etag).not.toContain(KEY_VALUE);
    // Set-Cookie never reaches a page at all.
    expect(Object.keys(res.headers)).not.toContain('set-cookie');
  });

  it('redacts the percent-encoded spelling too, and leaves short strings alone', () => {
    expect(redact('a b/c+d and a b/c+d', ['a b/c+d'])).toBe(`${REDACTED} and ${REDACTED}`);
    expect(redact('the url said a%20b%2Fc%2Bd', ['a b/c+d'])).toContain(REDACTED);
    expect(redact('abc', ['abc'])).toBe('abc');
  });
});

describe('the rate cap', () => {
  it('refuses past the per-minute cap for one page, and lets another page through', async () => {
    const gate = new PageRateGate();
    const now = 1_000_000;
    for (let i = 0; i < MAX_PER_PAGE_PER_MINUTE; i++) {
      expect(await gate.acquire('personal:weather', now), `request ${i}`).toBe(true);
      gate.release('personal:weather');
    }
    expect(await gate.acquire('personal:weather', now)).toBe(false);
    expect(await gate.acquire('personal:other', now)).toBe(true);
    // A minute later the window has rolled and the page may ask again.
    expect(await gate.acquire('personal:weather', now + 60_001)).toBe(true);
  });

  it('makes requests past four at once WAIT for a slot rather than refusing them', async () => {
    const gate = new PageRateGate();
    for (let i = 0; i < MAX_CONCURRENT_PER_PAGE; i++) expect(await gate.acquire('personal:dash')).toBe(true);
    let fifthGot: boolean | null = null;
    const fifth = gate.acquire('personal:dash').then((ok) => { fifthGot = ok; });
    await Promise.resolve();
    expect(fifthGot).toBeNull();          // still waiting: four are in flight
    gate.release('personal:dash');        // one finishes…
    await fifth;
    expect(fifthGot).toBe(true);          // …and the fifth goes
  });

  it('refuses once too many are already waiting', async () => {
    const gate = new PageRateGate();
    for (let i = 0; i < MAX_CONCURRENT_PER_PAGE; i++) await gate.acquire('personal:dash');
    for (let i = 0; i < MAX_WAITING_PER_PAGE; i++) void gate.acquire('personal:dash');
    expect(await gate.acquire('personal:dash')).toBe(false);
  });
});
