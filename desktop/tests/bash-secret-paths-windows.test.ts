import { describe, it, expect, vi } from 'vitest';
// Windows spells paths with `\`; the glob check once compared that against a
// `/` pattern and never matched, so `cat .env*` ran unasked on Windows only.
// Its own file because vi.mock swaps `path` for win32 file-wide — this lets
// Linux and macOS CI catch a Windows-only regression too.
vi.mock('path', async () => { const p: any = await vi.importActual('path'); return { ...p.win32, default: p.win32 }; });
vi.mock('os', async () => { const o: any = await vi.importActual('os'); return { ...o, homedir: () => 'C:\\Users\\me', default: { ...o, homedir: () => 'C:\\Users\\me' } }; });
import { secretPathVerdict } from '../src/main/harness/tools/bash-secret-paths';
const ctx = { cwd: 'C:\\Users\\me\\proj', home: 'C:\\Users\\me' };
describe('win glob', () => {
  it.each(['cat .env*', 'cat .e?v', 'cat ~/.ss*/id_rsa', 'cat .en[v]'])('%s', (cmd) => {
    expect(secretPathVerdict(cmd, ctx)?.kind).toBe('secret-maybe');
  });
  it.each(['cat *.ts', 'rm -rf *'])('%s quiet', (cmd) => { expect(secretPathVerdict(cmd, ctx)).toBeNull(); });
});
