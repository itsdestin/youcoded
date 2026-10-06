// Workbench-only switches for the project switcher's open choices (redesign backlog row 10,
// deck project-switcher-1). Each returns the SHIPPED value outside the workbench and the
// photo-only build, so a typo or a stray param can never change the real app.
//
// WHY here and not in workbench-mode.ts (scripts/shoot/README.md "Several designs of one real
// screen" names that file): another session had uncommitted edits in it while this round was
// built, and a commit by explicit path would have swept them in. Same predicate, same rules —
// fold these into workbench-mode.ts (or delete them) once Destin picks.
import { isWorkbenchMode } from '../../workbench-mode';

function param(name: string): string | null {
  if (!isWorkbenchMode()) return null;
  return new URLSearchParams(location.search).get(name);
}

/** How the file / conversation counts show on a row. `summary` (shipped): "21 files · 5 chats"
 *  with bold numbers on the row's second line; `chips`: two fact chips there; `none`: no counts. */
type SwitcherCounts = 'summary' | 'chips' | 'none';
export function switcherCounts(): SwitcherCounts {
  const v = param('switcherCounts');
  return v === 'chips' || v === 'none' ? v : 'summary';
}

/** How the project you are in is marked. `pill` (shipped): a "Current" pill beside its name;
 *  `fill`: its row is tinted; `top`: it sits alone under "Current project", the rest below. */
type SwitcherCurrent = 'pill' | 'fill' | 'top';
export function switcherCurrent(): SwitcherCurrent {
  const v = param('switcherCurrent');
  return v === 'fill' || v === 'top' ? v : 'pill';
}

/** Where Remove lives. `icon` (shipped): a bin at the end of every row, always shown;
 *  `hover`: the same bin, shown on the row under the pointer or keyboard (always on touch). */
type SwitcherRemove = 'icon' | 'hover';
export function switcherRemove(): SwitcherRemove {
  return param('switcherRemove') === 'hover' ? 'hover' : 'icon';
}
