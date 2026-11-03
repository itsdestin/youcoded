import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, it, expect } from 'vitest';

// No test pins a whole sentence the app shows a person (Destin, 2026-11-01: "we should literally never pin
// exact wording. waste of code/effort"). Rewording a message must not break a test; check the facts the
// message carries (a file name, a count), its role (alert, status, dialog) or one key word instead.
//
// What counts: an on-screen text check (`getByText`, `findByText`, `queryByText`, `…AllByText`, `…ByLabelText`,
// `toHaveTextContent`) whose argument is a literal sentence of six or more words. Allowed: the same sentence
// written somewhere else in the file too — the test supplied it (a prop, a fixture, a mocked reply) and is
// checking that it passes through, which is behaviour, not copy.
//
// Why a test and not an ast-grep rule: "the literal also appears outside the assertion" is a whole-file
// comparison a single-node pattern cannot express.
const DESKTOP = join(__dirname, '..');
const CHECK = /(?:(?:get|find|query)(?:All)?By(?:Text|LabelText)|toHaveTextContent)\((['"`])([A-Z][^'"`]{24,}?)\1/g;
const SENTENCE = /^[A-Z][a-z']*(?: [\w',.—-]+){5,}[.!?]?$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'node_modules' || name === 'fixtures' || name === 'personal-pages' || name === 'no-sentence-pins.test.ts') return [];
    if (statSync(full).isDirectory()) return walk(full);
    return /\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Sentences a file's on-screen checks pin that the file never supplies itself. */
function pinnedSentences(src: string): string[] {
  const found: string[] = [];
  for (const m of src.matchAll(CHECK)) {
    const text = m[2];
    if (!SENTENCE.test(text)) continue;
    // Supplied by the test: the literal still appears once every on-screen check of it is removed.
    // Markdown marks are dropped first: a fixture written `keeps **Markdown** inside` renders as plain words.
    const rest = src.split(m[0]).join('').replace(CHECK, (all, _q, t) => (t === text ? '' : all)).replace(/\*\*|__|`/g, '');
    if (!rest.includes(text)) found.push(text);
  }
  return found;
}

describe('no test pins a sentence the app shows', () => {
  it('catches a pinned sentence and allows one the test supplied', () => {
    // Self-test: this guard must see the shape it exists for (test-suite-hygiene.md → "A guard you did not break").
    expect(pinnedSentences("expect(screen.getByText('You have not set up any model providers.')).toBeTruthy();"))
      .toEqual(['You have not set up any model providers.']);
    expect(pinnedSentences("const msg = 'Please sign in to your library account.';\nrender(<Card text={msg} />);\nscreen.getByText('Please sign in to your library account.');"))
      .toEqual([]);
    expect(pinnedSentences("screen.getByText('Save');")).toEqual([]);
  });

  it('holds every test file to zero', () => {
    const hits: string[] = [];
    for (const dir of ['tests', 'src']) {
      for (const file of walk(join(DESKTOP, dir))) {
        for (const s of pinnedSentences(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))) hits.push(`${relative(DESKTOP, file)}: "${s}"`);
      }
    }
    expect(hits, 'Check the facts, a role or one key word — not the sentence.').toEqual([]);
  });
});
