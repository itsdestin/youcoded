import { describe, expect, it } from 'vitest';
import { planFetch } from '../../scripts/fetch-office.mjs';

// Pins the fetch-vs-skip decision fetch-office.mjs makes at dev/build time, without touching
// the network: office comes down as a real tar.gz (~104MB) that a unit test should never fetch.
const pin = {
  version: '0.1.0',
  platforms: {
    'linux-x64': {
      url: 'https://example.invalid/youcoded-office-0.1.0-linux-x64.tar.gz',
      sha256: 'a'.repeat(64),
    },
  },
};

describe('planFetch', () => {
  it('skips when the installed manifest already matches the pinned version', () => {
    const manifest = { version: '0.1.0' };
    expect(planFetch(pin, manifest, 'linux-x64')).toEqual({ action: 'skip' });
  });

  it('downloads the pinned url and checksum when no manifest is present', () => {
    expect(planFetch(pin, null, 'linux-x64')).toEqual({
      action: 'download',
      url: pin.platforms['linux-x64'].url,
      sha256: pin.platforms['linux-x64'].sha256,
    });
  });

  it('downloads again when the installed manifest is an older version', () => {
    const manifest = { version: '0.0.9' };
    expect(planFetch(pin, manifest, 'linux-x64')).toEqual({
      action: 'download',
      url: pin.platforms['linux-x64'].url,
      sha256: pin.platforms['linux-x64'].sha256,
    });
  });

  it('reports unsupported for a platform key with no pinned bundle', () => {
    expect(planFetch(pin, null, 'win-x64')).toEqual({ action: 'unsupported' });
  });

  it('reports unsupported when there is no platform key at all', () => {
    expect(planFetch(pin, null, null)).toEqual({ action: 'unsupported' });
  });
});
