import { describe, it, expect } from 'vitest';
import { parseInkSelect, menuToButtons } from '../src/shared/ink-select-parser';

describe('ink-select-parser', () => {
  describe('parseInkSelect', () => {
    it('parses a simple 2-option menu', () => {
      const screenText = `
Resume Session

1: as is
  ❯ 2: from summary

press enter to confirm`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;

      expect(menu.options).toEqual(['as is', 'from summary']);
      expect(menu.selectedIndex).toBe(1); // cursor is on option 2 (index 1)
      expect(menu.title).toBe('Resume Session');
    });

    it('parses Resume Session with a description block above the options', () => {
      const menu = parseInkSelect(`Resume Session
Session age: 45 minutes | Usage: 85% of limit
Trade-off: Resume from summary will skip token-intensive context

1: as is
  ❯ 2: from summary

press enter to confirm`);
      expect(menu?.options).toEqual(['as is', 'from summary']);
      expect(menu?.selectedIndex).toBe(1);
    });

    it('parses when cursor is on first option', () => {
      const screenText = `Resume Session
  ❯ 1: as is
    2: from summary`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;

      expect(menu.options).toEqual(['as is', 'from summary']);
      expect(menu.selectedIndex).toBe(0); // cursor is on option 1 (index 0)
    });
  });

  // Regression (2026-07-26): menuToButtons used to emit
  // `UP×(n+2) + DOWN×index + \r` in ONE pty write. Measured against the real CC
  // CLI (2.1.220), that is doubly wrong:
  //   1. Arrows in a write that ends with `\r` are DISCARDED — CC acts on the
  //      Enter alone and confirms whatever option is highlighted. On the Resume
  //      Session menu every button therefore confirmed option 1 ("Resume from
  //      summary"), which runs /compact: every option compacted the session.
  //      Clicking "No, exit" on the folder-trust dialog TRUSTED the folder.
  //   2. The menus WRAP rather than clamp, so the "overshoot UP to anchor at the
  //      top" premise was false even ignoring (1).
  // The fix types the option's number, which selects and submits in one byte.
  describe('menuToButtons', () => {
    const UP = '\u001b[A';
    const DOWN = '\u001b[B';

    it('types the option number that CC printed on screen', () => {
      const menu = parseInkSelect(`Resuming from a summary

 ❯ 1. Resume from summary (recommended)
   2. Resume full session as-is
   3. Don't ask me again`);
      expect(menu).not.toBeNull();
      if (!menu) return;

      const buttons = menuToButtons(menu);
      expect(buttons.map((b) => b.input)).toEqual(['1', '2', '3']);
      expect(buttons.map((b) => b.label)).toEqual([
        'Resume from summary (recommended)',
        'Resume full session as-is',
        "Don't ask me again",
      ]);
      // Nothing to submit — the digit is the whole keystroke.
      expect(buttons.every((b) => b.submitInput === undefined)).toBe(true);
    });

    it('uses the printed number, not the list position', () => {
      // A menu scrolled so that its visible options start at 3 — the digit has to
      // come off the screen, or every button would be off by two.
      const menu = parseInkSelect(`Pick one:
   3. third
 ❯ 4. fourth
   5. fifth`);
      expect(menu).not.toBeNull();
      if (!menu) return;
      expect(menu.optionNumbers).toEqual([3, 4, 5]);
      expect(menuToButtons(menu).map((b) => b.input)).toEqual(['3', '4', '5']);
    });

    it('never puts arrow keys and a carriage return in the same write', () => {
      // THE invariant. CC drops the arrows and acts on the Enter alone, so any
      // button whose single write contains both silently answers the wrong option.
      const menus = [
        parseInkSelect(' ❯ 1. Yes, I trust this folder\n   2. No, exit'),
        parseInkSelect('Pick one:\n ❯ 1. a\n   2. b\n   3. c\n   4. d'),
        // Hand-built, unnumbered → takes the arrow fallback
        { id: 'x', title: 'x', options: ['a', 'b', 'c'], selectedIndex: 0 },
      ];
      for (const menu of menus) {
        expect(menu).not.toBeNull();
        if (!menu) continue;
        for (const button of menuToButtons(menu)) {
          const hasArrow = button.input.includes(UP) || button.input.includes(DOWN);
          expect(hasArrow && button.input.includes('\r')).toBe(false);
          expect(button.submitInput ?? '').not.toMatch(/\u001b/);
        }
      }
    });

    it('gives a menu with no printed numbers verified-navigation buttons, never a blind keystroke', () => {
      const buttons = menuToButtons({
        id: 'test',
        title: 'Test',
        options: ['a', 'b', 'c'],
        selectedIndex: 2,
      });
      expect(buttons.map((b) => b.pick?.index)).toEqual([0, 1, 2]);
      expect(new Set(buttons.map((b) => b.pick?.signature)).size).toBe(1);
      expect(buttons.every((b) => b.input === '' && b.submitInput === undefined)).toBe(true);
    });

    it('is independent of where the cursor sits for numbered menus', () => {
      const screen = (cursor: number) => [
        '   1. a',
        '   2. b',
        '   3. c',
      ].map((line, i) => (i === cursor ? line.replace('  ', ' ❯') : line)).join('\n');

      const fromFirst = menuToButtons(parseInkSelect('Pick one:\n' + screen(0))!);
      const fromLast = menuToButtons(parseInkSelect('Pick one:\n' + screen(2))!);
      expect(fromFirst.map((b) => b.input)).toEqual(fromLast.map((b) => b.input));
    });
  });

  // Regression (2026-07-26): extractDescription walked 15 lines up and SKIPPED box
  // borders instead of stopping at them, so on a resumed session the card's body
  // was the replayed transcript tail — Destin's screenshot showed a Resume Session
  // card describing itself as "…❄ Churned for 3m 44s ● API Error: ENOTIMP…".
  describe('description is bounded to the prompt box', () => {
    const RESUMED_SCREEN = [
      '● Shipped. feat/artifact-viewer is merged to master and pushed (dd85cdfd), and dev3 is fully shut down.',
      '',
      '✻ Cooked for 2m 25s',
      '  ⎿  SessionStart:resume hook error',
      '  ⎿  Failed with non-blocking status code: bash: session-start.sh: No such file or directory',
      '',
      '────────────────────────────────────────────────────────────────────',
      '  This session is 17d 19h old and 415.6k tokens.',
      '',
      '  Resuming the full session will consume a substantial portion of your usage limits. We recommend',
      '  resuming from a summary.',
      '',
      '  ❯ 1. Resume from summary (recommended)',
      '    2. Resume full session as-is',
      "    3. Don't ask me again",
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n');

    it('keeps the prompt body and drops the replayed transcript above the box', () => {
      const menu = parseInkSelect(RESUMED_SCREEN);
      expect(menu).not.toBeNull();
      if (!menu) return;

      expect(menu.title).toBe('Resume Session');
      expect(menu.description).toContain('This session is 17d 19h old and 415.6k tokens.');
      expect(menu.description).toContain('We recommend resuming from a summary.');
      // None of the session's own output may appear in the card body.
      expect(menu.description).not.toContain('Cooked for');
      expect(menu.description).not.toContain('artifact-viewer');
      expect(menu.description).not.toContain('hook error');
      // Nor the footer instruction line.
      expect(menu.description).not.toContain('Enter to confirm');
    });

    it('does not let text above the box set the title', () => {
      const menu = parseInkSelect([
        'I switched the app to dark mode as you asked — the text style that looks best is up to you.',
        '─────────────────────────────────────────────',
        'Continue?',
        ' ❯ 1. Yes',
        '   2. No',
      ].join('\n'));
      expect(menu).not.toBeNull();
      if (!menu) return;
      // 'text style that looks best' is a TITLE_OVERRIDES anchor, but it sits
      // ABOVE the prompt box, so it must not win.
      expect(menu.title).toBe('Continue?');
    });
  });

  // WHY: TITLE_OVERRIDES once used a bare 'trust' substring, so ANY menu with the word nearby (conversation output, the
  // user's prompt echo, the Fable 5 safeguard prompt) was labelled 'Trust This Folder?' and hijacked by TrustGate's
  // full-screen takeover. CC 2.1.2xx also rewrote the folder-trust dialog: the old "Important: Only use Claude Code with
  // files you trust" body now belongs ONLY to the external-CLAUDE.md-imports dialog, so the old anchor both missed the real
  // trust prompt and matched the wrong dialog.
  it.each([
    ['conversation text that merely contains "trust" does not hijack a menu', `You should trust the test suite here rather than manual checks.

Continue with this plan?
 ❯ 1. Yes, proceed
   2. No, revise the plan

press enter to confirm`, 'Continue with this plan?', ['Yes, proceed', 'No, revise the plan']],
    ['the model-safeguard prompt is "Message Flagged" even with "trust" nearby', `I can't run that directly — I don't trust the input enough.

This model's safeguards flagged this message. This sometimes happens with
safe, normal conversations.

 ❯ 1. Switch to Opus 4.8 and continue
   2. Edit prompt and retry with Fable 5`, 'Message Flagged', ['Switch to Opus 4.8 and continue', 'Edit prompt and retry with Fable 5']],
    ['the pre-2.1.2xx folder-trust prompt (old security-note wording)', `Do you want to work in this folder?

C:\\Users\\someone\\project

Important: Only use Claude Code with files you trust. Accessing untrusted
files may pose security risks.

 ❯ 1. Yes, I trust this folder
   2. No, continue without these permissions
   3. No, exit`, 'Trust This Folder?', ['Yes, I trust this folder', 'No, continue without these permissions', 'No, exit']],
    ['the new "Accessing workspace" folder-trust dialog', `Accessing workspace:

/home/destin

Quick safety check: Is this a project you created or one you trust? (Like your own code, a
well-known open source project, or work from your team). If not, take a moment to review
what's in this folder first.

Claude Code'll be able to read, edit, and execute files here.

Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit

Enter to confirm · Esc to cancel`, 'Trust This Folder?', ['Yes, I trust this folder', 'No, exit']],
    // Extra pre-approval body lines push the safety-check text out of extractTitle's 10-line lookback: the option label must carry it.
    ['the folder-trust dialog even when pre-approval body pushes the safety text out of the lookback window', `Accessing workspace:

/home/destin/some/project

Quick safety check: Is this a project you created or one you trust? (Like your own code, a
well-known open source project, or work from your team). If not, take a moment to review
what's in this folder first.

Claude Code'll be able to read, edit, and execute files here.

This folder pre-approves 7 tool permissions

This folder adds 2 directories to the workspace in .claude/settings.json

These will apply without asking. Only proceed if you trust this configuration.

Security guide

 ❯ 1. Yes, I trust this folder
   2. No, continue without these permissions
   3. No, exit`, 'Trust This Folder?', ['Yes, I trust this folder', 'No, continue without these permissions', 'No, exit']],
    ['the external-CLAUDE.md-imports dialog is NOT the trust prompt', `Allow external CLAUDE.md file imports?

This project's CLAUDE.md imports files outside the current working directory. Never allow
this for third-party repositories.

External imports:
  ~/shared/standards.md

Important: Only use Claude Code with files you trust. Accessing untrusted files may pose
security risks

 ❯ 1. Yes, allow external imports
   2. No, disable external imports`, 'Allow External Imports?', ['Yes, allow external imports', 'No, disable external imports']],
    ['conversation text about dark mode does not become the theme select', `I switched the app to dark mode as you asked. What next?

Pick a follow-up:
 ❯ 1. Adjust the accent color
   2. Leave it as is`, 'Pick a follow-up', ['Adjust the accent color', 'Leave it as is']],
    ['the real theme select via its heading', `Choose the text style that looks best with your terminal

 ❯ 1. Light mode
   2. Dark mode
   3. Dark mode (colorblind-friendly)`, 'Choose a Theme', ['Light mode', 'Dark mode', 'Dark mode (colorblind-friendly)']],
    ['the login select via its heading', `Select login method:

 ❯ 1. Claude account with subscription
   2. Anthropic Console account`, 'Select Login Method', ['Claude account with subscription', 'Anthropic Console account']],
  ])('titles %s', (_why, screenText, title, options) => {
    const menu = parseInkSelect(screenText);
    expect(menu?.title).toBe(title);
    expect(menu?.options).toEqual(options);
  });

  describe('cross-platform consistency', () => {
    it('handles colon-numbered options like Resume Session uses', () => {
      const screenText = `  ❯ 1: as is
    2: from summary`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;

      // Should strip the numbering
      expect(menu.options).toEqual(['as is', 'from summary']);
    });
  });
});

describe('parseInkSelect with a wrapped option label', () => {
  it('joins the wrapped line to its option and keeps the options after it', async () => {
    // Real screen from the app's terminal (CC 2.1.281, 80 columns): option 2
    // wraps onto a second line. Before the join, the menu ended at that line —
    // "No" vanished and option 2 was cut mid-sentence.
    const fs = await import('fs');
    const path = await import('path');
    const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'plan-menu', 'app-screen-cc-2.1.281-write-permission-80col.txt'), 'utf8');
    const menu = parseInkSelect(text)!;
    expect(menu.options).toEqual([
      'Yes',
      'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
      'No',
    ]);
    expect(menu.optionNumbers).toEqual([1, 2, 3]);
    expect(menuToButtons(menu).map((b) => b.input)).toEqual(['1', '2', '3']);
  });

  it('joins a wrapped option that sits ABOVE the cursor', () => {
    const menu = parseInkSelect([
      ' Do you want to proceed?',
      '   1. Yes, and do the long thing that wraps onto',
      '      a second line',
      ' ❯ 2. No',
    ].join('\n'))!;
    expect(menu.options).toEqual(['Yes, and do the long thing that wraps onto a second line', 'No']);
    expect(menu.selectedIndex).toBe(1);
  });
});

// The fullscreen renderer (Claude Code settings `tui: "fullscreen"`) indents
// its menus one column further and tops them with a ▔ edge that can carry a
// label. Captured from CC 2.1.285 (tests/fixtures/popup-corpus/fs-slash-export).
describe('parseInkSelect — fullscreen renderer menus', () => {
  const FULLSCREEN_EXPORT = [
    '▎ Auto mode is now Claude Code\'s default permission mode.',
    '▎ https://code.claude.com/docs/en/permission-modes',
    '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ ◐ medium · /effort ▔',
    '   Export conversation',
    '   Select export method',
    '   ❯ 1. Copy to clipboard  Copy the conversation to your system clipboard',
    '     2. Save to file       Save the conversation to a file in the current directory',
    '   Esc to cancel',
  ].join('\n');

  it('finds every option of a menu indented three columns', () => {
    const menu = parseInkSelect(FULLSCREEN_EXPORT)!;
    expect(menu.options.map((o) => o.split('  ')[0])).toEqual(['Copy to clipboard', 'Save to file']);
    expect(menu.dialog).toBe(true);
  });

  it('reads its heading from under the ▔ edge, never from the conversation above it', () => {
    const menu = parseInkSelect(FULLSCREEN_EXPORT)!;
    expect(menu.heading).toBe('Export conversation');
    expect(menu.title).not.toMatch(/auto mode/i);
  });
});

describe('prompt card description keeps Claude Code\'s paragraphs', () => {
  // The trust dialog as a phone-width terminal draws it: blank rows between paragraphs, the folder path wrapped.
  const NARROW_TRUST = [
    '─'.repeat(40),
    ' Accessing workspace:',
    '',
    ' /data/data/com.youcoded.app/files/home/Tr',
    ' ust test',
    '',
    ' Quick safety check: Is this a project you',
    ' created or one you trust?',
    '',
    ' Security guide',
    '',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n');

  it('starts a new paragraph at each blank row and joins only wrapped rows', () => {
    const menu = parseInkSelect(NARROW_TRUST)!;
    expect(menu.description).toBe(
      'Accessing workspace:\n\n/data/data/com.youcoded.app/files/home/Tr ust test\n\n'
      + 'Quick safety check: Is this a project you created or one you trust?\n\nSecurity guide',
    );
  });
});

describe('prompt card description on a narrow terminal (no blank rows)', () => {
  // As Claude Code draws the trust dialog at 50 columns (fixture cc-2.1.281-untrusted-50x30): no blank rows at all.
  const NARROW_NO_BLANKS = [
    '─'.repeat(50),
    ' Accessing workspace:',
    ' /data/data/com.youcoded.app/files/Projects/Trust',
    ' two',
    ' Quick safety check: Is this a project you',
    ' created or one you trust? (Like your own code, a',
    ' well-known open source project, or work from',
    ' your team). If not, take a moment to review',
    " what's in this folder first.",
    " Claude Code'll be able to read, edit, and",
    ' execute files here.',
    ' Security guide',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    ' Enter to confirm · Esc to cancel',
  ].join('\n');

  it('puts the path, each paragraph and the guide link on their own lines', () => {
    expect(parseInkSelect(NARROW_NO_BLANKS)!.description).toBe([
      'Accessing workspace:',
      '/data/data/com.youcoded.app/files/Projects/Trust two',
      'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what\'s in this folder first.',
      "Claude Code'll be able to read, edit, and execute files here.",
      'Security guide',
    ].join('\n'));
  });
});
