// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';
import { ArtifactProvider, createArtifactStore } from '../state/ArtifactContext';
import { initialArtifactState } from '../state/artifact-tracker';

afterEach(cleanup);

const rec = (path: string) => ({ id: path, path, kind: 'internal', absolutePath: null, lastModified: '', status: 'active', versions: [], comments: [] }) as any;
const draw = (files: string[], md: string) => {
  const store = createArtifactStore({ ...initialArtifactState, sessionCwd: { s1: '/home/u' }, sessionArtifacts: { s1: files.map(rec) } });
  return render(<ArtifactProvider store={store}><MarkdownContent content={md} sessionId="s1" /></ArtifactProvider>).container;
};
const chips = (c: HTMLElement) => Array.from(c.querySelectorAll('button[data-file-path]')).map((b) => b.getAttribute('data-file-path'));

describe('a bare file name in backticks', () => {
  it('becomes a tappable chip when this session wrote that file', () => {
    expect(chips(draw(['pancakes.md'], 'I created `pancakes.md` in your home directory'))).toEqual(['/home/u/pancakes.md']);
  });
  it('matches a file in a folder by its name alone', () => {
    expect(chips(draw(['notes/tacos.md'], 'saved `tacos.md`'))).toEqual(['/home/u/notes/tacos.md']);
  });
  it('stays plain code when the session has no such file', () => {
    expect(chips(draw(['other.md'], 'see `pancakes.md`'))).toEqual([]);
  });
  it('stays plain code when two different files share the name (no guessing)', () => {
    expect(chips(draw(['a/x.md', 'b/x.md'], 'see `x.md`'))).toEqual([]);
  });
  it('leaves code that is not just a file name alone', () => {
    expect(chips(draw(['pancakes.md'], 'run `cat pancakes.md`'))).toEqual([]);
  });
});
