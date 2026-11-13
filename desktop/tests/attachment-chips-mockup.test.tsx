// @vitest-environment jsdom
//
// Pins the attachment-chip design mock-up (dev/workbench/mockups/
// AttachmentChips.tsx, reached at ?mode=workbench&child=1&view=attachments):
// all three candidate sections render, each with a findable heading and
// testid for the screenshot rig, and every one of the eleven sample file
// kinds appears in each of them — in the full-width row AND the 390px row.
// A design that quietly dropped a kind (say, the unknown extension) would
// look "done" in a screenshot while hiding exactly the case we need to judge.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { AttachmentChipsMockup, SAMPLE_ATTACHMENTS } from '../src/renderer/dev/workbench/mockups/AttachmentChips';

afterEach(() => cleanup());

const SECTIONS = [
  { testid: 'mock-a', heading: 'A — Wide chip' },
  { testid: 'mock-b', heading: 'B — Card with name strip' },
  { testid: 'mock-c', heading: 'C — Card, bigger' },
];

const KINDS = [
  'image', 'markdown', 'text', 'code', 'pdf', 'spreadsheet',
  'audio', 'video', 'archive', 'long-name', 'unknown',
];

describe('attachment chips mock-up', () => {
  it('the sample set covers exactly the eleven kinds', () => {
    expect(SAMPLE_ATTACHMENTS.map((a) => a.kind)).toEqual(KINDS);
  });

  it('renders the three candidate sections with unique headings', () => {
    render(<AttachmentChipsMockup />);
    for (const { testid, heading } of SECTIONS) {
      const section = screen.getByTestId(testid);
      expect(within(section).getByRole('heading', { level: 2, name: heading })).toBeTruthy();
    }
  });

  it('shows every kind twice per section — full-width row and the 390px row', () => {
    render(<AttachmentChipsMockup />);
    for (const { testid } of SECTIONS) {
      const section = screen.getByTestId(testid);
      for (const kind of KINDS) {
        const chips = section.querySelectorAll(`[data-kind="${kind}"]`);
        expect(chips.length, `${testid} / ${kind}`).toBe(2);
      }
      // Each chip carries the full name in its title (the on-screen text may
      // be truncated by CSS) and an always-present remove button.
      for (const att of SAMPLE_ATTACHMENTS) {
        // WHY both attributes: sections A and B draw their own chips (browser title), section C renders
        // the real AttachmentChip, whose hover hint is the app's own and sits on the chip as data-hint.
        expect(section.querySelectorAll(`[title="${att.name}"], [data-hint="${att.name}"]`)).toHaveLength(2);
        expect(within(section).getAllByLabelText(`Remove ${att.name}`)).toHaveLength(2);
      }
    }
  });

  it('the image sample actually has a renderable preview source', () => {
    render(<AttachmentChipsMockup />);
    const imgs = screen.getByTestId('mock-b').querySelectorAll('img');
    expect(imgs.length).toBe(2);
    for (const img of imgs) expect(img.getAttribute('src')).toMatch(/^data:image\//);
  });
});

// Design C shipped (2026-08-27): section C must render the REAL composer chip
// (components/AttachmentChip.tsx, which stamps data-file-kind), and the two
// rejected mock-ups must not — otherwise the page could drift from the app.
describe('attachment chips mock-up — section C is the shipping chip', () => {
  it('only section C renders AttachmentChip', () => {
    render(<AttachmentChipsMockup />);
    expect(screen.getByTestId('mock-c').querySelectorAll('[data-file-kind]').length).toBe(KINDS.length * 2);
    expect(screen.getByTestId('mock-a').querySelectorAll('[data-file-kind]').length).toBe(0);
    expect(screen.getByTestId('mock-b').querySelectorAll('[data-file-kind]').length).toBe(0);
  });
});
