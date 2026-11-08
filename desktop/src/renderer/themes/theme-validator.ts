import type { ThemeDefinition } from './theme-types';

const REQUIRED_TOKENS = [
  'canvas', 'panel', 'inset', 'well', 'accent', 'on-accent',
  'fg', 'fg-2', 'fg-dim', 'fg-muted', 'fg-faint',
  'edge', 'edge-dim', 'scrollbar-thumb', 'scrollbar-hover',
] as const;

/** Relative luminance of a hex color (0–1). */
export function luminance(hex: string): number {
  const clean = hex.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return 0; // treat unparseable as black
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const toLinear = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Returns '#FFFFFF' or '#000000' based on accent luminance. */
export function computeOnAccent(accentHex: string): '#FFFFFF' | '#000000' {
  return luminance(accentHex) < 0.179 ? '#FFFFFF' : '#000000';
}

/** Warns (non-fatal) on custom_css anti-patterns that silently hurt readability.
 *  Most common: a fixed/absolute rule at z-index 0+ rendering ABOVE chat bubbles.
 *  The old body::before/::after wallpaper+pattern template prescribed z-index: 0,
 *  which stopped being correct when the terminal switched to container-opacity
 *  (Apr 8, youcoded commit e3cc7ce2). Negative z-index is the right value now. */
function lintCustomCss(css: string | undefined, slug: string): void {
  if (!css) return;
  // Match rule blocks with position:fixed|absolute AND z-index: 0 or positive integer.
  // Deliberately loose — this is a console warn, not a reject.
  const blockRe = /\{[^}]*\}/g;
  const blocks = css.match(blockRe) ?? [];
  for (const block of blocks) {
    const hasFixedOrAbs = /position\s*:\s*(fixed|absolute)/i.test(block);
    if (!hasFixedOrAbs) continue;
    const zMatch = block.match(/z-index\s*:\s*(-?\d+)/i);
    if (!zMatch) continue;
    const z = parseInt(zMatch[1], 10);
    if (z >= 0) {
      console.warn(
        `[theme-validator] Theme "${slug}" has custom_css with position: fixed/absolute at z-index: ${z}. ` +
        `This renders above chat bubbles and hurts readability. Use z-index: -1, or better, put wallpaper/pattern in the manifest.background fields instead of custom_css.`
      );
      return; // One warning per theme is enough
    }
  }
}

/** Class names a pack's custom_css may target that the renderer actually emits.
 *  Deliberately a small allowlist of the CHAT-CHROME hooks packs are documented
 *  to style, not every class in the bundle — the point is to catch a pack aiming
 *  at a name that has never existed, not to freeze the whole DOM as public API. */
const KNOWN_THEME_HOOKS: readonly string[] = [
  'user-bubble',           // UserMessage.tsx
  'assistant-bubble',      // AssistantTurnBubble.tsx, ChatView.tsx
  'header-bar',
  'input-bar-container',
  'layer-surface',
  'layer-scrim',
  'bg-accent', 'bg-inset', 'bg-panel', 'bg-canvas', 'bg-well',
];

/** Class names shipped packs got wrong, mapped to what the renderer really uses.
 *  halftone-dimension styled `.chat-bubble.user`/`.chat-bubble.assistant` and
 *  `.send-btn` — none of which exist — so its entire bubble treatment was dead
 *  in the app while its previews implied otherwise (ROADMAP :46). */
const KNOWN_DEAD_SELECTORS: Record<string, string> = {
  'chat-bubble': '.user-bubble / .assistant-bubble',
  'send-btn': 'no equivalent — the send control carries no stable class',
};

/** Warns (non-fatal) when custom_css targets a class the renderer never emits.
 *  Such a rule is not a style bug — it is silently inert, which is worse: the
 *  pack looks styled in its preview and ships flat. Console-warn only, matching
 *  lintCustomCss's "buggy custom_css still applies" stance. */
export function lintCustomCssSelectors(css: string | undefined, slug: string): void {
  if (!css) return;
  // Strip declaration blocks so we only scan selector text (avoids matching
  // class-like fragments inside url(...) or content strings).
  const selectorText = css.replace(/\{[^}]*\}/g, ' ');
  const seen = new Set<string>();
  for (const m of selectorText.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
    const cls = m[1];
    if (seen.has(cls)) continue;
    seen.add(cls);
    const dead = KNOWN_DEAD_SELECTORS[cls];
    if (dead) {
      console.warn(
        `[theme-validator] Theme "${slug}" custom_css targets ".${cls}", which the renderer never emits — ` +
        `the rule is silently inert. Use ${dead}.`
      );
    } else if (!KNOWN_THEME_HOOKS.includes(cls)) {
      console.warn(
        `[theme-validator] Theme "${slug}" custom_css targets ".${cls}", which is not a known theming hook. ` +
        `If it is not a class the renderer emits, the rule will silently do nothing. Known hooks: ${KNOWN_THEME_HOOKS.join(', ')}.`
      );
    }
  }
}

/** Throws a descriptive error if the theme JSON is invalid. */
export function validateTheme(raw: unknown): ThemeDefinition {
  if (!raw || typeof raw !== 'object') throw new Error('Theme must be an object');
  const t = raw as Record<string, unknown>;

  if (!t.name || typeof t.name !== 'string' || !t.name.trim()) throw new Error('Theme missing required field: name');
  if (!t.slug || typeof t.slug !== 'string' || !t.slug.trim()) throw new Error('Theme missing required field: slug');
  if (typeof t.dark !== 'boolean') throw new Error('Theme missing required field: dark (boolean)');
  if (!t.tokens || typeof t.tokens !== 'object') throw new Error('Theme missing required field: tokens');

  const tokens = t.tokens as Record<string, unknown>;
  for (const key of REQUIRED_TOKENS) {
    if (!tokens[key] || typeof tokens[key] !== 'string') {
      throw new Error(`Theme tokens missing required field: ${key}`);
    }
  }

  // Validate effects consistency
  const effects = t.effects as Record<string, unknown> | undefined;
  if (effects) {
    if (effects['particle-shape'] && effects.particles !== 'custom') {
      throw new Error('particle-shape requires particles: "custom"');
    }
  }

  // Clamp radius-2xl to 36px max to prevent bubble content clipping
  const shape = t.shape as Record<string, string> | undefined;
  if (shape && shape['radius-2xl']) {
    const val = parseInt(shape['radius-2xl'], 10);
    if (!isNaN(val) && val > 36) {
      shape['radius-2xl'] = '36px';
    }
  }

  // Non-fatal lint pass — surfaces known-bad custom_css patterns in DevTools
  // without blocking theme load. Keeps the current behavior of "a theme with
  // buggy custom_css still applies," but makes the bug visible instead of silent.
  lintCustomCss(t.custom_css as string | undefined, t.slug as string);
  lintCustomCssSelectors(t.custom_css as string | undefined, t.slug as string);

  // WHY (audit SC-1): the font link becomes a remote stylesheet that styles the whole app and can change after a theme
  // was reviewed. Only Google Fonts' own stylesheet address is kept; anything else is dropped (the theme still loads,
  // with its `family` fallback fonts) — applied here so hand-installed themes get the same rule as registry ones.
  const font = t.font as Record<string, unknown> | undefined;
  if (font && font['google-font-url'] !== undefined && !isAllowedGoogleFontUrl(font['google-font-url'])) {
    console.warn(`[theme-validator] theme "${String(t.slug)}": font.google-font-url must be https://fonts.googleapis.com/css2?… — ignored`);
    delete font['google-font-url'];
  }

  return raw as ThemeDefinition;
}

// WHY a scanner instead of regexes (2026-10-30 security audit F3/SC-2): the old regex filter was beaten three ways
// — `@imp@import a;ort "https://x"` (removing the inner rule glued the outer keyword back together), `image-set("https://x" 1x)`
// (a web address in a plain string, no url()), and CSS escapes (`u\72l(`, `url(\68ttps://x)`). A browser reads escapes
// as the real characters, so this reads the stylesheet the way a browser does: it decodes escapes in names and addresses
// first, then checks what the decoded text is. Anything that could fetch from the network is blocked; theme-asset:, data:,
// blob:, #fragment and plain relative addresses stay.

/** Schemes a theme stylesheet may point at — none of these leave the computer. */
const SAFE_URL_SCHEMES = new Set(['theme-asset:', 'data:', 'blob:']);
/** CSS functions whose string arguments are addresses (besides url() itself). */
const URL_STRING_FUNCTIONS = new Set(['url', 'src', 'image', 'image-set', '-webkit-image-set', 'cross-fade', '-webkit-cross-fade']);

const isHex = (c: string) => /[0-9a-fA-F]/.test(c);
const isNameChar = (c: string) => /[A-Za-z0-9_\-]/.test(c) || c.charCodeAt(0) > 0x7f;

/** Reads one CSS escape starting at the backslash at css[i]; returns the character it stands for and the next index. */
function readEscape(css: string, i: number): { ch: string; next: number } {
  let j = i + 1;
  if (j >= css.length) return { ch: '\uFFFD', next: j };
  if (isHex(css[j])) {
    let hex = '';
    while (j < css.length && hex.length < 6 && isHex(css[j])) hex += css[j++];
    if (/[ \t\n\r\f]/.test(css[j] ?? '')) j++;   // one whitespace after a hex escape belongs to it
    const cp = parseInt(hex, 16);
    return { ch: cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(cp), next: j };
  }
  return { ch: css[j], next: j + 1 };
}

/** Reads an identifier (escapes decoded) starting at i. */
function readIdent(css: string, i: number): { name: string; next: number } {
  let name = '';
  let j = i;
  while (j < css.length) {
    if (css[j] === '\\') { const e = readEscape(css, j); name += e.ch; j = e.next; }
    else if (isNameChar(css[j])) name += css[j++];
    else break;
  }
  return { name, next: j };
}

/** Reads a quoted string at css[i] (the opening quote); returns its decoded text and the index after the closing quote. */
function readString(css: string, i: number): { value: string; next: number } {
  const quote = css[i];
  let value = '';
  let j = i + 1;
  while (j < css.length && css[j] !== quote) {
    if (css[j] === '\\') {
      if (css[j + 1] === '\n') { j += 2; continue; }   // escaped newline continues the string
      const e = readEscape(css, j); value += e.ch; j = e.next;
    } else if (css[j] === '\n') break;                 // unescaped newline ends a bad string
    else value += css[j++];
  }
  return { value, next: j < css.length && css[j] === quote ? j + 1 : j };
}

/** True when a decoded address cannot reach the network. */
function isSafeCssUrl(decoded: string): boolean {
  // Browsers drop tabs/newlines/control characters and leading spaces inside an address before reading it.
  const u = decoded.replace(/[\u0000-\u0020\u007f]/g, '');
  if (u === '') return true;
  if (u.startsWith('#')) return true;
  // `//host`, `\\host` and `/\host` all mean "another computer" to a browser.
  if (/^[\\/]{2}/.test(u)) return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(u);
  if (scheme) return SAFE_URL_SCHEMES.has(scheme[1].toLowerCase());
  return true;   // plain relative address: resolves inside the app's own folder
}

/** Index just past the ")" that closes the "(" at css[open], skipping strings and escapes. */
function closeParen(css: string, open: number): number {
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    const c = css[j];
    if (c === '"' || c === "'") { j = readString(css, j).next - 1; }
    else if (c === '\\') { j = readEscape(css, j).next - 1; }
    else if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return j + 1; }
  }
  return css.length;
}

/** Index just past the end of an at-rule that starts at i: through its ";" or its {...} block. */
function endOfAtRule(css: string, i: number): number {
  for (let j = i; j < css.length; j++) {
    const c = css[j];
    if (c === '"' || c === "'") j = readString(css, j).next - 1;
    else if (c === '\\') j = readEscape(css, j).next - 1;
    else if (c === '(') j = closeParen(css, j) - 1;
    else if (c === ';') return j + 1;
    else if (c === '{') {
      let depth = 0;
      for (let k = j; k < css.length; k++) {
        if (css[k] === '{') depth++;
        else if (css[k] === '}' && --depth === 0) return k + 1;
      }
      return css.length;
    }
  }
  return css.length;
}

/** One scan: returns the stylesheet with every network-capable construct removed. */
function sanitizeOnce(css: string): string {
  let out = '';
  let i = 0;
  // Depth of "(" inside a function whose strings are addresses; 0 = not inside one.
  let urlFnDepth = 0;
  const parenStack: boolean[] = [];   // true for each open "(" that belongs to an address function
  while (i < css.length) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {          // comment: copy untouched
      const close = css.indexOf('*/', i + 2);
      const end = close === -1 ? css.length : close + 2;
      out += css.slice(i, end); i = end; continue;
    }
    if (c === '"' || c === "'") {
      const s = readString(css, i);
      if (urlFnDepth > 0 && !isSafeCssUrl(s.value)) out += '""';   // address inside image-set()/src()/…
      else out += css.slice(i, s.next);
      i = s.next; continue;
    }
    if (c === '@' ) {
      const id = readIdent(css, i + 1);
      const name = id.name.toLowerCase();
      if (name === 'import') { i = endOfAtRule(css, i); continue; }   // could pull in a stylesheet that changes later
      out += css.slice(i, id.next || i + 1); i = id.next || i + 1; continue;
    }
    if (c === '\\' || isNameChar(c)) {
      const start = i;
      const id = readIdent(css, i);
      const name = id.name.toLowerCase();
      if (css[id.next] === '(') {
        if (name === 'expression') { out += '/* blocked */'; i = closeParen(css, id.next); continue; }
        if (name === 'url') {
          // Unquoted url(...) is one token; quoted is a function holding a string (handled by the string branch).
          let j = id.next + 1;
          while (j < css.length && /[ \t\n\r\f]/.test(css[j])) j++;
          if (css[j] === '"' || css[j] === "'") {
            // Quoted url("..."): judge the string; a blocked one takes the whole call with it.
            const str = readString(css, j);
            if (!isSafeCssUrl(str.value)) {
              let k = str.next;
              while (k < css.length && css[k] !== ')') k++;
              out += 'url(/* blocked */)'; i = k < css.length ? k + 1 : k; continue;
            }
          } else {
            let value = '';
            while (j < css.length && css[j] !== ')') {
              if (css[j] === '\\') { const e = readEscape(css, j); value += e.ch; j = e.next; } else value += css[j++];
            }
            const end = j < css.length ? j + 1 : j;
            out += isSafeCssUrl(value) ? css.slice(start, end) : 'url(/* blocked */)';
            i = end; continue;
          }
        }
        out += css.slice(start, id.next + 1);
        const isAddressFn = URL_STRING_FUNCTIONS.has(name);
        parenStack.push(isAddressFn); if (isAddressFn) urlFnDepth++;
        i = id.next + 1; continue;
      }
      if (name === '-moz-binding') {                  // old Firefox script-binding property
        let j = id.next;
        while (j < css.length && /[ \t\n\r\f]/.test(css[j])) j++;
        if (css[j] === ':') {
          let k = j;
          while (k < css.length && css[k] !== ';' && css[k] !== '}') k++;
          out += '/* blocked */'; i = css[k] === ';' ? k + 1 : k; continue;
        }
      }
      out += css.slice(start, Math.max(id.next, start + 1)); i = Math.max(id.next, start + 1); continue;
    }
    if (c === '(') { parenStack.push(false); }
    if (c === ')') { if (parenStack.pop()) urlFnDepth--; }
    out += c; i++;
  }
  return out;
}

/**
 * Sanitizes a CSS string by stripping dangerous patterns that could
 * load external resources or execute code. Safe patterns like
 * theme-asset:// and data: URIs are preserved, and a stylesheet with nothing
 * dangerous in it comes back byte-for-byte unchanged.
 */
export function sanitizeCSS(css: string): string {
  let result = css;
  // Removing a rule can glue the text on either side into a new one (`@imp` + `ort "x"`), so go again until nothing changes.
  for (let pass = 0; pass < 8; pass++) {
    const next = sanitizeOnce(result)
      // javascript: has no business anywhere in a stylesheet.
      .replace(/javascript\s*:/gi, '/* blocked */');
    if (next === result) return result;
    result = next;
  }
  return '/* blocked: stylesheet kept changing under sanitising */';
}

/** Only Google's stylesheet host may supply a theme font (audit SC-1): a theme's font link is a remote stylesheet that styles the whole app. */
const GOOGLE_FONT_URL = /^https:\/\/fonts\.googleapis\.com\/css2?\?[A-Za-z0-9:;,@=&+%._~!*'()\-\/]*$/;
export function isAllowedGoogleFontUrl(url: unknown): url is string {
  return typeof url === 'string' && url.length <= 2048 && GOOGLE_FONT_URL.test(url);
}

/**
 * Validates and sanitizes a community-submitted theme.
 * Runs the standard validation plus CSS sanitization on custom_css.
 */
export function validateCommunityTheme(raw: unknown): ThemeDefinition {
  const theme = validateTheme(raw);
  if (theme.custom_css) {
    theme.custom_css = sanitizeCSS(theme.custom_css);
  }
  return theme;
}
