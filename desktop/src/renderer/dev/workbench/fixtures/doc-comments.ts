// Doc comments fixture data — moved here from the renderer's own
// doc-comments-store.ts (T5, design docs/active/specs/2026-09-26-doc-
// comments-build-design.md §7: "Seed data moves to mock-shim.ts... so
// ?mode=workbench keeps showing every comment state without a real
// backend"). Every quote below is an EXACT substring of the plan fixture
// (fixtures/artifacts.ts, the onboarding-redesign plan) or the code fixture
// (ChatView.tsx), so the in-document highlight (comment-highlight matching by
// substring) finds them on first paint. Word + Excel fixtures are
// fixtures/docs.ts / fixtures/sheets.ts; quotes are exact substrings of the
// .docx body / exact cell addresses of the workbook.
//
// Shape: PersistedComment (shared/doc-comments-types.ts) — the SAME wire
// shape `docComments:list` returns for real, so the workbench exercises the
// real store's own PersistedComment -> DocComment mapping rather than a
// separate, only-ever-used-in-the-workbench shape.
import type { CommentAuthor, PersistedComment, ResolveEvent } from '../../../../shared/doc-comments-types';

const PLAN_PATH = 'docs/active/plans/2026-09-24-onboarding-redesign.md';
const CODE_PATH = 'desktop/src/renderer/components/ChatView.tsx';
const DOCX_PATH = 'docs/launch-brief.docx';
const XLSX_PATH = 'reports/q3-sales-by-rep.xlsx';
const PRIYA: CommentAuthor = 'person:Priya Shah';
const HOUR = 60 * 60 * 1000;

function resolvedHistory(by: CommentAuthor, at: number): ResolveEvent[] {
  return [{ by, at, action: 'resolved' }];
}

export function seedDocComments(): PersistedComment[] {
  const now = Date.now();
  return [
    // 1. Open — no reply yet.
    {
      id: 'seed-open',
      path: PLAN_PATH,
      selector: {
        kind: 'text',
        selector: {
          type: 'TextQuoteSelector',
          exact: "Today's first-run flow shows five screens before the composer is reachable",
          prefix: '', suffix: '', occurrence: 0,
        },
      },
      text: 'Can we get a screenshot of these five screens before we commit to cutting them?',
      author: 'user',
      createdAt: now - 5 * HOUR,
      replies: [],
      resolved: false,
      history: [],
    },
    // 2. Replied by the assistant, still open.
    {
      id: 'seed-replied',
      path: PLAN_PATH,
      selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'Redesigning Settings itself', prefix: '', suffix: '', occurrence: 0 } },
      text: "Worth double-checking this doesn't quietly require Settings changes anyway.",
      author: 'user',
      createdAt: now - 4 * HOUR,
      replies: [
        {
          id: 'seed-replied-r1',
          author: 'assistant',
          text: 'It doesn’t — the model default and the theme strip both read existing Settings state without adding new rows there.',
          createdAt: now - 3.5 * HOUR,
        },
      ],
      resolved: false,
      history: [],
    },
    // 3. Resolved by the assistant.
    {
      id: 'seed-resolved-assistant',
      path: PLAN_PATH,
      selector: {
        kind: 'text',
        selector: { type: 'TextQuoteSelector', exact: 'A dismissible strip offers the theme picker once, after the first reply', prefix: '', suffix: '', occurrence: 0 },
      },
      text: 'What happens if they dismiss it — is it gone forever, or does it come back in Settings?',
      author: 'user',
      createdAt: now - 3 * HOUR,
      replies: [
        {
          id: 'seed-resolved-assistant-r1',
          author: 'assistant',
          text: 'Added to Open Questions above — it can reopen from Settings > Appearance.',
          createdAt: now - 2.8 * HOUR,
        },
      ],
      resolved: true,
      history: resolvedHistory('assistant', now - 2.7 * HOUR),
    },
    // 4. Resolved by the user.
    {
      id: 'seed-resolved-user',
      path: PLAN_PATH,
      selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'no "unlock your workflow" language', prefix: '', suffix: '', occurrence: 0 } },
      text: 'Good — please keep echoing this rule in the actual copy review.',
      author: 'user',
      createdAt: now - 2 * HOUR,
      replies: [],
      resolved: true,
      history: resolvedHistory('user', now - 1.9 * HOUR),
    },
    // 5. Code file — a line-range comment, open.
    {
      id: 'seed-code-open',
      path: CODE_PATH,
      selector: {
        kind: 'text',
        selector: { type: 'TextQuoteSelector', exact: 'stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;', prefix: '', suffix: '', occurrence: 0 },
        // Line 14 is where this text actually sits in the ChatView.tsx fixture.
        lineHint: [14, 14],
      },
      text: 'Is 32px right on every pointer, or should this scale with line-height?',
      author: 'user',
      createdAt: now - HOUR,
      replies: [],
      resolved: false,
      history: [],
    },
    // 6-9. Word document. The two Priya comments stand for comments someone
    // left in Word before the file reached you.
    {
      id: 'seed-docx-priya-goal',
      path: DOCX_PATH,
      selector: {
        kind: 'text',
        selector: { type: 'TextQuoteSelector', exact: 'Move 30% of weekly active users to the new app within six weeks of launch.', prefix: '', suffix: '', occurrence: 0 },
      },
      text: 'Is 30% realistic? The last launch reached 18% in the same window.',
      author: PRIYA,
      createdAt: now - 26 * HOUR,
      replies: [
        { id: 'seed-docx-priya-goal-r1', author: 'user', text: 'Fair — the in-app prompt should help, but let’s say 25%.', createdAt: now - 6 * HOUR },
      ],
      resolved: false,
      history: [],
    },
    {
      id: 'seed-docx-priya-legal',
      path: DOCX_PATH,
      selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'Beta opens to 500 customers on March 10', prefix: '', suffix: '', occurrence: 0 } },
      text: 'Legal needs the beta terms by March 3 at the latest.',
      author: PRIYA,
      createdAt: now - 25 * HOUR,
      replies: [],
      resolved: false,
      history: [],
    },
    {
      id: 'seed-docx-emails',
      path: DOCX_PATH,
      selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'Marketing emails go out the same morning as the public launch.', prefix: '', suffix: '', occurrence: 0 } },
      text: 'Should we stagger these so support isn’t flooded on day one?',
      author: 'user',
      createdAt: now - 3 * HOUR,
      replies: [
        { id: 'seed-docx-emails-r1', author: 'assistant', text: 'Staggering over three days keeps tickets near today’s weekly level. Want me to add that to the timeline?', createdAt: now - 2.5 * HOUR },
      ],
      resolved: false,
      history: [],
    },
    {
      id: 'seed-docx-android',
      path: DOCX_PATH,
      selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'The payment screen has not been tested on older Android phones.', prefix: '', suffix: '', occurrence: 0 } },
      text: 'Which Android versions count as “older” here?',
      author: 'user',
      createdAt: now - 5 * HOUR,
      replies: [
        { id: 'seed-docx-android-r1', author: 'assistant', text: 'Changed it to “Android 11 and earlier”, which is what the test plan covers.', createdAt: now - 4.5 * HOUR },
      ],
      resolved: true,
      history: resolvedHistory('assistant', now - 4.5 * HOUR),
    },
    // 10-13. Spreadsheet — cell comments (Excel's own model).
    {
      id: 'seed-xlsx-north',
      path: XLSX_PATH,
      selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'C4', sheet: 'Q3' } },
      text: 'North looks low for July — was the Denver account left out?',
      author: PRIYA,
      createdAt: now - 20 * HOUR,
      replies: [],
      resolved: false,
      history: [],
    },
    {
      id: 'seed-xlsx-south',
      path: XLSX_PATH,
      selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'C15', sheet: 'Q3' } },
      text: 'Can you check this against the invoice total? It seems high.',
      author: 'user',
      createdAt: now - 2 * HOUR,
      replies: [
        { id: 'seed-xlsx-south-r1', author: 'assistant', text: 'It matches: two invoices of 84 and 83 were booked on Sep 29.', createdAt: now - 1.8 * HOUR },
      ],
      resolved: false,
      history: [],
    },
    {
      id: 'seed-xlsx-header',
      path: XLSX_PATH,
      selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'C1', sheet: 'Q3' } },
      text: 'Say what unit this is in (thousands?).',
      author: 'user',
      createdAt: now - 7 * HOUR,
      replies: [],
      resolved: true,
      history: resolvedHistory('user', now - 6 * HOUR),
    },
    // On the workbook's SECOND sheet.
    {
      id: 'seed-xlsx-byrep',
      path: XLSX_PATH,
      selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'B4', sheet: 'By rep' } },
      text: 'Lena is well behind the others — is her territory smaller?',
      author: PRIYA,
      createdAt: now - 5 * HOUR,
      replies: [],
      resolved: false,
      history: [],
    },
  ];
}
