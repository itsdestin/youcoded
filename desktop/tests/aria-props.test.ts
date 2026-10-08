import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

// An `aria-*` prop on a COMPONENT that does not accept it is silently dropped.
//
// WHY (submit-ticket friction, proposal 19): TSX never type-checks a hyphenated attribute, so
// `<ConsentRow aria-label="…">` compiled and did nothing — a screen reader got no name, and
// only reading the component's props found it. This guard asks the type checker, for every
// `aria-*` written on a capitalised component in the renderer, whether that component's props
// have it (directly, through a spread of React's HTML attributes, or an index signature).
// A prop that only reaches the element through an untyped `...rest` is flagged too: declare it
// (OverlayPanel's `aria-live`, 2026-10-08), so the type says what the component passes on.
// It cannot see a component that DECLARES the prop and then fails to pass it on — that stays
// a review question.
//
// Why a test and not an ast-grep rule: whether a prop exists is a fact about a TYPE in another
// file, which only the type checker knows.
const DESKTOP = join(__dirname, '..');
const RENDERER = join(DESKTOP, 'src', 'renderer');
// A component tag with an aria-* attribute somewhere in its opening tag — only these files are
// handed to the checker (the rest of the renderer comes in through their imports).
const CANDIDATE = /<[A-Z][\w.]*\b[^>]*\baria-[a-z]+=/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') && !full.endsWith('.test.tsx') ? [full] : [];
  });
}

function compilerOptions(): ts.CompilerOptions {
  const cfg = ts.getParsedCommandLineOfConfigFile(join(DESKTOP, 'tsconfig.json'), {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
  });
  return { ...cfg!.options, noEmit: true };
}

/** `file:line <Tag aria-x>` for every aria-* prop whose component's props do not have it. */
function droppedAriaProps(program: ts.Program, files: string[]): string[] {
  const checker = program.getTypeChecker();
  const out: string[] = [];
  for (const f of files) {
    const sf = program.getSourceFile(f);
    if (!sf) continue;
    const visit = (n: ts.Node): void => {
      if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && /^[A-Z]/.test(n.tagName.getText(sf).split('.').pop() ?? '')) {
        const props = checker.getContextualType(n.attributes);
        for (const a of n.attributes.properties) {
          if (!ts.isJsxAttribute(a)) continue;
          const name = a.name.getText(sf);
          if (!name.startsWith('aria-')) continue;
          const accepted = !!props && (!!props.getProperty(name)
            || (props.isUnion() && props.types.every((t) => !!t.getProperty(name)))
            || !!checker.getIndexInfoOfType(props, ts.IndexKind.String));
          if (!accepted) out.push(`${relative(DESKTOP, f).split('\\').join('/')}:${sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1} <${n.tagName.getText(sf)} ${name}>`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

// Building a type checker over the renderer's imports takes a few seconds of CPU.
const CHECKER_BUDGET_MS = 60_000;

describe('aria-* props on components', () => {
  it('the scan flags a component without the prop and passes one that takes HTML attributes', () => {
    // Self-test on a file that exists only in memory, so the guard cannot go blind unnoticed.
    const probe = join(RENDERER, '__aria-probe__.tsx');
    const source = [
      "import React from 'react';",
      'function Plain({ title }: { title: string }) { return <div>{title}</div>; }',
      'function Forwards(props: React.HTMLAttributes<HTMLDivElement>) { return <div {...props} />; }',
      'export const A = () => <><Plain title="x" aria-label="lost" /><Forwards aria-label="kept" /></>;',
    ].join('\n');
    const options = compilerOptions();
    const host = ts.createCompilerHost(options);
    const read = host.getSourceFile.bind(host);
    host.getSourceFile = (name, lang, ...rest) => (name === probe ? ts.createSourceFile(name, source, lang, true, ts.ScriptKind.TSX) : read(name, lang, ...rest));
    host.fileExists = ((exists) => (name: string) => name === probe || exists(name))(host.fileExists.bind(host));
    const program = ts.createProgram([probe], options, host);
    expect(droppedAriaProps(program, [probe])).toEqual(['src/renderer/__aria-probe__.tsx:4 <Plain aria-label>']);
  }, CHECKER_BUDGET_MS);

  it('no aria-* prop in the renderer is written on a component that drops it', () => {
    const files = walk(RENDERER).filter((f) => CANDIDATE.test(readFileSync(f, 'utf8')));
    expect(files.length, 'non-vacuity: components with aria props exist').toBeGreaterThan(10);
    const program = ts.createProgram(files, compilerOptions());
    const dropped = droppedAriaProps(program, files);
    expect(dropped, `These aria-* props are written on components whose props do not take them, so they vanish:\n  ${dropped.join('\n  ')}\n\n`
      + 'Add the prop to the component (and pass it to the element that should carry it), or put it on that element directly.').toEqual([]);
  }, CHECKER_BUDGET_MS);
});
