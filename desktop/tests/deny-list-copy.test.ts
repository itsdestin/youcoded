// Pins the full-auto safety-stop copy (spec 2026-08-12, M5 2b): every
// DESTRUCTIVE_DENY_LIST family maps to its header + consequence clause, and
// anything unclassifiable degrades to the generic pair rather than inventing
// a consequence.
import { describe, it, expect } from 'vitest';
import { fullAutoStopCopy } from '../src/renderer/components/permissions/deny-list-copy';

describe('fullAutoStopCopy', () => {
  it('classifies each family, compounds included', () => {
    expect(fullAutoStopCopy('rm -rf build').header).toMatch(/deleting/i);
    expect(fullAutoStopCopy('cd repo && rm -rf build').header).toMatch(/deleting/i);
    expect(fullAutoStopCopy('rmdir old').header).toMatch(/deleting/i);
    expect(fullAutoStopCopy('del out.txt').header).toMatch(/deleting/i);
    expect(fullAutoStopCopy('git push origin master').header).toMatch(/pushing/i);
    expect(fullAutoStopCopy('git reset --hard HEAD~1').header).toMatch(/undoing/i);
    expect(fullAutoStopCopy('sudo systemctl restart nginx').header).toMatch(/admin/i);
    expect(fullAutoStopCopy('format D:').header).toMatch(/formatting/i);
  });

  it('builds the settled subline with the family clause', () => {
    expect(fullAutoStopCopy('git push origin master').subline).toMatch(/published code/i);
    expect(fullAutoStopCopy('rm -rf build').subline).toMatch(/removes files/i);
  });

  it('falls back when the command is unclassifiable or absent', () => {
    // A missing command (never expected, but the type allows it) must not crash the card.
    const r = fullAutoStopCopy(undefined);
    expect(r.header).toMatch(/risky/i);
    // The generic pair must not claim a specific consequence.
    expect(r.subline).not.toMatch(/published|removes|undo|admin|format/i);
  });
});

describe('fullAutoStopCopy for a floor below the rules', () => {
  it('uses the floor when the deny-list has no family for the command', () => {
    expect(fullAutoStopCopy('cat .env', 'secret-path').header).toMatch(/secret/i);
    expect(fullAutoStopCopy('Remove-Item -Recurse C:\\Windows', 'removal').header).toMatch(/deleting/i);
  });
  it('a deny-list family still wins, since it names what the command does', () => {
    expect(fullAutoStopCopy('sudo cat /root/.ssh/id_rsa', 'secret-path').header).toMatch(/admin/i);
  });
});
