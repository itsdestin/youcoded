// The Mesh off switch: ONE function answering "is the mesh on for this process" (design 7.2).
//
// DEFAULT OFF. Nothing in main/mesh/ may start, create a file, or open a socket unless this says yes.
//
// Two ways to turn it on, both explicit and both read from THIS process's own profile only:
//  1. A per-profile file `<userData>/mesh-switch.json` containing exactly {"enabled": true}. This is the
//     setting a later release flips (design 7.2); the test rig writes it into each device's home before boot.
//  2. The environment variable YOUCODED_MESH=1, for dev and test instances ONLY. WHY ignored in a packaged
//     build: an inherited variable in someone's shell must never switch on a feature that rewrites chat files
//     inside the app they actually use; a packaged build needs the file, which only a deliberate act creates.
//
// TEST MODE (YOUCODED_MESH_TEST=1, never in a packaged build, and only when the mesh is on) unlocks the two
// things that are unsafe outside a rig: the insecure plaintext key file and the loopback control server.
//
// WHY the file is read asynchronously and never created: main-process rule (no blocking calls), and "off" must
// leave the profile folder byte-for-byte as it was, so this module only ever READS.
import fs from 'fs';
import path from 'path';
import { OFFICIAL_BUILD } from '../official-build';

export interface MeshSwitchInput {
  /** The app's own data folder (app.getPath('userData')). The only place the file is looked for. */
  userData: string;
  env?: NodeJS.ProcessEnv;
  /** app.isPackaged. A packaged build ignores the environment variable and refuses test mode. */
  packaged?: boolean;
}
export interface MeshSwitch {
  on: boolean;
  testMode: boolean;
}

export const MESH_SWITCH_FILE = 'mesh-switch.json';
const OFF: MeshSwitch = { on: false, testMode: false };

async function fileSaysOn(userData: string): Promise<boolean> {
  try {
    const text = await fs.promises.readFile(path.join(userData, MESH_SWITCH_FILE), 'utf8');
    // Strictly `true`: "yes", 1 or a typo does not count (a switch that fails closed).
    return (JSON.parse(text) as { enabled?: unknown } | null)?.enabled === true;
  } catch {
    return false; // missing, unreadable or not JSON: off
  }
}

export async function meshSwitch(input: MeshSwitchInput): Promise<MeshSwitch> {
  const env = input.env ?? process.env;
  // WHY OFFICIAL_BUILD joins `packaged` (review finding 9): the headless boot (the phone's path) is never "packaged", so environment variables could
  // turn the mesh and test mode on there. The release workflows stamp OFFICIAL_BUILD = true into every shipped build (desktop and Android),
  // so a release behaves as packaged on EVERY boot path; only an unstamped dev or test build can read the test variables.
  const packaged = input.packaged === true || OFFICIAL_BUILD;
  if (!input.userData) return OFF;
  const envOn = !packaged && env.YOUCODED_MESH === '1';
  const on = envOn || (await fileSaysOn(input.userData));
  if (!on) return OFF;
  return { on: true, testMode: !packaged && env.YOUCODED_MESH_TEST === '1' };
}

/** The single yes/no the rest of the code asks. */
export async function isMeshOn(input: MeshSwitchInput): Promise<boolean> {
  return (await meshSwitch(input)).on;
}
