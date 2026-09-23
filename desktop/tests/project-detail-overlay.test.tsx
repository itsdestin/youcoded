// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { join } from 'node:path';
import { readSource } from './helpers/guard-scope';
import { ProjectDetailOverlay } from '../src/renderer/components/project-view/ProjectDetailOverlay';

afterEach(cleanup);

// WHY: the approved Project header, scroll hook and scoped CSS work together;
// testing only a class or only a stylesheet would miss a disconnected edge fade.
describe('Project detail overlay', () => {
  it('renders a contained 8% divider and a 16px medium title', () => {
    const { container } = render(<ProjectDetailOverlay title="Notes" onClose={() => {}}>body</ProjectDetailOverlay>);
    const header = container.querySelector('[role="dialog"] > header')!;
    expect(header.className).toContain('project-detail-header');
    expect(header.className).not.toContain('border-b');
    expect(header.querySelector('span')!.className).toContain('text-base font-medium');
    const css = readSource(join(__dirname, '..', 'src', 'renderer', 'components', 'project-view', 'ProjectDetailOverlay.css'));
    expect(css).toMatch(/\.project-detail-header::after\s*\{[^}]*left:\s*16px;[^}]*right:\s*16px;[^}]*var\(--edge\) 8%, var\(--edge\) 92%/);
  });

  it('tracks scroll edges without adding the painted global fade', () => {
    const { container } = render(<ProjectDetailOverlay title="Notes" onClose={() => {}}>body</ProjectDetailOverlay>);
    const body = container.querySelector('[role="dialog"] > .project-detail-scroll') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.className).toContain('overflow-auto');
    expect(body.className).not.toContain('scroll-fade');
    expect(body.dataset.fadeBottom).toBe('false');
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 300 });
    fireEvent.scroll(body);
    expect(body.dataset.fadeTop).toBe('false');
    expect(body.dataset.fadeBottom).toBe('true');
    body.scrollTop = 100;
    fireEvent.scroll(body);
    expect(body.dataset.fadeTop).toBe('true');
    expect(body.dataset.fadeBottom).toBe('true');
    body.scrollTop = 200;
    fireEvent.scroll(body);
    expect(body.dataset.fadeTop).toBe('true');
    expect(body.dataset.fadeBottom).toBe('false');
    const css = readSource(join(__dirname, '..', 'src', 'renderer', 'components', 'project-view', 'ProjectDetailOverlay.css'));
    expect(css).toMatch(/\.project-detail-scroll\s*\{[^}]*mask-image:\s*linear-gradient\(to bottom, transparent 0px,[^}]*transparent 100%\),\s*linear-gradient\(to right, #000 0%, transparent 4%, transparent 96%, #000 100%\);[^}]*mask-composite:\s*add/);
    expect(css).toMatch(/\.project-detail-scroll\[data-fade-top="true"\]\s*\{\s*--project-fade-top:\s*42px;/);
    expect(css).toMatch(/\.project-detail-scroll\[data-fade-bottom="true"\]\s*\{\s*--project-fade-bottom:\s*42px;/);
  });

  it('keeps the review Today pane on the pre-change Project header and bare body', () => {
    const demo = readSource(join(__dirname, '..', 'src', 'renderer', 'dev', 'workbench', 'mockups', 'ProjectPopupTaperDemo.css'));
    expect(demo).toMatch(/\[data-variant='today'\] \[role='dialog'\] > header\s*\{[^}]*border-bottom:\s*1px solid var\(--edge\)/);
    expect(demo).toMatch(/\[data-variant='today'\] \[role='dialog'\] > header > span\s*\{[^}]*font-weight:\s*600/);
    expect(demo).toMatch(/\[data-variant='today'\] \[role='dialog'\] > \.project-detail-scroll\s*\{[^}]*mask-image:\s*none/);
  });
});
