import fs from 'fs';
import path from 'path';

/**
 * Migrates bare <slug>.json files in the themes directory to folder format:
 *   <slug>.json → <slug>/manifest.json + <slug>/assets/
 * Returns the number of files migrated.
 */
export function migrateBarJsonFiles(themesDir: string): number {
  if (!fs.existsSync(themesDir)) return 0;

  const entries = fs.readdirSync(themesDir);
  let count = 0;

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const fullPath = path.join(themesDir, entry);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;

    const slug = entry.replace(/\.json$/, '');
    const folderPath = path.join(themesDir, slug);

    // Skip if folder already exists (already migrated or name collision)
    if (fs.existsSync(folderPath)) continue;

    // Create folder structure
    fs.mkdirSync(folderPath, { recursive: true });
    fs.mkdirSync(path.join(folderPath, 'assets'), { recursive: true });

    // Move JSON into folder as manifest.json
    fs.renameSync(fullPath, path.join(folderPath, 'manifest.json'));
    count++;
  }

  return count;
}
