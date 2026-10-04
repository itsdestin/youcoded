// The editors' own settings, remembered between documents (finish plan Task 4).
// Kept in <userData>/office-editor-settings.json as { settings: { key: value } }.
//
// WHY this exists: each document opens on its own one-time office://<token> origin, so the
// editor's localStorage — where web-apps keeps File → Advanced settings and its view toggles —
// starts empty every time, and a choice lasted only while that one document was open. The add-on
// now sends each change here (yc-bridge.js → save_editor_settings) and seeds the saved ones into
// the next editor page before any editor code reads them (yc-early.js ← office://<token>/yc-settings.json).
//
// WHY an allow-list, checked on the way in AND on the way out: localStorage on that origin can
// hold anything the page writes. Only the keys below — settings a person chose, nothing about the
// document, nobody's name, no recent lists — may reach disk, and a hand-edited file still only
// hands back allowed keys. One flat list serves all three editors: web-apps prefixes each key
// with its editor (de- Word, sse- Excel, pe- PowerPoint), so the kinds never collide.
import path from 'node:path';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import { promises as fsp } from 'node:fs';
import { log } from '../logger';

const FILE = 'office-editor-settings.json';
const target = (userData: string) => path.join(userData, FILE);

// Keys every editor writes under its own prefix (web-apps app.js/code.js, euro-office-lite
// v0.17.21, read from the installed bundle: Common.localStorage.setItem/setBool call sites).
const SHARED = [
  // File → Advanced settings
  'settings-unit', 'settings-zoom', 'last-zoom', 'settings-fontrender', 'settings-paste-button',
  'settings-show-alt-hints', 'settings-spellcheck', 'spellcheck-ignore-numbers-words',
  'spellcheck-ignore-uppercase-words', 'settings-livecomment', 'settings-resolvedcomment',
  'settings-review-hover-mode', 'settings-datetime-default',
  // AutoCorrect options (the on/off choices only — its word lists are typed text, left out)
  'settings-autoformat-bulleted', 'settings-autoformat-double-space', 'settings-autoformat-fl-cells',
  'settings-autoformat-fl-sentence', 'settings-autoformat-hyperlink', 'settings-autoformat-hyphens',
  'settings-autoformat-numbered', 'settings-autoformat-smart-quotes', 'settings-autoformat-new-rows',
  'settings-letter-exception-cells', 'settings-letter-exception-sentence', 'settings-math-correct-replace-type',
  'equation-input-latex',
  // View toggles and layout
  'compact-toolbar', 'view-compact-toolbar', 'hidden-status', 'hidden-leftmenu', 'hidden-rightmenu',
  'mainmenu-width', 'rightmenu-width', 'comments-sort', 'review-mode', 'review-mode-editor',
  'quick-access-save', 'quick-access-print', 'quick-access-quick-print', 'quick-access-undo',
  'quick-access-redo', 'quick-access-start-over',
  // "Don't show again" on the editor's own warnings
  'hide-copywarning', 'hide-quick-print-warning',
];
const ONE_EDITOR = [
  // Word
  'de-settings-smart-selection', 'de-settings-compatible', 'de-settings-numeral', 'de-settings-western-font-size',
  'de-show-hiddenchars', 'de-show-tableline', 'de-zoom-multipage', 'de-outline-wrap', 'de-outline-fontsize',
  'de-hide-save-compatible',
  // Excel
  'sse-settings-r1c1', 'sse-settings-func-locale', 'sse-settings-decimal-separator', 'sse-settings-group-separator',
  'sse-settings-use-base-separator', 'sse-settings-reg-settings', 'sse-settings-def-sheet-rtl',
  'sse-settings-function-tooltip', 'sse-settings-smooth-scroll', 'sse-spellcheck-locale', 'sse-hidden-formula',
  'sse-freeze-shadow', 'sse-compact-statusbar', 'sse-celleditor-expand', 'sse-hide-sheet-view-tip',
  // PowerPoint
  'pe-settings-showgrid', 'pe-settings-showguides', 'pe-settings-showsnaplines', 'pe-hidden-notes', 'pe-settings-shaperatio',
  // All editors (no prefix)
  'app-settings-screen-reader',
];
// Deliberately NOT here: ui-theme / ui-theme-id / content-theme / settings-tab-* (YouCoded sets
// the editor's look; the Interface-theme row is hidden — yc-bridge.js), *-hidden-rulers (slim
// mode decides, yc-bridge.js setRulers), *-settings-autosave / forcesave / coauthmode / cachemode
// (YouCoded owns saving), *-macros-* (macros are off in YouCoded, build/patch.mjs), guest-id /
// guest-username (identity), and every recent list (fonts, symbols, shapes, list formats).
const ALLOWED: ReadonlySet<string> = new Set([
  ...['de-', 'sse-', 'pe-'].flatMap((p) => SHARED.map((k) => p + k)),
  ...ONE_EDITOR,
]);

/** WHY a length cap: every allowed setting is a number, a flag or a short code ("1033", "."). */
const MAX_VALUE = 64;

export function isEditorSettingKey(key: string): boolean {
  return ALLOWED.has(key);
}

/** The allowed part of what the frame (or the file) says: a string value sets, null forgets. */
export function cleanEditorSettings(v: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!ALLOWED.has(k)) continue;
    if (val === null || (typeof val === 'string' && val.length <= MAX_VALUE)) out[k] = val;
  }
  return out;
}

function parse(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  try {
    const all = cleanEditorSettings((JSON.parse(raw) as { settings?: unknown })?.settings);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(all)) if (v !== null) out[k] = v;
    return out;
  } catch {
    // WHY start over rather than fail: an unreadable file must never stop a document opening.
    // The next change replaces it.
    return {};
  }
}

/** The remembered settings (allowed keys only). Never throws: no file means none yet. */
export async function readEditorSettings(userData: string): Promise<Record<string, string>> {
  try {
    return parse(await fsp.readFile(target(userData), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') log('WARN', 'Office', 'editor settings could not be read', { code: (e as NodeJS.ErrnoException)?.code ?? null });
    return {};
  }
}

// WHY one save at a time in this process: several open editors can report the same toggle
// together; the lock below already keeps two processes apart, and this spares it the contention.
let queue: Promise<unknown> = Promise.resolve();

/** Merge the frame's changes (allowed keys only) into the file. Written atomically, under a lock
 *  (mutateFileUnderLock: temp file, fsync, rename), and not at all when nothing changes. */
export function saveEditorSettings(userData: string, changes: unknown): Promise<void> {
  const clean = cleanEditorSettings(changes);
  if (!Object.keys(clean).length) return Promise.resolve();
  const run = queue.then(async () => {
    const done = await mutateFileUnderLock(target(userData), (raw) => {
      const now = parse(raw);
      let changed = false;
      for (const [k, v] of Object.entries(clean)) {
        if (v === null ? k in now : now[k] !== v) changed = true;
        if (v === null) delete now[k]; else now[k] = v;
      }
      return changed ? JSON.stringify({ settings: now }, null, 2) : null;
    });
    if (!done) log('WARN', 'Office', 'editor settings not saved (file busy)');
  });
  queue = run.catch(() => {});
  return run;
}
