import { describe, it, expect } from 'vitest';
import { adminRuleFor, hasAdminApproval } from '../src/shared/admin-approval';
import { applyAdminApproval } from '../src/main/harness/admin-approval';
import type { PermissionRule } from '../src/shared/permission-types';

const command = 'sudo systemctl restart example';
describe('admin approval rules', () => {
  it('stores exact commands literally and stores no session-only rule', () => {
    expect(adminRuleFor('command', command)).toEqual({ tool: 'Bash', pattern: command, action: 'allow', match: 'exact' });
    expect(adminRuleFor('session', command)).toBeNull();
    expect(hasAdminApproval([adminRuleFor('command', 'sudo rm *.tmp')!], 'sudo rm other.tmp', 'full-auto')).toBe(false);
    expect(hasAdminApproval([adminRuleFor('command', command)!], command, 'ask')).toBe(true);
    expect(hasAdminApproval([adminRuleFor('command', command)!], command + ' && echo extra', 'full-auto')).toBe(false);
  });
  it('uses the saved broad consent only in Full Auto', () => {
    const rules = [adminRuleFor('full-auto', command)!];
    expect(hasAdminApproval(rules, 'sudo another-command', 'full-auto')).toBe(true);
    expect(hasAdminApproval(rules, command, 'ask')).toBe(false);
    expect(hasAdminApproval(rules, command, 'auto-edit')).toBe(false);
  });
  it('does not mistake ordinary Bash rules or malformed admin grants for admin consent', () => {
    const rules: PermissionRule[] = [{ tool: '*', action: 'allow' }, { tool: 'Bash', action: 'allow' },
      { tool: 'Bash', pattern: '*', action: 'allow', match: 'glob' }, { tool: 'AdminFullAuto', action: 'deny' }];
    expect(hasAdminApproval(rules, command, 'full-auto')).toBe(false);
  });
  it.each([
    'sudo true;rm -rf build', 'sudo true&&rm -rf build', 'sudo true\nrm -rf build',
    'sudo true|rm -rf build', 'sudo true;git push origin main',
    '/usr/bin/sudo true;rm -rf build', 'sudo /usr/bin/rm -rf build',
    'sudo env /usr/bin/git push origin main', "sudo sh -c 'true;rm -rf build'",
    'sudo echo $(rm -rf build)', 'sudo true||rm -rf build', 'sudo true&rm -rf build',
    'sudo /usr/bin/git -C repo push origin main',
    'sudo /usr/bin/git --git-dir .git reset --hard',
    'sudo find . -exec /bin/rm -rf {} \\;', "sudo node -e 'process.exit(0)'",
    `sudo node -e"require('fs').rmSync('build',{recursive:true,force:true})"`,
    `sudo /usr/bin/node --eval="require('fs').rmSync('build',{recursive:true,force:true})"`,
    `sudo python3 -c"import shutil;shutil.rmtree('build')"`,
    "sudo bash -c'echo hidden'", 'sudo node script.js', 'sudo bash install.sh',
    `sudo python3.11 -c"import shutil;shutil.rmtree('build')"`,
    `sudo nodejs -e"require('fs').rmSync('build',{recursive:true,force:true})"`,
  ])('never lets a broad admin grant waive another action in %s', command => {
    for (const action of ['allow', 'ask'] as const) {
      expect(applyAdminApproval({ action, denyListed: action === 'ask' }, command, true).action).toBe('ask');
    }
  });
  it('allows simple sudo wrappers and literal operator text without treating arguments as shell commands', () => {
    const ask = { action: 'ask' as const, denyListed: true };
    expect(applyAdminApproval(ask, '/usr/bin/sudo /usr/bin/systemctl status example', true).action).toBe('allow');
    expect(applyAdminApproval(ask, "sudo echo 'literal;not-a-command'", true).action).toBe('allow');
  });
  it.each(['sudo true;rm -rf build', `sudo node -e"require('fs').rmSync('build',{recursive:true,force:true})"`])('still honors explicitly approved exact command %s, but never an explicit deny', command => {
    const exact = { action: 'allow' as const, denyListed: false, passwordlessAdminExact: true };
    expect(applyAdminApproval(exact, command, true).action).toBe('allow');
    expect(applyAdminApproval({ ...exact, action: 'deny' }, command, true).action).toBe('deny');
  });
  it('removes only the admin approval toll, never a deny or another dangerous action', () => {
    const ask = { action: 'ask' as const, denyListed: true };
    expect(applyAdminApproval(ask, command, true).action).toBe('allow');
    expect(applyAdminApproval(ask, command, false)).toEqual(ask);
    const deny = { action: 'deny' as const, denyListed: false, message: 'not allowed' };
    expect(applyAdminApproval(deny, command, true)).toEqual(deny);
    for (const dangerous of ['sudo rm -rf build', 'sudo git push origin main', 'sudo true && git reset --hard']) {
      expect(applyAdminApproval(ask, dangerous, true).action).toBe('ask');
    }
  });
});
