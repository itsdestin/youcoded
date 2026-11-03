// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ProjectDetailOverlay } from '../src/renderer/components/project-view/ProjectDetailOverlay';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// WHY: the scroll hook must feed the edge-fade flags on browsers without CSS scroll timelines.
describe('Project detail overlay', () => {
  it('fades its body with the app\'s one fade, and feeds it on browsers without CSS scroll timelines', () => {
    // Stand in for a browser without scroll-driven animations (Firefox remote): only there does
    // useScrollFade set the data-fade-* flags the CSS fallback reads.
    vi.spyOn(CSS, 'supports').mockReturnValue(false);
    const { container } = render(<ProjectDetailOverlay title="Notes" onClose={() => {}}>body</ProjectDetailOverlay>);
    const body = container.querySelector('[role="dialog"] > .project-detail-scroll') as HTMLElement;
    expect(body).not.toBeNull();
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
  });
});
