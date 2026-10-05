// Every task's design options, by task name (see types.ts).
import type { HomeVariant, HomeVariants } from './types';
import { VARIANTS as look } from './look';
import { VARIANTS as motionNav } from './motion-nav';
import { VARIANTS as motionState } from './motion-state';
import { VARIANTS as edit } from './edit';
import { VARIANTS as audit } from './audit';
import { VARIANTS as tvRemote } from './tv-remote';
import { VARIANTS as lightsTab } from './lights-tab';
import { VARIANTS as mediaTab } from './media-tab';
import { VARIANTS as pageBg } from './page-bg';

const HOME_VARIANT_TASKS: Record<string, HomeVariants> = {
  look, 'motion-nav': motionNav, 'motion-state': motionState, edit, audit,
  'tv-remote': tvRemote, 'lights-tab': lightsTab, 'media-tab': mediaTab,
  'page-bg': pageBg,
};

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
