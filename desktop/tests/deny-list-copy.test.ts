// Pins the full-auto safety-stop copy (spec 2026-08-12, M5 2b): every
// DESTRUCTIVE_DENY_LIST family maps to its header + consequence clause, and
// anything unclassifiable degrades to the generic pair rather than inventing
// a consequence.
import { describe, it, expect } from 'vitest';
import { fullAutoStopCopy } from '../src/renderer/components/permissions/deny-list-copy';

describe('fullAutoStopCopy', () => {
  it('classifies each family, compounds included', () => {
    expect(fullAutoStopCopy('rm -rf build').header).toBe('Stopped before deleting files');
    expect(fullAutoStopCopy('cd repo && rm -rf build').header).toBe('Stopped before deleting files');
    expect(fullAutoStopCopy('rmdir old').header).toBe('Stopped before deleting files');
    expect(fullAutoStopCopy('del out.txt').header).toBe('Stopped before deleting files');
    expect(fullAutoStopCopy('git push origin master').header).toBe('Stopped before pushing code');
    expect(fullAutoStopCopy('git reset --hard HEAD~1').header).toBe('Stopped before undoing commits');
    expect(fullAutoStopCopy('sudo systemctl restart nginx').header).toBe('Stopped before an admin command');
    expect(fullAutoStopCopy('format D:').header).toBe('Stopped before formatting a drive');
  });

  it('builds the settled subline with the family clause', () => {
    expect(fullAutoStopCopy('git push origin master').subline).toBe(
      'Full auto still stops here — this changes your published code.',
    );
    expect(fullAutoStopCopy('rm -rf build').subline).toBe(
      'Full auto still stops here — this permanently removes files.',
    );
  });

  it('falls back when the command is unclassifiable or absent', () => {
    // A missing command (never expected, but the type allows it) must not crash the card.
    expect(fullAutoStopCopy(undefined)).toEqual({
      header: 'Stopped before a risky command',
      subline: 'Full auto still stops here.',
    });
  });
});

describe('fullAutoStopCopy for a floor below the rules', () => {
  it('uses the floor when the deny-list has no family for the command', () => {
    expect(fullAutoStopCopy('cat .env', 'secret-path').header).toBe('Stopped before using a secret file');
    expect(fullAutoStopCopy('Remove-Item -Recurse C:\\Windows', 'removal').header).toBe('Stopped before deleting files');
  });
  it('a deny-list family still wins, since it names what the command does', () => {
    expect(fullAutoStopCopy('sudo cat /root/.ssh/id_rsa', 'secret-path').header).toBe('Stopped before an admin command');
  });
});
