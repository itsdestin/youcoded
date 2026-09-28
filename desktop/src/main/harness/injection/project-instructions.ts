import { promises as fs } from 'fs';
import * as path from 'path';
import { fitProjectInstructions } from './injection-budget';

export interface ProjectInstructionFile {
  path: string;
  name: string;
  full: string;
  text: string;
  truncated: boolean;
  note?: string;
  /** A chain-wide omission notice is plain text, not a pretend file body. */
  unwrapped?: boolean;
  /** A second instructions file in the SAME folder that was not used (AGENTS.md
   *  wins over CLAUDE.md). Shown in the panel so a dropped file is never silent. */
  notUsed?: string;
}

// WHY plain words here: `note` is shown to the PERSON in the "What the assistant
// was given" panel. The bracketed notices the fitter writes are addressed to the
// model ("Read X for the rest"), so they are summarized, never copied.
const LEFT_OUT = 'Left out — too long for this model';
const SHORTENED = 'Shortened to fit this model';
function shortenedNote(fittedText: string): string {
  const outline = /(\d+) of (\d+) sections above are shown as/.exec(fittedText);
  return outline ? `${SHORTENED} · ${outline[1]} of ${outline[2]} sections shortened` : SHORTENED;
}

export function renderProjectInstructionFiles(files: readonly ProjectInstructionFile[]): string | null {
  const parts = files.filter(f => f.text).map(f => f.unwrapped
    ? f.text
    : `<project-instructions source="${files.length === 1 ? f.name : f.path}">\n${f.text}\n</project-instructions>`);
  return parts.length ? parts.join('\n\n') : null;
}

/** WHY: discovery belongs to session startup, not synchronous prompt assembly or
 * context-panel retrieval. Git boundaries do not stop instruction-file ancestry. */
export async function prepareProjectInstructions(cwd: string, budgetTokens: number, fixtureBoundary?: string): Promise<ProjectInstructionFile[]> {
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    dirs.unshift(dir);
    // Evaluator-only boundary: disposable A/B fixtures must not inherit real
    // machine instructions; production always leaves this unset.
    if (fixtureBoundary && dir === path.resolve(fixtureBoundary)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const sources: Array<{ path: string; name: string; full: string; notUsed?: string }> = [];
  const seen = new Set<string>();
  for (const folder of dirs) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = path.join(folder, name);
      let full: string;
      try { full = await fs.readFile(file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // An unreadable preferred file is not permission to silently switch sources.
        break;
      }
      // WHY: aliases through a symlink can expose the same instruction twice.
      // Canonicalize only identity, never the displayed path or the session cwd.
      let identity: string;
      try { identity = await fs.realpath(file); }
      catch { identity = file; } // If it disappeared after reading, preserve the captured text.
      if (!seen.has(identity)) {
        // WHY record it: only one file per folder is used, so a CLAUDE.md next
        // to an AGENTS.md is silently ignored unless we say so.
        const other = name === 'AGENTS.md' ? path.join(folder, 'CLAUDE.md') : null;
        const otherExists = other ? await fs.access(other).then(() => true, () => false) : false;
        sources.push({ path: file, name, full, ...(otherExists ? { notUsed: 'CLAUDE.md' } : {}) });
        seen.add(identity);
      }
      break;
    }
  }
  // WHY: account for every byte in the final part (including labels, wrappers,
  // separators and omission notices). Never print empty per-file wrappers when
  // there is no room to tell the model which sources it missed.
  const budget = Math.max(0, Math.floor(budgetTokens * 4));
  const wrappers = sources.reduce((n, s) => n + `<project-instructions source="${sources.length === 1 ? s.name : s.path}">\n\n</project-instructions>`.length, 0)
    + Math.max(0, sources.length - 1) * 2;
  const notices = sources.map(s => `[Read ${s.path}: shortened.]`);
  const omitted = (text: string | null): ProjectInstructionFile[] => sources.map((source, i) => ({
    ...source, text: i === 0 ? (text ?? '') : '', truncated: true,
    note: LEFT_OUT,
    ...(i === 0 && text ? { unwrapped: true } : {}),
  }));
  if (wrappers + notices.reduce((n, s) => n + s.length, 0) > budget) {
    const detailed = `[Project instructions omitted. Read ${sources.map(s => s.path).join(', ')}.]`;
    const brief = '[Project instructions omitted.]';
    return omitted(detailed.length <= budget ? detailed : brief.length <= budget ? brief : null);
  }
  let remaining = budget - wrappers;
  return sources.map((source, index) => {
    const reserved = notices.slice(index + 1).reduce((n, s) => n + s.length, 0);
    const share = Math.min(remaining - reserved, Math.floor((remaining - reserved) / (sources.length - index)) + notices[index].length);
    const fitted = fitProjectInstructions(source.full, Math.floor(share / 4), source.path);
    const text = fitted.text.length <= share ? fitted.text : notices[index];
    const truncated = fitted.truncated || text !== source.full;
    remaining -= text.length;
    return { ...source, text, truncated,
      ...(truncated ? { note: text === notices[index] ? LEFT_OUT : shortenedNote(text) } : {}) };
  });
}
