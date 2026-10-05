// One design option for the Home page, shown in the practice app only
// (`?pagesHome=v-<task>-<key>`). A redesign helper adds options as ONE task
// file in this folder (registered in registry.ts) and never edits the page
// itself while designing, so several can work at once (2026-10-04 redesign
// plan). The chosen option is built into the real page afterwards, and its
// task file is deleted (WHY: the 2026-10-04 round's files were removed at merge prep).
export interface HomeVariant {
  /** A few words naming the option, shown in screen lists. */
  label: string;
  /** Extra CSS appended after the page's own styles. */
  css?: string;
  /** Extra script run after the page's own script (plain ES5, no backticks). */
  js?: string;
  /** Rewrites the page's HTML before it loads — for changes CSS/JS on top
   *  cannot make (e.g. replacing a function in the page's script by text). */
  transform?: (html: string) => string;
  /** The page's saved data to start from (open cards, edit mode, a view…). */
  data?: Record<string, unknown>;
  /** Looks the same at rest as another screen (motion-only options), and why. */
  sameAs?: { name: string; why: string };
}
export type HomeVariants = Record<string, HomeVariant>;
