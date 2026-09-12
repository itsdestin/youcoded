// Destin, 2026-09-11: "still flashes the password screen at me on refresh/reconnect and takes a while
// to load back in". The dev window served the phone a copy of the app built the night before
// (dist/renderer, left by an Android test build): the remote server serves a built copy whenever one
// exists, so none of the day's phone-side fixes reached the phone. In development the phone now gets
// live code unless a fresh copy was asked for (run-dev.sh --phone-build), and the log says which.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { choosePhonePageSource } from '../src/main/remote-server';

describe('which copy of the app a phone is served', () => {
  it('the installed app serves its built copy', () => {
    expect(choosePhonePageSource({ serveBuiltPage: true, hasBuild: true })).toBe('built');
  });

  it('a dev window serves live code even when an old built copy is on disk', () => {
    expect(choosePhonePageSource({ serveBuiltPage: false, hasBuild: true })).toBe('dev-server');
  });

  it('asked for a built copy that does not exist, it serves live code rather than nothing', () => {
    expect(choosePhonePageSource({ serveBuiltPage: true, hasBuild: false })).toBe('dev-server');
  });

  it('main.ts serves the built copy only when packaged or when run-dev.sh built one', () => {
    const main = readFileSync(resolve(__dirname, '../src/main/main.ts'), 'utf8');
    expect(main).toContain("serveBuiltPage: app.isPackaged || process.env.YOUCODED_REMOTE_BUILT === '1'");
  });
});
