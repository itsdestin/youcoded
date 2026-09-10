import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { hasFeatureName, remoteUnsupportedMessage } from '../src/renderer/remote-unsupported';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const server = read('../src/main/remote-server.ts');
const shim = read('../src/renderer/remote-shim.ts');
const classifier = read('../src/renderer/hooks/useAttentionClassifier.ts');
const themeCtx = read('../src/renderer/state/theme-context.tsx');
const index = read('../src/renderer/index.tsx');

/**
 * Three things Destin hit the first time a phone actually connected to a computer through
 * this app (2026-09-10). Everything before that point was tests and screenshots.
 */
describe('a phone is never shown a channel id', () => {
  it('says nothing at all rather than reading an unnamed channel out loud', () => {
    // What he saw: "terminal:get-screen-text isn't available via remote access yet."
    // flashed and vanished. It named an internal channel, to someone who does not write
    // code, about a poll he never asked for.
    expect(hasFeatureName('definitely:not-a-real-namespace')).toBe(false);
    expect(shim).toContain('if (!hasFeatureName(channel)) {');
    // ...and the developer still finds out, in the console rather than on his screen.
    expect(shim).toMatch(/console\.warn\(`\[remote-shim\] not available over remote access \(unnamed\)/);
  });

  it('names the terminal, for anything that still reaches this path', () => {
    expect(hasFeatureName('terminal:get-screen-text')).toBe(true);
    expect(remoteUnsupportedMessage('terminal:get-screen-text'))
      .toBe("The terminal isn't available via remote access yet.");
  });

  it('does not poll the host for terminal text from a browser at all', () => {
    // The root cause, and a documented invariant: `.claude/rules/react-renderer.md` says a
    // remote browser takes attention from status:data's attentionMap and must not run its
    // own classifier. It was running, once a second, for the life of every connection.
    expect(classifier).toContain("import { isRemoteMode } from '../platform';");
    expect(classifier).toMatch(/const hasBuffer = \(provider === undefined \|\| provider === 'claude'\) && !isRemoteMode\(\);/);
  });
});

describe('connecting a phone does not open with a list of what is broken', () => {
  it('the app\u2019s own boot fetches are recorded, not announced', () => {
    // Ten of these fired the moment a phone connected: skills, commands, themes, the
    // marketplace, project files, presence — every one a fetch the app makes on mount,
    // none of them asked for, none actionable. The person had not looked at anything yet.
    expect(shim).toContain('const BOOT_QUIET_MS = 4000;');
    expect(shim).toContain('if (connectedAt === 0 || Date.now() - connectedAt < BOOT_QUIET_MS) return;');
    // Measured from a real connection, not from page load: a slow first hop would
    // otherwise spend the quiet window waiting to connect.
    expect(shim).toMatch(/setConnectionState\('connected'\);\s*\n\s*markConnectedForNotices\(\);/);
  });

  it('several at once become one sentence, not a flicker of half-read ones', () => {
    const notice = read('../src/renderer/components/RemoteUnsupportedNotice.tsx');
    expect(notice).toContain('if (prev && prev.feature !== detail.feature)');
    expect(notice).toContain('setAlso(list =>');
  });
});

describe('a computer with no password says so before asking for one', () => {
  it('the host answers what it needs, without authentication and without saying more', () => {
    expect(server).toContain("=== '/remote-state'");
    expect(server).toContain('needsSetup: !this.config.passwordHash');
    // Exactly one fact. Not the device list, not the session count, not the port's history.
    const arm = server.slice(server.indexOf("=== '/remote-state'"));
    expect(arm.slice(0, 400)).not.toMatch(/deviceStore|getDeviceList|sessions/);
  });

  it('the sign-in screen asks first, and offers no box when there is nothing to type', () => {
    expect(index).toContain("fetch('/remote-state'");
    expect(index).toContain('if (needsSetup) {');
    expect(index).toContain('This computer has no remote access password yet.');
    // An older host has no such endpoint; the screen must keep working as it did.
    expect(index).toMatch(/\.catch\(\(\) => \{\}\)/);
  });
});

describe('a phone paired to this computer looks like this computer', () => {
  it('the host will hand over a theme definition, read-only and path-guarded', () => {
    // The phone already learned WHICH theme (appearance:get was bridged); it could not
    // find out what the name meant, so a community theme fell back to a built-in.
    expect(server).toContain("case 'theme:read-file': {");
    expect(server).toContain("if (!/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/.test(slug))");
    expect(server).toContain("if (!manifestPath.startsWith(THEMES_DIR + path.sep))");
    // Reading only. Writing a theme stays desktop-only like every other host change.
    expect(server).not.toContain("case 'theme:write-file'");
  });

  it('takes the colours and leaves the wallpaper behind', () => {
    // A theme's background files live on the computer that owns them, so their paths mean
    // nothing in a phone browser. Dropping `background` also zeroes the glass knobs.
    expect(themeCtx).toMatch(/isRemoteMode\(\) \? \{ \.\.\.activeTheme, background: undefined \}/);
  });
});
