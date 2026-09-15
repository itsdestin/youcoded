import { describe, it, expect } from 'vitest';
import { SearchService } from '../src/main/harness/search/search-service';
import { SearchBackendError, type SearchBackend } from '../src/main/harness/search/backends/types';

const R = [{ title: 'T', url: 'https://x.example', snippet: 's' }];
const chain = (entries: any[]) => ({ get: async () => entries });
const keys = (map: Record<string, string>) => ({ getKey: async (b: string) => map[b] ?? null });
const backend = (id: string, impl: SearchBackend['search']): SearchBackend => ({ id: id as any, search: impl });
const sig = () => new AbortController().signal;

describe('SearchService', () => {
  it('skips keyed entries without a key and uses the first success', async () => {
    const calls: string[] = [];
    const s = new SearchService(chain([
      { backend: 'tavily', requiresKey: true }, { backend: 'exa', requiresKey: false },
    ]) as any, keys({}) as any, {
      tavily: backend('tavily', async () => { calls.push('tavily'); return R; }),
      exa: backend('exa', async () => { calls.push('exa'); return R; }),
      ddg: backend('ddg', async () => { calls.push('ddg'); return R; }),
    });
    const out = await s.search('q', sig());
    expect(calls).toEqual(['exa']);
    expect(out.source).toBe('exa');
    expect(out.results).toEqual(R);
  });
  it('continues to keyless search when a stored key cannot be read', async () => {
    const s = new SearchService(chain([
      { backend: 'tavily', requiresKey: true }, { backend: 'ddg', requiresKey: false },
    ]), { getKey: async () => { throw new Error('Secure key storage is currently unavailable. Retry.'); } }, {
      tavily: backend('tavily', async () => { throw new Error('must not call'); }),
      exa: backend('exa', async () => R), ddg: backend('ddg', async () => R),
    });
    expect((await s.search('q', sig())).source).toBe('ddg');
  });
  it('retains a credential-read reason without claiming no API key or a network failure', async () => {
    const s = new SearchService(chain([{ backend: 'tavily', requiresKey: true }]), {
      getKey: async () => { throw new Error('Secure key storage is currently unavailable. Retry.'); },
    }, { tavily: backend('tavily', async () => R), exa: backend('exa', async () => R), ddg: backend('ddg', async () => R) });
    const error = await s.search('q', sig()).catch((e: Error) => e.message);
    expect(error).toContain('tavily: Secure key storage is currently unavailable. Retry.');
    expect(error).not.toContain('no API key configured');
    expect(error).not.toContain('Could not reach the service');
  });

  it('falls through on backend failure and reports the winning source', async () => {
    const s = new SearchService(chain([
      { backend: 'exa', requiresKey: false }, { backend: 'ddg', requiresKey: false },
    ]) as any, keys({}) as any, {
      exa: backend('exa', async () => { throw new SearchBackendError('per-IP limit reached'); }),
      ddg: backend('ddg', async () => R),
      tavily: backend('tavily', async () => R),
    });
    expect((await s.search('q', sig())).source).toBe('ddg');
  });
  it('exhaustion → SearchUnavailable with per-backend reasons AND the add-a-key hint', async () => {
    const s = new SearchService(chain([
      { backend: 'exa', requiresKey: false }, { backend: 'ddg', requiresKey: false },
    ]) as any, keys({}) as any, {
      exa: backend('exa', async () => { throw new SearchBackendError('per-IP limit reached'); }),
      ddg: backend('ddg', async () => { throw new SearchBackendError('DuckDuckGo is rate-limiting requests from this network right now.', true); }),
      tavily: backend('tavily', async () => R),
    });
    await expect(s.search('q', sig())).rejects.toThrow(/per-IP limit.*rate-limiting.*add.*key/is);
  });
  it('passes the stored key to keyed backends', async () => {
    let seenKey: string | null = 'unset' as any;
    const s = new SearchService(chain([{ backend: 'tavily', requiresKey: true }]) as any, keys({ tavily: 'tvly-9' }) as any, {
      tavily: backend('tavily', async (_q, o) => { seenKey = o.key; return R; }),
      exa: backend('exa', async () => R), ddg: backend('ddg', async () => R),
    });
    await s.search('q', sig());
    expect(seenKey).toBe('tvly-9');
  });
  it('a backend returning [] (no throw) is skipped and the chain continues to the next', async () => {
    const calls: string[] = [];
    const s = new SearchService(chain([
      { backend: 'exa', requiresKey: false }, { backend: 'ddg', requiresKey: false },
    ]) as any, keys({}) as any, {
      exa: backend('exa', async () => { calls.push('exa'); return []; }),
      ddg: backend('ddg', async () => { calls.push('ddg'); return R; }),
      tavily: backend('tavily', async () => R),
    });
    const out = await s.search('q', sig());
    expect(calls).toEqual(['exa', 'ddg']);
    expect(out.source).toBe('ddg');
  });
  it('ALL backends returning [] → SearchUnavailable (no silent empty)', async () => {
    const s = new SearchService(chain([
      { backend: 'exa', requiresKey: false }, { backend: 'ddg', requiresKey: false },
    ]) as any, keys({}) as any, {
      exa: backend('exa', async () => []),
      ddg: backend('ddg', async () => []),
      tavily: backend('tavily', async () => R),
    });
    await expect(s.search('q', sig())).rejects.toThrow(/unavailable/i);
  });
  it('a pre-aborted user signal REJECTS with the abort, NOT SearchUnavailable', async () => {
    const ac = new AbortController();
    ac.abort();
    const s = new SearchService(chain([{ backend: 'exa', requiresKey: false }]) as any, keys({}) as any, {
      // The backend contract: honor the signal and throw an AbortError.
      exa: backend('exa', async () => { throw new DOMException('The operation was aborted.', 'AbortError'); }),
      ddg: backend('ddg', async () => R), tavily: backend('tavily', async () => R),
    });
    await expect(s.search('q', ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('mid-backend abort REJECTS with the abort, does not fall through to the next backend', async () => {
    const ac = new AbortController();
    const calls: string[] = [];
    const s = new SearchService(chain([
      { backend: 'exa', requiresKey: false }, { backend: 'ddg', requiresKey: false },
    ]) as any, keys({}) as any, {
      exa: backend('exa', async () => { calls.push('exa'); ac.abort(); throw new DOMException('aborted', 'AbortError'); }),
      ddg: backend('ddg', async () => { calls.push('ddg'); return R; }),
      tavily: backend('tavily', async () => R),
    });
    await expect(s.search('q', ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual(['exa']); // did NOT fall through to ddg
  });
  it('exhaustion WITH a key present → "may be temporary" hint, not the add-a-key hint', async () => {
    const s = new SearchService(chain([{ backend: 'tavily', requiresKey: true }]) as any, keys({ tavily: 'k' }) as any, {
      tavily: backend('tavily', async () => { throw new SearchBackendError('tavily is down'); }),
      exa: backend('exa', async () => R), ddg: backend('ddg', async () => R),
    });
    await expect(s.search('q', sig())).rejects.toThrow(/may be temporary/i);
    await expect(s.search('q', sig())).rejects.not.toThrow(/add a free/i);
  });
  it('an unknown backend in the chain → clean failure message, no TypeError', async () => {
    const s = new SearchService(chain([
      { backend: 'brave', requiresKey: false }, { backend: 'ddg', requiresKey: false },
    ]) as any, keys({}) as any, {
      exa: backend('exa', async () => R),
      ddg: backend('ddg', async () => { throw new SearchBackendError('ddg down'); }),
      tavily: backend('tavily', async () => R),
    });
    // brave has no registered impl: the chain must skip it cleanly (no
    // "Cannot read properties of undefined") and report it in the failures.
    await expect(s.search('q', sig())).rejects.toThrow(/brave: no backend implementation registered/i);
  });

  describe('testBackend', () => {
    const svc = (impl: SearchBackend['search']) => new SearchService(
      chain([]) as any, keys({}) as any,
      { tavily: backend('tavily', impl), exa: backend('exa', impl), ddg: backend('ddg', impl) },
    );
    it('ok: backend returns results → { ok: true }', async () => {
      const res = await svc(async () => R).testBackend('tavily', 'k');
      expect(res.ok).toBe(true);
      expect(res.message).toMatch(/1 results/);
    });
    it('fail: backend throws → { ok: false } surfacing the real message', async () => {
      const res = await svc(async () => { throw new SearchBackendError('Tavily rejected the API key.'); }).testBackend('tavily', 'bad');
      expect(res.ok).toBe(false);
      expect(res.message).toBe('Tavily rejected the API key.');
    });
    it('unknown backend (untrusted IPC) → clean { ok: false }, no internals-leak', async () => {
      const res = await svc(async () => R).testBackend('brave' as any, 'k');
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/unknown search provider/i);
      expect(res.message).not.toMatch(/undefined|cannot read/i);
    });
  });
});
