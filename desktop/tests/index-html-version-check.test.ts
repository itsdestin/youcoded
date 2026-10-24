// @vitest-environment jsdom
// The page a phone keeps for a week (remote-static-policy) checks, once loaded from that copy, that the computer still serves the
// same version, and loads the new one once if not. Runs the real inline script from index.html against a fake browser.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(__dirname, '../src/renderer/index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('yc-page-reloaded'))!;

function page(opts: { protocol?: string; transferSize?: number; served: string | null; reloadedBefore?: string }) {
  const doc = new DOMParser().parseFromString('<script type="module" crossorigin src="./assets/index-OLD.js"></script>', 'text/html');
  const store = new Map<string, string>(opts.reloadedBefore ? [['yc-page-reloaded', opts.reloadedBefore]] : []);
  const listeners: Array<() => void> = [];
  const reload = vi.fn();
  const fetch = vi.fn(async () => (opts.served === null ? { ok: false, text: async () => '' } : { ok: true, text: async () => `<script type="module" crossorigin src="${opts.served}"></script>` }));
  const env = {
    location: { protocol: opts.protocol ?? 'http:', href: 'http://desk:9900/#x', reload },
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    performance: { getEntriesByType: () => [{ transferSize: opts.transferSize ?? 0 }] },
    document: doc,
    DOMParser,
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
    fetch,
  };
  new Function(...Object.keys(env), script)(...Object.values(env));
  return { load: async () => { listeners.forEach((fn) => fn()); await new Promise((r) => setTimeout(r, 0)); }, reload, fetch, store };
}

describe('index.html version check', () => {
  it('a kept page whose computer now serves a newer version asks for it without the cache and reloads once', async () => {
    const p = page({ served: './assets/index-NEW.js' });
    await p.load();
    expect(p.fetch).toHaveBeenCalledWith('http://desk:9900/', { cache: 'no-cache' });
    expect(p.reload).toHaveBeenCalledTimes(1);
    expect(p.store.get('yc-page-reloaded')).toBe('./assets/index-NEW.js');
  });

  it('does nothing when the version is current, the page was just fetched, it already reloaded for that version, or it came from disk', async () => {
    for (const p of [
      page({ served: './assets/index-OLD.js' }),
      page({ served: './assets/index-NEW.js', transferSize: 3000 }),
      page({ served: './assets/index-NEW.js', reloadedBefore: './assets/index-NEW.js' }),
      page({ served: null }),
      page({ served: './assets/index-NEW.js', protocol: 'file:' }),
    ]) {
      await p.load();
      expect(p.reload).not.toHaveBeenCalled();
    }
  });
});
