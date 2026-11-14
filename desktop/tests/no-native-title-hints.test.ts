// WHY (card #135): the browser's own `title=` hover bubble is drawn by the operating system, so no
// theme can style it. Every hover hint in the app goes through <Tooltip> (components/ui/Tooltip.tsx).
// This pins the conversion: a plain element (button, span, div, ...) must not carry `title=`.
// iframes are exempt - their `title` is the frame's accessible name, never shown on hover.
// Button, Toggle and Chip take a `title` prop and hand it to <Tooltip> themselves.
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../src/renderer');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (p.split(path.sep).includes('dev')) continue; // workbench mock-ups are not the product
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') && !p.includes('.test.')) out.push(p);
  }
  return out;
}

describe('no plain browser hover hints', () => {
  it('has no title attribute on a plain element', () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText();
          if (/^[a-z]/.test(tag) && tag !== 'iframe') {
            for (const a of node.attributes.properties) {
              if (ts.isJsxAttribute(a) && a.name.getText() === 'title') {
                const { line } = sf.getLineAndCharacterOfPosition(a.getStart());
                offenders.push(`${path.relative(ROOT, file)}:${line + 1} <${tag} title=...>`);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
  });
});
