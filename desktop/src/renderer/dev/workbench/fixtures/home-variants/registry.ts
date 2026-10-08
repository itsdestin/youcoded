// Every task's design options, by task name (see types.ts).
// To add a task: create <task>.ts exporting `VARIANTS: HomeVariants`, import it here and add `'<task>': imported` to the map below.
// (Task files are removed once their choice is built: the 2026-10-04 round at merge prep, scenes on 2026-10-07; they are in git history.)
import type { HomeVariant, HomeVariants } from './types';

const HOME_VARIANT_TASKS: Record<string, HomeVariants> = {};

/** Every option with its screen key "<task>-<key>". */
export function homeVariantEntries(): Array<[string, HomeVariant]> {
  return Object.entries(HOME_VARIANT_TASKS).flatMap(([t, vs]) => Object.entries(vs).map(([k, v]) => [`${t}-${k}`, v] as [string, HomeVariant]));
}

export function findHomeVariant(id: string): HomeVariant | null {
  for (const [t, vs] of Object.entries(HOME_VARIANT_TASKS)) {
    if (id.startsWith(t + '-') && vs[id.slice(t.length + 1)]) return vs[id.slice(t.length + 1)];
  }
  return null;
}

/** The page's HTML with one option applied: its rewrite, its CSS after the
 *  page's styles, its script after the page's script. */
export function withHomeVariant(html: string, v: HomeVariant): string {
  let out = v.transform ? v.transform(html) : html;
  if (v.css) out = out.replace('</head>', '<style>' + v.css + '</style></head>');
  if (v.js) out = out.replace(/<\/body>(?![\s\S]*<\/body>)/, '<script>' + v.js + '</script></body>');
  return out;
}
