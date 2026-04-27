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
