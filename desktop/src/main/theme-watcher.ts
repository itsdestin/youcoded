import fs from 'fs';
import path from 'path';
import os from 'os';
import type { BrowserWindow } from 'electron';
import { migrateBarJsonFiles } from './theme-migration';

const THEMES_DIR = path.join(os.homedir(), '.claude', 'destinclaude-themes');

/** Ensures themes dir exists and migrates any bare JSON files to folder format. */
function ensureAndMigrate(): void {
  if (!fs.existsSync(THEMES_DIR)) {
    fs.mkdirSync(THEMES_DIR, { recursive: true });
  }
  const count = migrateBarJsonFiles(THEMES_DIR);
  if (count > 0) {
    console.log(`[theme-watcher] Migrated ${count} bare JSON theme(s) to folder format`);
  }
}

/** Watches ~/.claude/destinclaude-themes/ for changes.
 *  Sends theme:reload to the renderer when a manifest.json or asset changes. */
export function startThemeWatcher(win: BrowserWindow): () => void {
  ensureAndMigrate();

  let watcher: fs.FSWatcher | null = null;
  const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

  try {
    watcher = fs.watch(THEMES_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      // Extract slug from path (first path component)
      const normalized = filename.replace(/\\/g, '/');
      const slug = normalized.split('/')[0];
      if (!slug) return;

      // Only reload on relevant file changes
      const ext = path.extname(normalized).toLowerCase();
      if (!['.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.css'].includes(ext)) return;

      const existing = debounceMap.get(slug);
      if (existing) clearTimeout(existing);
      debounceMap.set(slug, setTimeout(() => {
        debounceMap.delete(slug);
        if (!win.isDestroyed()) {
          win.webContents.send('theme:reload', slug);
        }
      }, 100));
    });
  } catch (err) {
    console.warn('[theme-watcher] fs.watch failed, themes will not hot-reload:', err);
  }

  return () => {
    watcher?.close();
    for (const t of debounceMap.values()) clearTimeout(t);
    debounceMap.clear();
  };
}

/** Returns list of user theme slugs (directories with manifest.json). */
export function listUserThemes(): string[] {
  try {
    return fs.readdirSync(THEMES_DIR)
      .filter(entry => {
        const entryPath = path.join(THEMES_DIR, entry);
        return fs.statSync(entryPath).isDirectory()
          && fs.existsSync(path.join(entryPath, 'manifest.json'));
      });
  } catch {
    return [];
  }
}

/** Returns absolute path to a theme's directory. */
export function userThemeDir(slug: string): string {
  return path.join(THEMES_DIR, slug);
}

/** Returns absolute path to a theme's manifest.json. */
export function userThemeManifest(slug: string): string {
  return path.join(THEMES_DIR, slug, 'manifest.json');
}

export { THEMES_DIR };
