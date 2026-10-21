import { describe, it, expect } from 'vitest';
import { normalizeEndpoint, sameEndpoint } from '../src/shared/endpoint-address';

describe('normalizeEndpoint', () => {
  it('ignores case of the host, a trailing slash and a trailing /v1', () => {
    expect(normalizeEndpoint('https://API.InceptionLabs.ai/v1/')).toBe('https://api.inceptionlabs.ai');
    expect(normalizeEndpoint('https://api.inceptionlabs.ai')).toBe('https://api.inceptionlabs.ai');
  });
  it('keeps a meaningful path (a provider served below the root)', () => {
    expect(normalizeEndpoint('https://api.z.ai/api/paas/v4')).toBe('https://api.z.ai/api/paas/v4');
    expect(normalizeEndpoint('https://api.fireworks.ai/inference/v1/')).toBe('https://api.fireworks.ai/inference');
  });
  it('keeps the port and the scheme, so http and https are different services', () => {
    expect(normalizeEndpoint('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234');
    expect(sameEndpoint('http://api.example.com', 'https://api.example.com')).toBe(false);
  });
  it('drops a query string and fragment', () => {
    expect(normalizeEndpoint('https://api.example.com/v1?x=1#y')).toBe('https://api.example.com');
  });
  it('answers null for something that is not an http(s) address', () => {
    expect(normalizeEndpoint('')).toBeNull();
    expect(normalizeEndpoint('not a url')).toBeNull();
    expect(normalizeEndpoint('ftp://example.com')).toBeNull();
  });
  it('sameEndpoint is false when either side is not an address', () => {
    expect(sameEndpoint('not a url', 'not a url')).toBe(false);
    expect(sameEndpoint('https://a.com/v1', 'https://A.com/')).toBe(true);
  });
});
