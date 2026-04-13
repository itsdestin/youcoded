import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Stable hash of a local theme's content (manifest + assets), used to detect
 * drift between a published theme and its local source. Hashes:
 *   - manifest.json with the `contentHash`, `source`, and `basePath` fields stripped
 *     (those fields are ephemeral / not part of the published payload)
 *   - all files under assets/, in sorted-path order
 *
 * preview.png is intentionally excluded — CI regenerates it, so including it
 * would make every published theme appear "drifted".
 */
export async function computeThemeContentHash(themeDir: string): Promise<string> {
  const hash = crypto.createHash('sha256');

  // Manifest, with non-publishable fields stripped
  const manifestRaw = await fs.promises.readFile(path.join(themeDir, 'manifest.json'), 'utf-8');
  const manifest = JSON.parse(manifestRaw);
  delete manifest.contentHash;
  delete manifest.source;
  delete manifest.basePath;
  hash.update('manifest:');
  hash.update(JSON.stringify(manifest, Object.keys(manifest).sort()));

  // Assets — recursive walk, sorted paths
  const assetsDir = path.join(themeDir, 'assets');
  if (fs.existsSync(assetsDir)) {
    const files = await walk(assetsDir);
    files.sort();
    for (const abs of files) {
      const rel = path.relative(themeDir, abs).replace(/\\/g, '/');
      const data = await fs.promises.readFile(abs);
      hash.update(`asset:${rel}:${data.length}:`);
      hash.update(data);
    }
  }

  return `sha256:${hash.digest('hex')}`;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}
