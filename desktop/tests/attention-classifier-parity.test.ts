import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { classifyBuffer } from '../src/renderer/state/attention-classifier';

// Fixtures live at <repo-root>/shared-fixtures/attention-classifier/.
// Test file is at desktop/tests/, so two levels up reaches the repo root.
const FIXTURES_DIR = join(__dirname, '..', '..', 'shared-fixtures', 'attention-classifier');

describe('attention-classifier parity fixtures', () => {
  const entries = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.input.json'));

  it.each(entries)('classifies %s as expected', (inputFile) => {
    const baseName = inputFile.replace(/\.input\.json$/, '');
    const rawInput = JSON.parse(
      readFileSync(join(FIXTURES_DIR, inputFile), 'utf8')
    );
    // Strip the informational 'description' field — it's not part of
    // ClassifierContext and classifyBuffer would ignore unknown keys anyway,
    // but stripping is explicit about the contract boundary.
    const { description: _description, ...context } = rawInput;
    const expected = JSON.parse(
      readFileSync(join(FIXTURES_DIR, `${baseName}.expected.json`), 'utf8')
    );

    expect(classifyBuffer(context)).toEqual(expected);
  });
});
