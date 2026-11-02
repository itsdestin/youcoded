// "Always allow" on a file edit: this one file, or every file directly in its folder
// (Destin's review deck 2026-11-01, Q-3).
//
// WHY in shared/: the card shows the choices, main stores the rule, the engine decides with it —
// the same three-readers reason as bash-grant-shapes.ts. One definition of "which folder" and
// "does this file sit directly in it".
//
// WHAT a folder rule covers: files DIRECTLY in that folder (not sub-folders), for Edit and Write.
// WHAT it can never cover, because those checks run BEFORE any saved rule is consulted
// (harness-session.ts step 3, tools/guards.ts checkPathGuard): password / key / credential files
// (denied outright), files outside the project (always ask), and files that follow a link out of
// the project. The saved-permissions / hooks floor (tools/protected-config.ts) also still asks.
// So this module only has to answer one narrow question: "is this path directly inside that folder".
import type { PermissionRule } from './permission-types';

type EditGrantScope = 'exact' | 'folder';

export interface EditGrantChoice {
  scope: EditGrantScope;
  label: string;
  limits: string;
}

/** The tools whose approvals mean "change a file". Edit and Write travel together: a folder grant that let
 *  the assistant edit but not create files would ask again for the first new file, which is the annoyance it removes. */
const FILE_EDIT_TOOLS: readonly string[] = ['Edit', 'Write'];
export function isFileEditTool(tool: string | undefined): boolean {
  return tool !== undefined && FILE_EDIT_TOOLS.includes(tool);
}

/** `a\b/./c.ts` → `a/b/c.ts`; an absolute path inside `cwd` becomes relative to it. null when the path is anything
 *  but a plain file path inside the project (a `..` step, outside the project, a folder, empty). */
export function projectRelativePath(subject: string, cwd?: string): string | null {
  if (typeof subject !== 'string' || subject === '' || /[\u0000-\u001f]/.test(subject)) return null;
  let p = subject.replace(/\\/g, '/');
  if (p.endsWith('/')) return null;
  if (/^(?:[A-Za-z]:)?\//.test(p)) {
    if (!cwd) return null;
    const c = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!p.startsWith(c + '/')) return null;
    p = p.slice(c.length + 1);
  }
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0 || segments.some((s) => s === '..')) return null;
  return segments.join('/');
}

/** The folder a file sits directly in, project-relative: 'src/ui' or '.' for the project folder. null = not derivable. */
export function projectRelativeFolder(subject: string, cwd?: string): string | null {
  const rel = projectRelativePath(subject, cwd);
  if (rel === null) return null;
  const i = rel.lastIndexOf('/');
  return i === -1 ? '.' : rel.slice(0, i);
}

/** The engine's question for a `folder` rule: is this file directly in the saved folder? */
export function folderRuleCovers(pattern: string | undefined, subject: string, cwd?: string): boolean {
  return pattern !== undefined && projectRelativeFolder(subject, cwd) === pattern;
}

/** Edit/Write rules a "files in this folder" choice stores — or null when the folder cannot be derived. */
export function folderRulesFor(subject: string, cwd?: string): PermissionRule[] | null {
  const folder = projectRelativeFolder(subject, cwd);
  if (folder === null) return null;
  return FILE_EDIT_TOOLS.map((tool) => ({ tool, pattern: folder, action: 'allow', match: 'folder' }) as PermissionRule);
}

/** How the card names the folder: the typed folder as the assistant wrote it, or the project folder. */
function folderDisplay(subject: string): string {
  const p = subject.replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  if (i <= 0) return i === 0 ? '/' : 'the project folder';
  return p.slice(0, i);
}

const FOLDER_LIMITS =
  "Covers editing and creating files directly in this folder. Doesn't cover sub-folders, password and key files, or files outside this project.";
const FILE_LIMITS = "Only this file. A new file, or a different one, will ask again.";

/** The choices the confirm shows under "Always allow" on an edit, narrowest first. Empty when the path cannot be
 *  judged (then the plain, single "Always allow" behaves as it always did: this exact file). */
export function editGrantChoices(subject: string | undefined): EditGrantChoice[] {
  if (typeof subject !== 'string' || subject === '') return [];
  const folder = folderDisplay(subject);
  return [
    { scope: 'exact', label: 'Only this file', limits: FILE_LIMITS },
    { scope: 'folder', label: `Files in ${folder === 'the project folder' ? 'the project folder' : folder}`, limits: FOLDER_LIMITS },
  ];
}
