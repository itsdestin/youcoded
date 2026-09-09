import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');

describe('appearance broadcasts', () => {
  test('include Buddy floater windows when a theme changes', () => {
    const relay = mainSource.match(
      /ipcMain\.on\(IPC\.APPEARANCE_BROADCAST,[\s\S]*?\n  \}\);/,
    )?.[0] ?? '';

    expect(relay).toContain('BrowserWindow.getAllWindows()');
    expect(relay).toContain('IPC.APPEARANCE_SYNC');
  });
});
