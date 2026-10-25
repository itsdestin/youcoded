// Promise 1 of finishing Pages step 1: nobody is re-asked. Every approval on disk is keyed
// to a connection's FINGERPRINT, so a refactor that changes one string re-asks every person
// with that kind of page. This pins what parse → fingerprint / covers / methodAllowed answer
// for a corpus covering every kind and every option, as recorded from the code BEFORE the
// kind registry existed (tests/fixtures/page-kind-corpus.expected.json).
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { covers, fingerprint, methodAllowed, parseConnections } from '../src/main/pages/page-connections';
import { CORPUS, METHODS, TARGETS } from './helpers/page-kind-corpus';

const EXPECTED = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/page-kind-corpus.expected.json', import.meta.url)), 'utf8')) as Record<string, unknown>;

describe('page connection kinds', () => {
  for (const [name, raw] of Object.entries(CORPUS)) {
    it(`parses, fingerprints and gates "${name}" exactly as before`, () => {
      const got = parseConnections(raw).map((c) => ({
        c,
        fp: fingerprint(c),
        covers: TARGETS.map((t) => covers(c, t.startsWith('http') ? new URL(t) : t)),
        methods: METHODS.map(([m, p]) => methodAllowed(c, m, p)),
      }));
      expect(JSON.parse(JSON.stringify(got))).toEqual(EXPECTED[name]);
    });
  }
});
