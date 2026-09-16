import fs from 'fs';
import { listPastSessions } from './session-browser';
import { ccProjectSlug } from './slug-encoding';
import type { PastSession } from '../shared/types';

// WHY: listPastSessions is global. Project View needs just this project's
// sessions, so filter by the same slug CC uses for the project directory.
// Cheap enough that the hero can call it on every project switch.
//
// Rows used to carry a one-line `preview` (the first prompt, from a head read
// of every transcript). Destin removed that line from the cards on 2026-09-16
// ("we don't show it in the resume browser"), so nothing reads the file here.
export async function listProjectConversations(projectPath: string): Promise<PastSession[]> {
  // CC slugs realpath(cwd) (see slug-encoding.ts fixture "symlink resolves to
  // realpath"). Resolve the same way, falling back exactly as CC's Px() does,
  // so a symlinked project folder finds CC's real directory.
  let resolved: string;
  try { resolved = fs.realpathSync.native(projectPath); } catch { resolved = projectPath; }
  const slug = ccProjectSlug(resolved);
  const all = await listPastSessions();
  return all.filter((s) => s.projectSlug === slug);
}
