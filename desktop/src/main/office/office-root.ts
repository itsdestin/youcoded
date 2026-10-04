import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pin from '../../../office-pin.json';

// WHY two places: packaged builds carry the add-on as an extraResource ("office"); dev runs
// use the folder scripts/fetch-office.mjs fills.
export function officeRoot(o: { packaged?: boolean; resourcesPath?: string; appPath?: string } = {}): string {
  const packaged = o.packaged ?? app.isPackaged;
  return packaged
    ? path.join(o.resourcesPath ?? process.resourcesPath, 'office')
    : path.join(o.appPath ?? app.getAppPath(), 'office-addon');
}

export async function officeAvailable(root = officeRoot()): Promise<boolean> {
  try {
    return JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')).version === pin.version;
  } catch {
    return false;
  }
}
