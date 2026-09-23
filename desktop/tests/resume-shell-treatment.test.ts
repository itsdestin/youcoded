import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dirname, '../src/renderer/components/ResumeBrowser.tsx'), 'utf8');
const css = () => readFileSync(resolve(import.meta.dirname, '../src/renderer/components/ResumeBrowser.css'), 'utf8');

describe('Resume Session keeps its chosen outer header and list edge', () => {
  it('uses the approved header treatment without changing the preview pane', () => {
    expect(source).toContain("import './ResumeBrowser.css'");
    expect(source).toMatch(/data-resume-header[^>]*>/);
    expect(source).toContain('<h2 className="text-base font-medium text-fg">Resume Session</h2>');
    expect(source).not.toContain('var(--edge) 14%');
    expect(css()).toContain('var(--edge) 8%');
    expect(css()).toContain('left: 16px');
    expect(css()).toContain('right: 16px');
    expect(source).toContain("w-[420px] shrink-0 min-w-0 flex flex-col min-h-0 border-r border-edge overflow-hidden");
  });

  it('uses conditional unpainted content fading only on the Resume list', () => {
    expect(source).toContain('data-resume-list');
    expect(source).toContain('ref={listRef}');
    expect(css()).toContain('[data-resume-list][data-fade-top="true"]');
    expect(css()).toContain('[data-resume-list][data-fade-bottom="true"]');
    expect(css()).toContain('42px');
    expect(css()).toContain('4%');
    expect(css()).toContain('mask-image:');
    expect(css()).toContain('content: none');
    expect(css()).not.toContain('background: var(--panel)');
  });
});
