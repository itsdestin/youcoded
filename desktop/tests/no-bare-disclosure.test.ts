// desktop/tests/no-bare-disclosure.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { join } from 'path';
import { RENDERER, readStripped, relPath, lineAt, assertPatternMatches } from './helpers/guard-scope';

// Guard: no NEW bare browser dropdown in the renderer.
//
// WHY. Destin said "I HATE the bare dropdowns with a chevron" on 2026-09-05 and
// the design guide records it (SettingRow row). On 2026-09-16 a session built one
// anyway — a native <details> with the browser's left-hand triangle — and he
// rejected it twice before it became a Callout with a right-aligned chevron.
// The guide sentence did not stop it; this test does. Use `<FoldRow>` (the
// shared fold-out row), `SettingRow` (`expanded`) or `<Callout collapsible>`,
// which hide the marker themselves.
//
// A <summary> passes when its className hides the marker (`list-none`).

// Existing ones, left alone on purpose: restyling them is Destin's call
// (roadmap: user-interface.md). Keyed by file → count, so a NEW one in the same
// file still fails.
// Empty since fix batch 2 (2026-09-26): SyncPanel's two ("Show details" on the
// sync error and on a warning) became buttons inside their notice box, and its
// "Sync log" toggle became a FoldRow (decisions.md P-1/P-2). Kept as a table so
// a future known exception has somewhere visible to go.
const KNOWN: Record<string, number> = {};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'dev' ? [] : walk(p); // workbench-only tooling
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [p] : [];
  });
}

// Preceded by whitespace/`>`/`(`/`{` so a regex literal quoting the tag
// (MarkdownContent parses `<summary>` out of markdown) is not a JSX element.
const BARE = /(?<=[\s>({])<summary(?![^>]*\blist-none\b)[\s>]/g;

describe('no bare disclosure triangles', () => {
  it('the pattern sees a bare summary and ignores a styled one', () => {
    assertPatternMatches(BARE, '  <summary className="text-xs">Show</summary>', 'bare summary');
    BARE.lastIndex = 0;
    expect('  <summary className="flex list-none">x</summary>'.match(BARE)).toBeNull();
    expect('/^\\s*<summary>\\s*(/i'.match(BARE)).toBeNull();
  });

  it('every <summary> in the renderer hides the browser marker, except the known ones', () => {
    const files = walk(RENDERER);
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readStripped(f);
      const hits = [...src.matchAll(BARE)];
      const rel = relPath(f).replace(/\\/g, '/').replace(/^\//, '');
      if (hits.length > (KNOWN[rel] ?? 0)) {
        offenders.push(...hits.map((m) => `${rel}:${lineAt(src, m.index ?? 0)}`));
      }
    }
    expect(offenders, 'use <FoldRow>, SettingRow (expanded) or <Callout collapsible> — Destin hates bare dropdowns').toEqual([]);
  });
});
