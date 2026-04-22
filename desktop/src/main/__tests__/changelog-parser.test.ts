import { describe, it, expect } from 'vitest';
import { parseChangelog, filterEntriesSinceVersion, compareSemver } from '../changelog-parser';

const SAMPLE = `# Changelog

All notable changes to YouCoded are documented in this file.

## [1.1.2] — 2026-04-21

**CC baseline:** v2.1.117

### Added
- thing A
- thing B

## [1.1.1] — 2026-04-18

### Fixed
- bug X

## [1.0.0] — 2026-01-01

Initial release.
`;

describe('parseChangelog', () => {
  it('parses version entries in source order (newest first)', () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries).toHaveLength(3);
    expect(entries[0].version).toBe('1.1.2');
    expect(entries[1].version).toBe('1.1.1');
    expect(entries[2].version).toBe('1.0.0');
  });

  it('captures the date from the header when present', () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries[0].date).toBe('2026-04-21');
    expect(entries[2].date).toBe('2026-01-01');
  });

  it('includes body content after the header until the next header', () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries[0].body).toContain('**CC baseline:** v2.1.117');
    expect(entries[0].body).toContain('- thing A');
    expect(entries[0].body).not.toContain('## [1.1.1]');
    expect(entries[1].body).toContain('- bug X');
  });

  it('ignores preamble before the first version header', () => {
    const entries = parseChangelog(SAMPLE);
    const joined = entries.map(e => e.body).join('\n');
    expect(joined).not.toContain('All notable changes to YouCoded');
  });

  it('returns [] for malformed input with no version headers', () => {
    expect(parseChangelog('# Changelog\n\nNothing here yet.')).toEqual([]);
    expect(parseChangelog('')).toEqual([]);
  });

  it('handles trailing whitespace and missing final newline', () => {
    const trimmed = SAMPLE.trimEnd();
    const entries = parseChangelog(trimmed);
    expect(entries).toHaveLength(3);
    expect(entries[2].body.trimEnd()).toMatch(/Initial release\.$/);
  });

  it('accepts em-dash or hyphen between version and date', () => {
    const entries = parseChangelog('## [2.0.0] - 2026-05-01\nbody\n');
    expect(entries[0].date).toBe('2026-05-01');
  });
});

describe('filterEntriesSinceVersion', () => {
  const entries = parseChangelog(SAMPLE);

  it('returns entries strictly newer than current', () => {
    const filtered = filterEntriesSinceVersion(entries, '1.1.1');
    expect(filtered.map(e => e.version)).toEqual(['1.1.2']);
  });

  it('returns [] when current is at or above newest', () => {
    expect(filterEntriesSinceVersion(entries, '1.1.2')).toEqual([]);
    expect(filterEntriesSinceVersion(entries, '2.0.0')).toEqual([]);
  });

  it('returns all entries when current predates them all', () => {
    expect(filterEntriesSinceVersion(entries, '0.9.0').map(e => e.version))
      .toEqual(['1.1.2', '1.1.1', '1.0.0']);
  });
});

describe('compareSemver', () => {
  it('handles major/minor/patch ordering', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.1', '1.0.0')).toBe(1);
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1);
  });
});
