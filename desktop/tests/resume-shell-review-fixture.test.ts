import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(import.meta.dirname, '../src/renderer/dev/workbench', path), 'utf8');

describe('Resume shell comparison uses a real browser and scoped styles', () => {
  it('uses the actual ResumeBrowser and both present/proposed candidates', () => {
    const demo = read('mockups/ResumeShellDemo.tsx');
    const registry = read('compare/registry.tsx');
    expect(demo).toContain("import ResumeBrowser from '../../../components/ResumeBrowser'");
    expect(demo).toContain('<ResumeBrowser');
    expect(demo).toContain('button.w-full[aria-expanded]:not([aria-disabled])');
    expect(registry).toContain("id: 'resume-shell'");
    expect(registry).toContain('treatment="today"');
    expect(registry).toContain('treatment="proposed"');
  });

  it('restores only the old styling in Today, leaving the approved styling in production', () => {
    const css = read('mockups/ResumeShellDemo.css');
    expect(css).toContain('html[data-resume-review="today"] [data-resume-review-panel]');
    expect(css).toContain('var(--edge) 14%');
    expect(css).toContain('mask-image: none');
    expect(css).not.toContain('data-resume-review="proposed"');
  });
});
