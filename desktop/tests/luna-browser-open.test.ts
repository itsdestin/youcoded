import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { openLunaAuthBrowser } from '../src/main/providers/luna-browser-open';

describe('isolated Luna browser handoff', () => {
  it('uses the installed browser with normal home while keeping model guard and private XDG out of its environment', async () => {
    const calls: Array<{ binary: string; args: string[]; options: any }> = [];
    const launch = (binary: string, args: string[], options: any) => {
      calls.push({ binary, args, options });
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    };
    const url = 'https://auth.openai.com/oauth/authorize?state=SYNTHETIC';
    await openLunaAuthBrowser(url, '/home/test-browser', {
      launch: launch as any,
      env: { HOME: '/private/home', XDG_CONFIG_HOME: '/private/config', XDG_DATA_HOME: '/private/data',
        XDG_CACHE_HOME: '/private/cache', LUNA_GUARD_URL: 'http://127.0.0.1:1234', YOUCODED_LUNA_EXPERIMENT: '1' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].binary).toBe('/usr/bin/google-chrome-stable');
    expect(calls[0].args).toEqual([url]);
    expect(calls[0].options.shell).not.toBe(true);
    expect(calls[0].options.env.HOME).toBe('/home/test-browser');
    expect(calls[0].options.env.XDG_CONFIG_HOME).toBeUndefined();
    expect(calls[0].options.env.LUNA_GUARD_URL).toBeUndefined();
  });

  it('refuses any other URL or missing browser home before launching', async () => {
    const launch = () => { throw new Error('must not launch'); };
    await expect(openLunaAuthBrowser('https://example.com/oauth/authorize', '/home/test-browser', { launch: launch as any })).rejects.toThrow(/authorization/);
    await expect(openLunaAuthBrowser('https://auth.openai.com/oauth/authorize?state=x', '', { launch: launch as any })).rejects.toThrow(/home/);
  });
});
