// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { seedPages } from '../src/renderer/dev/workbench/fixtures/pages';
import { PAGE_KIT_CSS } from '../src/renderer/components/pages/page-kit';
import { prepareHostedDocument } from '../src/renderer/components/pages/page-theme';

describe('the planning page workbench fixture', () => {
  it('shows its active-work overview before page scripts run', () => {
    const page = seedPages().find((entry) => entry.id === 'page-master-plan');
    expect(page).toBeDefined();
    const hosted = prepareHostedDocument(page!.html, ':root { --canvas: white; }', PAGE_KIT_CSS, page!.data, page!.connections ?? []);
    const authorScript = [...hosted.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.index ?? hosted.length;
    const firstPaint = hosted.slice(0, authorScript);
    const scriptStart = hosted.lastIndexOf('<script>') + '<script>'.length;
    const authorScriptText = hosted.slice(scriptStart, hosted.indexOf('</script>', scriptStart));

    // WHY: the prior content-only render silently blanked when a literal newline
    // broke the frame script; pin both nonblank first paint and executable code.
    expect(() => new Function(authorScriptText)).not.toThrow();
    expect(firstPaint).toContain('<h2>Active work</h2>');
    expect(firstPaint).toContain('Pages foundation');
    expect(firstPaint).toContain('Community reports');
    expect(firstPaint).toContain('Device mesh');
    expect(firstPaint).toContain('Merged · 5 Oct');
    expect(firstPaint).toContain('Released · 3 Oct');
    expect(firstPaint).toContain('Needs your attention');
    expect(page!.html).not.toMatch(/no sample verified|illustrative|This mock|not independently verified/);
    expect(page!.html).toContain('Host changed');
    expect(page!.html).toContain('Source history unavailable');
    expect(page!.html).toContain('Draft changed elsewhere');
  });

  it('edits structured fields locally, reviews an exact update and revokes the scoped grant', () => {
    const page = seedPages().find((entry) => entry.id === 'page-master-plan')!;
    // WHY: these are author HTML/scripts, not React; execute the real fixture
    // in an isolated DOM so a broken button cannot pass a source-string check.
    const d = document;
    d.body.innerHTML = page.html;
    const script = [...page.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1];
    new Function(script)();
    const click = (selector: string) => {
      const button = d.querySelector<HTMLButtonElement>(selector);
      expect(button, selector).not.toBeNull();
      button!.click();
    };
    try {
      click('[data-action="edit-item"]');
      const title = d.querySelector<HTMLInputElement>('[name="title"]')!;
      title.value = 'Folder access';
      d.querySelector<HTMLSelectElement>('[name="status"]')!.value = 'In review';
      d.querySelector<HTMLTextAreaElement>('[name="next"]')!.value = 'Review revocation';
      d.querySelector('#itemForm')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      expect(d.querySelector('.item h3')!.textContent).toBe('Folder access');
      expect(d.querySelector('.item .pill')!.textContent).toBe('In review');
      expect(d.querySelector('[role="status"]')!.textContent).toBe('Draft saved. Public view unchanged.');
      click('[data-action="edit-item"]');
      expect(d.querySelector<HTMLInputElement>('[name="title"]')!.value).toBe('Folder access');
      expect(d.querySelector<HTMLSelectElement>('[name="status"]')!.value).toBe('In review');
      expect(d.querySelector<HTMLTextAreaElement>('[name="next"]')!.value).toBe('Review revocation');
      click('.nav [data-tab="public"]');
      expect(d.querySelector('.diff')!.textContent).toContain('Community reports: 8 open');
      expect(d.querySelector('.diff')!.textContent).toContain('Community reports: 9 open');
      click('[data-action="approve"]');
      click('[data-action="cancel-approval"]');
      expect(d.querySelector('#feedback')!.textContent).toBe('Public view unchanged.');
      click('[data-action="approve"]');
      click('[data-action="confirm-approval"]');
      expect(d.querySelector('#feedback')!.textContent).toBe('Update approved.');
      click('.nav [data-tab="access"]');
      expect(d.querySelector('#content')!.textContent).toContain('Host: Studio laptop');
      click('[data-action="revoke"]');
      expect(d.querySelector('#content')!.textContent).toContain('Access revoked');
      click('.nav [data-tab="work"]');
      click('.nav [data-tab="access"]');
      expect(d.querySelector('#content')!.textContent).toContain('Access revoked');
      expect(d.querySelector('#content')!.textContent).toContain('Folder access does not allow network requests.');
    } finally {
      d.body.innerHTML = '';
    }
  });
});
