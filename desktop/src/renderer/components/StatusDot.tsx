// Status dot component removed — only the type is still used across the app.
//
// Colors map to:
//   green  — actively thinking or running a tool
//   red    — awaiting approval (user input required)
//   amber  — attention banner showing (stuck or session-died); needs eyes
//            but not as urgent as red
//   blue   — has unseen activity (timeline content + not currently viewed)
//   gray   — idle / nothing to report
export type SessionStatusColor = 'green' | 'red' | 'amber' | 'blue' | 'gray';

// The words the All sessions menu's status pill puts next to each color.
// Destin named four of them in the P-8 review (2026-08-28). Amber is not in
// that list, so it gets the plainest reading of what it means above: the
// attention banner is up and the turn may have stalled.
export const STATUS_LABEL: Record<SessionStatusColor, string> = {
  green: 'Working',
  red: 'Needs input',
  amber: 'Needs a look',
  blue: 'Response ready',
  gray: 'Inactive',
};
