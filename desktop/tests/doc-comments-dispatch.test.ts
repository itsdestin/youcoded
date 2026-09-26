// Pins T3's docComments:* dispatch point (docs/active/specs/2026-09-26-doc-
// comments-build-design.md §1.1, §3.2, §4.1): a .docx/.xlsx target has no
// sidecar — list() reads the file's OWN comments via T10/T12's readers, and
// every mutation (add/reply/resolve/reopen/move) refuses honestly, since
// writing into these formats (T11/T13) has not landed yet.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { nativeFormatFor, refuseNativeMutation, listNativeComments } from '../src/main/doc-comments/doc-comments-dispatch';

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'doc-comments');

let root: string;
beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-dispatch-'));
});
afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('nativeFormatFor', () => {
  it('classifies .docx and .xlsx, case-insensitively, and nothing else', () => {
    expect(nativeFormatFor('docs/plan.DOCX')).toBe('docx');
    expect(nativeFormatFor('reports/q3.xlsx')).toBe('xlsx');
    expect(nativeFormatFor('notes/todo.md')).toBeNull();
    expect(nativeFormatFor('src/app.ts')).toBeNull();
  });
});

describe('refuseNativeMutation', () => {
  it('refuses a .docx/.xlsx target and lets everything else proceed', () => {
    expect(refuseNativeMutation('docs/plan.docx')).toEqual({ ok: false, error: 'not-yet-supported' });
    expect(refuseNativeMutation('reports/q3.xlsx')).toEqual({ ok: false, error: 'not-yet-supported' });
    expect(refuseNativeMutation('notes/todo.md')).toBeNull();
  });
});

describe('listNativeComments — reading a real .docx inside a project', () => {
  it('reads the fixture’s own comments through the containment-checked source path', async () => {
    await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), path.join(root, 'docs', 'launch-brief.docx'));
    const result = await listNativeComments('docx', { path: 'docs/launch-brief.docx', projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.comments.length).toBeGreaterThan(0);
    expect(result.comments[0].path).toBe('docs/launch-brief.docx');
  });

  it('refuses a ../../etc/passwd-shaped path the same way every other entry point does', async () => {
    const result = await listNativeComments('docx', { path: '../../../../etc/passwd', projectRoot: root });
    expect(result).toEqual({ ok: false, error: 'path-outside-project' });
  });
});

describe('listNativeComments — reading a real .xlsx inside a project', () => {
  it('reads the fixture’s own cell notes through the containment-checked source path', async () => {
    await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'q3-sales-by-rep.xlsx'), path.join(root, 'reports', 'q3-sales-by-rep.xlsx'));
    const result = await listNativeComments('xlsx', { path: 'reports/q3-sales-by-rep.xlsx', projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const q3Note = result.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'B2');
    expect(q3Note).toBeDefined();
    expect(q3Note?.text).toContain('West is Priya');
  });
});
