// @vitest-environment jsdom
// desktop/tests/explainer-shell.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import SettingsExplainer from '../src/renderer/components/SettingsExplainer';

// Guard for K12 — the explainer renders a payload, and nothing else.
//
// The spec framed K12 as consolidating five mechanisms into one renderer. By
// the time tranche 3 started that had already happened: four hosts shared this
// component and the same {intro, sections} payload. What had NOT happened is
// that this component predates <Dialog> and hand-rolled the header, the scroll
// body and the Esc handler — the exact three things D1 was built to own, and
// the same "the caller must remember to wrap it" shape that let two of
// SettingsPopup's seven callers ship dialogs that could not scroll.

afterEach(cleanup);

const SECTIONS = [
  { heading: 'What it does', paragraphs: ['It explains things.'] },
  { heading: 'Bullets', bullets: [{ term: 'Term', text: 'body text' }] },
];

describe('SettingsExplainer', () => {
  it('renders the payload', () => {
    render(<SettingsExplainer intro="An intro." sections={SECTIONS} />);
    expect(screen.getByText('An intro.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What it does' })).toBeInTheDocument();
    expect(screen.getByText('It explains things.')).toBeInTheDocument();
    expect(screen.getByText('Term')).toBeInTheDocument();
  });

  it('section headings are h3, matching K1', () => {
    // The dialog title is h2, so an explainer heading must be h3 or it announces
    // as a sibling of the dialog's own name rather than as its child.
    render(<SettingsExplainer intro="i" sections={SECTIONS} />);
    expect(screen.getByRole('heading', { name: 'What it does' }).tagName).toBe('H3');
  });

  it('owns no dialog chrome', () => {
    render(<SettingsExplainer intro="i" sections={SECTIONS} />);
    expect(screen.queryByRole('heading', { level: 2 }), 'the header belongs to Dialog').toBeNull();
    expect(screen.queryByRole('button', { name: /close/i }), 'close belongs to Dialog').toBeNull();
    expect(screen.queryByRole('button', { name: /back/i }), 'back belongs to Dialog').toBeNull();
    expect(document.querySelector('.scroll-fade'), 'the scroll body belongs to Dialog').toBeNull();
  });
});

// WHY no "explainer hosts" source-text cases any more (Plan B, 2026-09-16): "no
// host passes the explainer chrome props it no longer has" and "every host drives
// Dialog onBack from its showInfo flag" are now the ast-grep rules
// settings-explainer-no-chrome-props, explainer-hosts-pass-onback-showinfo and
// its -lifted twin (ThemeScreen) in youcoded-dev scripts/ast-grep/rules/.
