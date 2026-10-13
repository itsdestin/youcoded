import { describe, it, expect, vi } from 'vitest';

// WHY: Windows draws YouCoded's taskbar button from its shortcut, and caches shortcut icons by
// file path — so each different theme icon must land at its own path, and we must only ever
// rewrite shortcuts that launch this app (windows-taskbar-icon.ts, brand round 32).
vi.mock('electron', () => ({ app: {}, shell: {} }));
import { taskbarIconName, isOurShortcut } from '../src/main/windows-taskbar-icon';

describe('Windows taskbar icon', () => {
  it('names the copied icon by its contents: same picture → same name, new picture → new name', () => {
    const a = taskbarIconName(Buffer.from('golden')), b = taskbarIconName(Buffer.from('golden')), c = taskbarIconName(Buffer.from('kuromi'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^theme-[0-9a-f]{16}\.ico$/);
  });
  it('only treats shortcuts to this exact app as ours', () => {
    const exe = 'C:\\Users\\Me\\AppData\\Local\\Programs\\youcoded\\YouCoded.exe';
    expect(isOurShortcut(exe.toLowerCase(), exe)).toBe(true);
    expect(isOurShortcut('C:\\Program Files\\Other\\Other.exe', exe)).toBe(false);
    expect(isOurShortcut(undefined, exe)).toBe(false);
  });
});
