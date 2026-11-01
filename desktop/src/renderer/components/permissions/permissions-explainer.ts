import type { ExplainerSection } from '../SettingsExplainer';

// The "What is this?" content behind the (i) on Settings → Permissions.
//
// Layman's terms on purpose — this doubles as in-app help (see the
// SettingsExplainer module header). No tool ids, no rule syntax, nothing a
// non-developer would have to look up.
//
// WHY this is data rather than markup: SettingsExplainer owns every bit of the
// rendering, so the copy can be reviewed (and later translated) without reading
// a component. It also keeps SettingsPanel.tsx, already 2,600+ lines, from
// growing another screen of prose.
//
// THIS FILE IS WHERE THE EXPLANATION LIVES. The Permissions body is reference
// and data — three one-line mode definitions, the short list of what the app
// never waves through, and the approvals themselves. It carries NO mode control:
// mode is per-conversation state set from the status-bar chip in the chat, so a
// control on that screen would set nothing (PermissionsSection.tsx, MODES).
// Everything that used to be a paragraph on that screen was folded in here (the
// mode caption, the always-asks framing, how far an approval reaches), and the
// paragraph the body used to print about Claude Code was deleted outright
// because this file already had it. Length is fine here; a reader opened the (i)
// on purpose.
//
// The intro deliberately does NOT restate what the list itself says. The
// section's own first line already tells the user what the entries ARE and what
// removing one does; this tells them where the entries come from and points at
// the settings that decide how often they get asked in the first place.
// Destin's 2026-08-26/27 copy review: lighter phrasing throughout this file.
export const PERMISSIONS_EXPLAINER_INTRO =
  'The assistant asks you before doing anything that changes your computer — running a command, editing a file. Choosing “Always allow” when it asks is what puts something on this list. How often it asks in the first place is a separate setting, explained below.';

export const PERMISSIONS_EXPLAINER_SECTIONS: ExplainerSection[] = [
  {
    // Wording follows the chip at the bottom of the chat exactly (StatusBar's
    // PERMISSION_DISPLAY: ASK FIRST / AUTO EDIT / FULL AUTO), so the help text
    // names the same three things the user can see and click.
    //
    // The second paragraph is the caption that used to sit under the mode
    // control on the screen itself. It says "each conversation" and "change it
    // at any time" and nothing about a saved default, because there is no
    // persisted default-mode setting — the mode belongs to the conversation.
    heading: 'How much it asks',
    paragraphs: [
      'Each conversation has its own mode, and you can change it part-way through from the bar at the bottom of the chat.',
    ],
    bullets: [
      { term: 'Ask first', text: 'asks before anything that changes your files or runs a command. Reading, searching and a built-in list of look-only commands never ask.' },
      { term: 'Auto edit', text: 'edits files without asking, but still asks before running commands, except the look-only ones.' },
      { term: 'Full auto', text: "doesn't ask at all, apart from the things it always asks about. Use it when you're watching." },
    ],
  },
  {
    // "Preset" is the label on the new-session form (RuntimeBinding's preset
    // picker). The code calls these personality profiles; the user never sees
    // that word, so the heading uses the one on screen.
    heading: 'Presets',
    paragraphs: [
      'When you start a conversation you pick a preset, which decides the starting mode.',
    ],
    bullets: [
      { term: 'Assistant', text: 'starts cautious and asks about most things.' },
      { term: 'Coder', text: "starts able to edit files without asking, since that's most of the work." },
    ],
  },
  {
    // Companion to the "Commands that never ask" fold on the screen (NeverAskCommands.tsx).
    heading: 'Commands that never ask',
    paragraphs: [
      "A built-in list of look-only commands (like listing files, searching, or checking what changed in git) runs without asking in Ask first and Auto edit. Each is only allowed in its looking form: the same command used to change or delete something, send something out, or run another program still asks.",
      'Anything that points at passwords, keys or saved logins asks first, and so does git in a project whose own settings make git launch other programs. You cannot add to this list; “Always allow” is for everything else.',
    ],
  },
  {
    // The framing that used to wrap the four items on the screen. Two facts the
    // heading alone cannot carry: the mode does not switch this off, and a
    // folder where you have approved everything else is no exception.
    //
    // The third sentence is the honest caveat. The old on-screen line said "This
    // part cannot be turned off", which is not what the engine does: these are
    // `ask` entries, not `deny` ones, and remembered approvals are the LAST
    // layer applied (native-session-host.ts:291-301), so an explicit "Always
    // allow" on one of them wins from then on. The app makes that deliberately
    // hard — a deny-listed ask puts a second confirm in front of the "Always
    // allow" button (ToolCard.tsx PermissionButtons) — but it is possible, and
    // the result is visible and removable on the screen this explains.
    heading: 'Things it always asks about',
    paragraphs: [
      "The short list on this screen asks every time, whatever mode you're in — even Full auto, even in a folder where you've approved everything else. They're the things that are hardest to undo.",
      'If you choose “Always allow” on one of these, the app asks you to confirm, and from then on that one exact thing stops asking. It appears in the list like any other approval, and removing it puts the question back.',
    ],
  },
  {
    // Where an approval reaches. This is the line that used to sit under the
    // count on screen; the rows themselves already show which folder they are
    // in, so on screen it was telling the user something the layout shows.
    heading: "Approvals you've already given",
    paragraphs: [
      // CORRECTNESS, not just wording (Destin's 2026-08-26/27 review): "Every
      // approval belongs to the folder" was FALSE. A grant on a helper defined
      // in your own specialists folder is minted without a work dir
      // (tools/task.ts permissionSubject), stored under the cross-project slug,
      // and listed on this screen under "All projects" — it applies everywhere.
      'Most approvals belong to the folder you were working in when you gave them — the same request in another folder asks again. The exception is your own specialists: allowing one of them applies in every folder, under “All projects”.',
      "Removing an approval doesn't undo anything it already did. It only means you'll be asked the next time.",
    ],
  },
  {
    // The single most likely source of confusion: a screen called "Permissions"
    // implies it covers everything, and it does not — Claude Code keeps its own
    // allow list in its own settings, which nothing here reads or writes.
    heading: 'Approvals you gave Claude Code',
    paragraphs: [
      "Conversations running on Claude Code keep their own separate list of approvals, which this screen doesn't manage. You can change those in Claude Code's own settings.",
    ],
  },
];
