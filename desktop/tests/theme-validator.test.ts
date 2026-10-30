import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { validateTheme, computeOnAccent, luminance, sanitizeCSS, validateCommunityTheme, lintCustomCssSelectors, isAllowedGoogleFontUrl } from '../src/renderer/themes/theme-validator';

const MINIMAL_VALID = {
  name: 'Test Theme',
  slug: 'test-theme',
  dark: false,
  tokens: {
    canvas: '#F2F2F2', panel: '#EAEAEA', inset: '#E0E0E0', well: '#F7F7F7',
    accent: '#1A1A1A', 'on-accent': '#F2F2F2',
    fg: '#1A1A1A', 'fg-2': '#444444', 'fg-dim': '#666666',
    'fg-muted': '#888888', 'fg-faint': '#AAAAAA',
    edge: '#CFCFCF', 'edge-dim': '#DCDCDC80',
    'scrollbar-thumb': '#C0C0C0', 'scrollbar-hover': '#999999',
  },
};

describe('validateTheme', () => {
  it('accepts a minimal valid theme', () => {
    expect(() => validateTheme(MINIMAL_VALID)).not.toThrow();
  });

  it('throws when name is missing', () => {
    expect(() => validateTheme({ ...MINIMAL_VALID, name: '' })).toThrow('name');
  });

  it('throws when slug is missing', () => {
    expect(() => validateTheme({ ...MINIMAL_VALID, slug: '' })).toThrow('slug');
  });

  it('throws when a required token is missing', () => {
    const { canvas, ...rest } = MINIMAL_VALID.tokens;
    expect(() => validateTheme({ ...MINIMAL_VALID, tokens: rest as any })).toThrow('canvas');
  });

  it('throws when tokens block is absent', () => {
    const { tokens, ...rest } = MINIMAL_VALID;
    expect(() => validateTheme(rest as any)).toThrow('tokens');
  });
});

describe('computeOnAccent', () => {
  it('returns white for dark accent colors', () => {
    expect(computeOnAccent('#1A1A1A')).toBe('#FFFFFF');
    expect(computeOnAccent('#0D0F1A')).toBe('#FFFFFF');
  });

  it('returns black for light accent colors', () => {
    expect(computeOnAccent('#F2F2F2')).toBe('#000000');
    expect(computeOnAccent('#FFFFFF')).toBe('#000000');
    expect(computeOnAccent('#D4D4D4')).toBe('#000000');
  });

  it('returns black for mid-range colors above 0.179 threshold', () => {
    expect(computeOnAccent('#7C6AF7')).toBe('#000000');
    expect(computeOnAccent('#FF7700')).toBe('#000000');
  });
});

describe('luminance', () => {
  it('returns 1.0 for white', () => {
    expect(luminance('#FFFFFF')).toBeCloseTo(1.0);
  });

  it('returns 0.0 for black', () => {
    expect(luminance('#000000')).toBeCloseTo(0.0);
  });

  it('returns 0 for non-hex input without crashing', () => {
    expect(luminance('rgb(255,255,255)')).toBe(0);
    expect(luminance('#FFF')).toBe(0);
  });
});

describe('validateTheme — new fields', () => {
  it('accepts theme with background pattern fields', () => {
    const theme = {
      ...MINIMAL_VALID,
      background: {
        type: 'image' as const,
        value: 'assets/wallpaper.png',
        opacity: 0.85,
        'panels-blur': 12,
        'panels-opacity': 0.75,
        pattern: 'assets/pattern.svg',
        'pattern-opacity': 0.06,
      },
    };
    expect(() => validateTheme(theme)).not.toThrow();
  });

  it('accepts theme with custom particle fields', () => {
    const theme = {
      ...MINIMAL_VALID,
      effects: {
        particles: 'custom' as const,
        'particle-shape': 'assets/heart.svg',
        'particle-count': 40,
        'particle-speed': 1.0,
        'particle-drift': 0.5,
        'particle-size-range': [8, 16],
      },
    };
    expect(() => validateTheme(theme)).not.toThrow();
  });

  it('accepts theme with icon overrides', () => {
    const theme = {
      ...MINIMAL_VALID,
      icons: { send: 'assets/icon-send.svg' },
    };
    expect(() => validateTheme(theme)).not.toThrow();
  });

  it('accepts theme with mascot overrides', () => {
    const theme = {
      ...MINIMAL_VALID,
      mascot: {
        idle: 'assets/mascot-idle.svg',
        welcome: 'assets/mascot-welcome.svg',
      },
    };
    expect(() => validateTheme(theme)).not.toThrow();
  });

  it('accepts theme with cursor and scrollbar', () => {
    const theme = {
      ...MINIMAL_VALID,
      cursor: 'assets/cursor.svg',
      scrollbar: { 'thumb-image': 'assets/thumb.svg', 'track-color': 'transparent' },
    };
    expect(() => validateTheme(theme)).not.toThrow();
  });

  it('rejects particle-shape when particles is not custom', () => {
    const theme = {
      ...MINIMAL_VALID,
      effects: {
        particles: 'rain' as const,
        'particle-shape': 'assets/heart.svg',
      },
    };
    expect(() => validateTheme(theme)).toThrow('particle-shape');
  });
});

describe('sanitizeCSS', () => {
  it('strips @import rules', () => {
    const css = '@import url("https://evil.com/style.css"); body { color: red; }';
    expect(sanitizeCSS(css)).toBe(' body { color: red; }');
  });

  it('strips @IMPORT (case insensitive)', () => {
    const css = '@IMPORT url("https://evil.com/style.css"); body {}';
    expect(sanitizeCSS(css)).toBe(' body {}');
  });

  it('strips external url() references', () => {
    const css = 'body { background: url(https://evil.com/img.png); }';
    expect(sanitizeCSS(css)).toBe('body { background: url(/* blocked */); }');
  });

  it('strips protocol-relative url() references', () => {
    const css = 'body { background: url(//evil.com/img.png); }';
    expect(sanitizeCSS(css)).toBe('body { background: url(/* blocked */); }');
  });

  it('preserves theme-asset:// URLs', () => {
    const css = 'body { background: url("theme-asset://slug/assets/bg.png"); }';
    expect(sanitizeCSS(css)).toBe(css);
  });

  it('preserves data: URIs', () => {
    const css = 'body { background: url("data:image/svg+xml,..."); }';
    expect(sanitizeCSS(css)).toBe(css);
  });

  it('strips expression()', () => {
    const css = 'div { width: expression(document.body.clientWidth); }';
    expect(sanitizeCSS(css)).toBe('div { width: /* blocked */; }');
  });

  it('strips javascript: URIs', () => {
    const css = 'body { background: url("javascript:alert(1)"); }';
    expect(sanitizeCSS(css)).toContain('/* blocked */');
    expect(sanitizeCSS(css)).not.toContain('javascript');
  });

  it('strips -moz-binding', () => {
    const css = 'div { -moz-binding: url("xbl-evil.xml"); color: red; }';
    expect(sanitizeCSS(css)).not.toContain('-moz-binding');
    expect(sanitizeCSS(css)).toContain('color: red');
  });

  it('preserves valid CSS untouched', () => {
    const css = '.panel { backdrop-filter: blur(12px); border-radius: 8px; color: var(--fg); }';
    expect(sanitizeCSS(css)).toBe(css);
  });
});

describe('sanitizeCSS: split keywords, image-set, escapes and other ways round the filter', () => {
  const NET = /https?:\/\/|\/\/evil/i;
  it('blocks an @import rebuilt from a split keyword', () => {
    const out = sanitizeCSS('@imp@import a;ort "https://evil.example/x.css"; body{color:red}');
    expect(out).not.toMatch(/@import/i);
    expect(out).not.toMatch(NET);
    expect(out).toContain('body{color:red}');
  });
  it('blocks an escaped @import keyword', () => {
    expect(sanitizeCSS('@\\69mport "https://evil.example/x.css"; a{}')).not.toMatch(NET);
  });
  it('blocks a web address inside image-set() (no url())', () => {
    for (const fn of ['image-set', '-webkit-image-set']) {
      const out = sanitizeCSS(`a{background:${fn}("https://evil.example/p.png" 1x)}`);
      expect(out).not.toMatch(NET);
    }
  });
  it('blocks a web address inside image-set(url(...)) and src()', () => {
    expect(sanitizeCSS('a{background:image-set(url(https://evil.example/p.png) 1x)}')).not.toMatch(NET);
    expect(sanitizeCSS('a{background:src("https://evil.example/p.png")}')).not.toMatch(NET);
  });
  it('blocks CSS escapes that spell url( or the scheme', () => {
    expect(sanitizeCSS('a{background:u\\72l(https://evil.example/p.png)}')).not.toMatch(NET);
    expect(sanitizeCSS('a{background:url(\\68ttps://evil.example/p.png)}')).not.toMatch(NET);
    expect(sanitizeCSS('a{background:url("\\68 ttps://evil.example/p.png")}')).not.toMatch(NET);
    expect(sanitizeCSS('a{background:\\75rl(HTTP://evil.example/p.png)}')).not.toMatch(NET);
  });
  it('blocks addresses a browser reads as another computer or another scheme', () => {
    for (const u of ['\\\\evil.example/p.png', '/\\evil.example/p.png', ' //evil.example/p.png', 'ht\ttps://evil.example/p.png', 'file:///etc/passwd', 'ftp://evil.example/p']) {
      const out = sanitizeCSS(`a{background:url("${u.replace(/\\/g, '\\\\')}")}`);   // CSS-escape the backslashes so the browser decodes back to `u`
      expect(out).toContain('url(');
      expect(out).not.toMatch(/evil|passwd/);
    }
  });
  it('blocks remote fonts in @font-face', () => {
    expect(sanitizeCSS('@font-face{font-family:x;src:url(https://evil.example/f.woff2)}')).not.toMatch(NET);
  });
  it('keeps theme-asset:, data:, fragment and relative addresses, byte for byte', () => {
    const css = 'a{background:url(theme-asset://s/a.png)} b{background:image-set("theme-asset://s/b.png" 1x)} c{filter:url(#f)} d{background:url(img/x.png)} e{background:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'/>")}';
    expect(sanitizeCSS(css)).toBe(css);
  });
  it('leaves comments and strings that merely mention an address alone', () => {
    const css = '/* see https://example.com */ a::after{content:"https://example.com"}';
    expect(sanitizeCSS(css)).toBe(css);
  });
});

describe('sanitizeCSS leaves every shipped theme untouched', () => {
  // WHY: theme-engine now sanitizes at the point of use. If a shipped theme's CSS changed, a user would SEE the difference.
  const roots = ['../src/renderer/themes/builtin', '../src/renderer/dev/workbench/fixtures/themes'];
  const files: string[] = [];
  for (const r of roots) {
    const dir = path.resolve(__dirname, r);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.json')) files.push(path.join(dir, e.name));
      if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'manifest.json'))) files.push(path.join(dir, e.name, 'manifest.json'));
    }
  }
  it('found themes to check', () => { expect(files.length).toBeGreaterThan(5); });
  for (const f of files) {
    it(path.basename(path.dirname(f)) + '/' + path.basename(f), () => {
      const css = JSON.parse(fs.readFileSync(f, 'utf8')).custom_css;
      if (typeof css === 'string') expect(sanitizeCSS(css)).toBe(css);
    });
  }
});

describe('isAllowedGoogleFontUrl', () => {
  it('accepts Google Fonts stylesheet addresses', () => {
    expect(isAllowedGoogleFontUrl('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700&display=swap')).toBe(true);
    expect(isAllowedGoogleFontUrl('https://fonts.googleapis.com/css?family=Roboto')).toBe(true);
  });
  it('rejects every other host, scheme and shape', () => {
    for (const u of [
      'https://evil.example/x.css', 'http://fonts.googleapis.com/css2?family=A', 'https://fonts.googleapis.com.evil.example/css2?family=A',
      'https://fonts.googleapis.com@evil.example/css2?family=A', 'https://fonts.googleapis.com/other', 'javascript:alert(1)', '//fonts.googleapis.com/css2?family=A',
      'https://fonts.googleapis.com/css2?family=A\\evil', '', undefined, 42,
    ]) expect(isAllowedGoogleFontUrl(u as unknown)).toBe(false);
  });
  it('validateTheme drops a bad font address but keeps the theme', () => {
    const t = validateTheme({ ...MINIMAL_VALID, font: { family: 'X', 'google-font-url': 'https://evil.example/x.css' } });
    expect(t.font?.['google-font-url']).toBeUndefined();
    expect(t.font?.family).toBe('X');
  });
});

describe('validateCommunityTheme', () => {
  it('sanitizes custom_css in community themes', () => {
    const theme = {
      ...MINIMAL_VALID,
      custom_css: '@import url("https://evil.com/spy.css"); .safe { color: red; }',
    };
    const result = validateCommunityTheme(theme);
    expect(result.custom_css).not.toContain('@import');
    expect(result.custom_css).toContain('.safe { color: red; }');
  });

  it('passes through themes without custom_css unchanged', () => {
    const result = validateCommunityTheme({ ...MINIMAL_VALID });
    expect(result.custom_css).toBeUndefined();
  });
});

describe('lintCustomCssSelectors', () => {
  // ROADMAP :46. halftone-dimension styled `.chat-bubble.user`/`.chat-bubble.assistant`
  // and `.send-btn` — none of which the renderer emits — so its whole bubble
  // treatment was silently inert while its previews implied otherwise. A rule
  // that does nothing is worse than a wrong rule: nothing looks broken.
  const capture = (css: string): string[] => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };
    try {
      lintCustomCssSelectors(css, 'test-theme');
    } finally {
      console.warn = original;
    }
    return warnings;
  };

  it('warns on the exact dead selectors that shipped, naming the replacement', () => {
    // The compound `.chat-bubble.user` yields a warning per distinct class
    // (`chat-bubble` and `user`); the one that matters names the replacement.
    const warnings = capture('.chat-bubble.user { color: red; }');
    const dead = warnings.find((w) => w.includes('".chat-bubble"'));
    expect(dead).toBeDefined();
    expect(dead).toContain('.user-bubble / .assistant-bubble');
  });

  it('warns on .send-btn, which has no equivalent', () => {
    const warnings = capture('.send-btn { box-shadow: 0 0 12px red; }');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('send-btn');
  });

  it('stays quiet for the real bubble classes the renderer emits', () => {
    expect(capture('.user-bubble { border: 1px solid red; }')).toEqual([]);
    expect(capture('.assistant-bubble { border-left: 3px solid red; }')).toEqual([]);
  });

  it('stays quiet for the other hooks halftone legitimately targets', () => {
    expect(capture('.header-bar { border-color: red; } .input-bar-container { border-color: red; }')).toEqual([]);
    expect(capture('.bg-accent { box-shadow: 0 0 20px red; }')).toEqual([]);
  });

  it('ignores class-like fragments inside declaration values', () => {
    // url(...) paths and content strings must not be scanned as selectors.
    expect(capture(".foo-bar { background-image: url('assets/a.b.svg'); }").length).toBe(1);
    expect(capture("::-webkit-scrollbar-thumb { background-image: url('assets/x.svg'); }")).toEqual([]);
  });

  it('warns once per distinct class, not once per occurrence', () => {
    expect(capture('.send-btn { color: red; } .send-btn:hover { color: blue; }')).toHaveLength(1);
  });

  it('is a no-op for themes without custom_css', () => {
    expect(capture('')).toEqual([]);
  });
});
