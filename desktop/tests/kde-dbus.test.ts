import { describe, it, expect } from 'vitest';
import { qdbusStdoutFailure, parseSupportInformation } from '../src/main/kde-dbus';

// Pure halves only — the subprocess half (qdbusPath/kdeCall/execQdbus) follows
// this codebase's untested-side-effect pattern for child_process call sites.
// The two things that CAN silently break are both here: deciding that a
// zero-exit run actually failed, and reading KWin's version out of a block that
// contains a decoy.

describe('qdbusStdoutFailure', () => {
  it('flags the struct complaint qdbus6 writes to STDOUT at exit 0', () => {
    // Measured 2026-09-04, verbatim. A wrapper that trusts the exit code hands
    // this sentence to a number parser and quietly places the buddy on top of
    // the user's taskbar.
    const stdout = "qdbus: I don't know how to display an argument of type '(iiii)', run with --literal.\n";
    expect(qdbusStdoutFailure(stdout)).toBe(
      "qdbus: I don't know how to display an argument of type '(iiii)', run with --literal.",
    );
  });

  it('flags the qdbus6-named variant of the same complaint', () => {
    expect(qdbusStdoutFailure("qdbus6: something went wrong\n")).toBe('qdbus6: something went wrong');
  });

  it('flags a DBus transport error printed to stdout', () => {
    const stdout = 'Error: org.freedesktop.DBus.Error.ServiceUnknown\nThe name is not provided\n';
    expect(qdbusStdoutFailure(stdout)).toBe('Error: org.freedesktop.DBus.Error.ServiceUnknown');
  });

  it('flags empty and whitespace-only stdout', () => {
    expect(qdbusStdoutFailure('')).toBe('the DBus call returned no output');
    expect(qdbusStdoutFailure('   \n\t\n')).toBe('the DBus call returned no output');
  });

  it('passes a real answer through', () => {
    expect(qdbusStdoutFailure('[Argument: (iiii) 0, 0, 1707, 1015]\n')).toBeNull();
    expect(qdbusStdoutFailure('true\n')).toBeNull();
  });
});

// Trimmed from the real org.kde.KWin.supportInformation() output on KWin 6.7.3
// (captured 2026-09-04). The "Version / =======" header two lines above the
// real field is the decoy R3-F10 is about — it is kept here on purpose.
const SUPPORT_INFO = [
  'KWin Support Information:',
  'The following information should be used when requesting support.',
  '',
  '==========================',
  '',
  'Version',
  '=======',
  'KWin version: 6.7.3',
  'Qt Version: 6.11.1',
  '',
  'Operation Mode: Wayland',
  '',
  'Build Options',
  '=============',
  'KWIN_BUILD_DECORATIONS: yes',
  '',
  'Screens',
  '=======',
  'Number of Screens: 2',
  '',
  'Screen 0:',
  '---------',
  'Name: eDP-1',
  'Enabled: 1',
  'Geometry: 0,0,1707x1067',
  'Physical size: 288x180mm',
  'Scale: 1.5',
  'Refresh Rate: 180000',
  '',
  'Screen 1:',
  '---------',
  'Name: HDMI-A-1',
  'Enabled: 0',
  'Geometry: 1707,0,1920x1080',
  'Physical size: 600x340mm',
  'Scale: 1',
  '',
  'Compositing',
  '===========',
  'Compositing is active',
  'Name: not-a-screen',
].join('\n');

describe('parseSupportInformation', () => {
  it('reads the version from "KWin version:", not from the "Version" section header', () => {
    const session = parseSupportInformation(SUPPORT_INFO);
    expect(session?.kwinMajor).toBe(6);
  });

  it('reads the session type from Operation Mode', () => {
    expect(parseSupportInformation(SUPPORT_INFO)?.wayland).toBe(true);
    expect(parseSupportInformation(SUPPORT_INFO.replace('Operation Mode: Wayland', 'Operation Mode: X11'))?.wayland)
      .toBe(false);
  });

  it('returns null when there is no KWin version line at all (not a KWin reply)', () => {
    expect(parseSupportInformation('')).toBeNull();
    expect(parseSupportInformation('Version\n=======\nQt Version: 6.11.1\n')).toBeNull();
  });

  it('parses every screen with its name, enabled flag, geometry and scale', () => {
    const screens = parseSupportInformation(SUPPORT_INFO)?.screens ?? [];
    expect(screens).toEqual([
      { name: 'eDP-1', enabled: true, bounds: { x: 0, y: 0, width: 1707, height: 1067 }, scale: 1.5 },
      { name: 'HDMI-A-1', enabled: false, bounds: { x: 1707, y: 0, width: 1920, height: 1080 }, scale: 1 },
    ]);
  });

  it('stops at the next section, so a "Name:" outside the Screens block is not a screen', () => {
    const names = (parseSupportInformation(SUPPORT_INFO)?.screens ?? []).map((s) => s.name);
    expect(names).not.toContain('not-a-screen');
  });

  it('treats a missing Enabled field as enabled rather than silently dropping the screen', () => {
    const text = SUPPORT_INFO.replace('Enabled: 1\n', '');
    const eDP = parseSupportInformation(text)?.screens.find((s) => s.name === 'eDP-1');
    expect(eDP?.enabled).toBe(true);
  });

  it('skips a screen with no name or no parseable geometry', () => {
    const text = SUPPORT_INFO.replace('Geometry: 0,0,1707x1067', 'Geometry: unavailable');
    const names = (parseSupportInformation(text)?.screens ?? []).map((s) => s.name);
    expect(names).toEqual(['HDMI-A-1']);
  });

  it('survives a reply with no Screens section', () => {
    const session = parseSupportInformation('Version\n=======\nKWin version: 6.7.3\n');
    expect(session).toEqual({ kwinMajor: 6, wayland: false, screens: [] });
  });

  it('reports a Plasma 5 KWin honestly rather than rounding it up', () => {
    expect(parseSupportInformation('KWin version: 5.27.11\nOperation Mode: X11\n')?.kwinMajor).toBe(5);
  });
});
