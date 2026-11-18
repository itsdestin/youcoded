// Backup fixes 2026-11-18: "Sign in again" repairs the SAME Google Drive connection (item 4), and the phone
// never runs the install script (item 2). A stand-in `rclone` (and `bash`) on PATH records what is run, so no real
// Google login, no real rclone configuration and no install is ever touched.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { authGdrive, installRclone } from '../src/main/sync-setup-handlers';
import { setRunningOnPhone } from '../src/main/backup-platform';

let dir: string;
let log: string;
const realPath = process.env.PATH;

// The stand-in keeps its "remotes" in a text file, one name per line. `config create`/`update` succeed unless
// STUB_FAIL is set; `config delete` removes a line.
const RCLONE = `#!/bin/sh
echo "$@" >> "$STUB_LOG"
case "$1" in
  listremotes) while read -r n; do [ -n "$n" ] && echo "$n:"; done < "$STUB_REMOTES"; exit 0 ;;
  config)
    case "$2" in
      show) echo "type = drive"; exit 0 ;;
      create) echo "$3" >> "$STUB_REMOTES"; [ -n "$STUB_FAIL" ] && { echo "sign-in failed" >&2; exit 1; }; exit 0 ;;
      update) [ -n "$STUB_FAIL" ] && { echo "sign-in failed" >&2; exit 1; }; exit 0 ;;
      delete) grep -vx "$3" "$STUB_REMOTES" > "$STUB_REMOTES.new"; mv "$STUB_REMOTES.new" "$STUB_REMOTES"; exit 0 ;;
    esac ;;
esac
exit 0
`;

const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
const remotes = () => fs.readFileSync(path.join(dir, 'remotes'), 'utf8').split('\n').filter(Boolean);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdrive-stub-'));
  log = path.join(dir, 'calls.log');
  fs.mkdirSync(path.join(dir, 'bin'));
  for (const name of ['rclone', 'bash']) {
    fs.writeFileSync(path.join(dir, 'bin', name), name === 'rclone' ? RCLONE : '#!/bin/sh\necho "bash $@" >> "$STUB_LOG"\nexit 0\n', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(dir, 'remotes'), 'gdrive\n');
  process.env.PATH = `${path.join(dir, 'bin')}${path.delimiter}${realPath}`;
  process.env.STUB_LOG = log;
  process.env.STUB_REMOTES = path.join(dir, 'remotes');
  delete process.env.STUB_FAIL;
});
afterEach(() => {
  process.env.PATH = realPath;
  delete process.env.STUB_LOG; delete process.env.STUB_REMOTES; delete process.env.STUB_FAIL;
  setRunningOnPhone(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('authGdrive', () => {
  it('without an existing connection named, a second sign-in still makes a second connection (the "add another account" path)', async () => {
    const r = await authGdrive();
    expect(r).toMatchObject({ success: true, remoteName: 'gdrive' }); // the first drive remote it finds, as before
    expect(lines()).toContain('config create gdrive2 drive');
  });

  it('re-authorises the SAME connection when told which one — never creates gdrive2', async () => {
    const r = await authGdrive('gdrive');
    expect(r).toEqual({ success: true, remoteName: 'gdrive' });
    expect(lines()).toContain('config update gdrive');
    expect(lines().some((l) => l.startsWith('config create'))).toBe(false);
    expect(remotes()).toEqual(['gdrive']);
  });

  it('a failed re-authorisation leaves the connection exactly as it was', async () => {
    process.env.STUB_FAIL = '1';
    const r = await authGdrive('gdrive');
    expect(r.success).toBe(false);
    expect(r.remoteName).toBe('gdrive');
    expect(remotes()).toEqual(['gdrive']);
    expect(lines().some((l) => l.startsWith('config delete'))).toBe(false);
  });

  it('when the connection is gone entirely, makes it again under the SAME name', async () => {
    fs.writeFileSync(path.join(dir, 'remotes'), 'other\n');
    const r = await authGdrive('gdrive');
    expect(r.success).toBe(true);
    expect(lines()).toContain('config create gdrive drive');
    expect(lines().some((l) => l.includes('gdrive2'))).toBe(false);
  });

  it('and if that fresh sign-in fails, removes the empty connection it just made', async () => {
    fs.writeFileSync(path.join(dir, 'remotes'), 'other\n');
    process.env.STUB_FAIL = '1';
    const r = await authGdrive('gdrive');
    expect(r.success).toBe(false);
    expect(remotes()).toEqual(['other']);
  });

  it('refuses a name that is not a plain connection name (it becomes a command argument)', async () => {
    const r = await authGdrive('--config=/etc/passwd');
    expect(r.success).toBe(false);
    expect(lines()).toEqual([]);
  });
});

describe('installRclone on a phone', () => {
  it('refuses instead of running the install script, and says it in plain words', async () => {
    setRunningOnPhone(true);
    const r = await installRclone();
    expect(r.success).toBe(false);
    expect(r.error).toBe("Google Drive backup isn't available on this phone.");
    expect(lines()).toEqual([]); // neither bash nor curl was started
  });
});
