// A long draft in Claude Code's message box must still read as the message box.
//
// WHY (2026-11-17): a new chat's hidden terminal is 80×24. There a draft of ~230+ characters is taller than the box,
// and Claude Code writes the scrolled-away line counts into the box's edges ("─── ↑ 5 more ───"). The reader took the
// labelled edge for no edge at all, called the screen a pop-up, and the queue never pressed Enter: the message sat
// "Paused" until the person clicked Resume and Send Now. The three screens below are trimmed from real captures (Claude
// Code 2.1.327, 80×24, YouCoded's status line) of a 700-character draft with the cursor at the end, 3 lines up, and 8 up.
import { describe, it, expect } from 'vitest';
import { readInputFocus } from '../src/shared/cc-input-focus';

const RULE = '─'.repeat(80);
const labelled = (label: string) => `─── ${label} ${'─'.repeat(80 - 5 - label.length)}`;
const header = [
  ' ▐▛███▛█   Claude Code v2.1.327',
  '▝▜██████▀  Opus 5.5 · Claude Ultra',
  ' ▝▝   ▝▝   ~/project',
  '', '', '', '',
  '                                                            ◐ medium · /effort',
];
const status = ['  New Session', '  Opus 5.5  |  Context Remaining: 100%', '  ⏵⏵ auto mode on (shift+tab to cycle)'];
const screen = (...rows: string[]) => [...header, ...rows, ...status].join('\n');

describe('a draft taller than the message box', () => {
  it('cursor at the end: "↑ N more" on the top edge, the ❯ row scrolled away', () => {
    expect(readInputFocus(screen(
      labelled('↑ 7 more'),
      '  be. I want you to use any tools available to you, um including bash slash',
      '  command stuff, blender, whatever your preference might be. I want you to use',
      '  any tools available to you, um includ',
      RULE,
    )).kind).toBe('message-box');
  });

  it('cursor in the middle: both edges labelled', () => {
    expect(readInputFocus(screen(
      labelled('↑ 5 more'),
      '  preference might be. I want you to use any tools available to you, um',
      '  including bash slash command stuff, blender, whatever your preference might',
      '  be. I want you to use any tools available to you, um including bash slash',
      labelled('↓ 2 more'),
    )).kind).toBe('message-box');
  });

  it('cursor at the top: "↓ N more" on the bottom edge, the ❯ row visible', () => {
    expect(readInputFocus(screen(
      RULE,
      '❯ I want you to use any tools available to you, um including bash slash',
      '  command stuff, blender, whatever your preference might be. I want you to use',
      '  any tools available to you, um including bash slash command stuff, blender,',
      labelled('↓ 7 more'),
    )).kind).toBe('message-box');
  });

  it('both counts in one edge ("↑ N more · ↓ M more")', () => {
    expect(readInputFocus(screen(labelled('↑ 2 more · ↓ 3 more'), '  middle of the draft', RULE)).kind).toBe('message-box');
  });
});

describe('look-alikes stay pop-ups', () => {
  it('a classic pop-up (one column-0 rule) whose list scrolls with an indented "↑ 3 more"', () => {
    expect(readInputFocus(screen(
      RULE,
      ' Select model',
      '   ↑ 3 more',
      ' ❯ 1. Opus',
      '   2. Sonnet',
      ' Enter to confirm · Esc to cancel',
    )).kind).toBe('popup');
  });

  it('a lone labelled rule with no box edge above it', () => {
    expect(readInputFocus(screen(' Some dialog body', labelled('↑ 3 more'), '  more dialog text')).kind).toBe('popup');
  });

  it('a plain top edge whose next row is not the input row, over a labelled bottom edge', () => {
    expect(readInputFocus(screen(RULE, ' Pick one', '   1. Yes', labelled('↓ 2 more'))).kind).toBe('popup');
  });
});
