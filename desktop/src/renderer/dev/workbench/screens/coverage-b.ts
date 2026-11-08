// Coverage batch B (2026-11-08): screens that need a sample conversation, sample data or a fake-backend switch —
// chat cards, files and viewers, git review, Office failures, the terminal, the arcade and right-click menus.
// Catalog entries (plus dev/ fixtures and fake-backend switches) only, so a release comparison can photograph an
// older release with this same folder laid over its own code. No newIn unless noted: each state existed in v1.3.3.
import type { ScreenEntry } from './types';

const PHONE = { width: 390, height: 844 };
const chat = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['chat', ...tags] });
const ph = (e: ScreenEntry): ScreenEntry => ({ ...e, tags: [...e.tags, 'narrow'], viewport: PHONE });
const COMPOSER = { role: 'textbox', label: 'Message your assistant...' } as const;
const type = (text: string) => ({ do: 'type', target: COMPOSER, text }) as const;

// WHY: cards and dividers that only a particular conversation draws (fixtures/bubbles/*.jsonl, replayed through the real reducer).
const CHAT_CARDS: readonly ScreenEntry[] = [
  // The plan card reads Claude Code's plan menu off the terminal screen (`planMenu=1` draws it, fixtures/terminal-screen.ts).
  { ...chat('chat#plan-approval', 'view'), session: 'wb-1', params: { seed: 'bubbles-plan-cc', planMenu: '1' },
    // WHY: a terminal that was never on screen has not drawn its menu, and the card reads the menu off that screen: look at the terminal once, come back.
    open: ['Terminal', 'Chat'], waitMs: 1500 },
  { ...chat('chat/terminal#plan-menu', 'view'), session: 'wb-1', params: { seed: 'bubbles-plan-cc', planMenu: '1' } },
  // The /clear divider, then a /compact divider (collapsed here, summary opened in the next picture).
  { ...chat('chat#markers', 'view'), session: 'wb-1', params: { seed: 'bubbles-markers-cc' } },
  { ...chat('chat#markers-summary', 'view'), session: 'wb-1', params: { seed: 'bubbles-markers-cc' }, open: [{ do: 'click', target: { role: 'button', labelStarts: 'Compacted' } }] },
  // A message with two attached files, and a send the computer may or may not have received, and one it never received.
  { ...chat('chat#attachments', 'view'), session: 'wb-2', params: { seed: 'bubbles-attachments' } },
  ph({ ...chat('chat#attachments-phone', 'view'), session: 'wb-2', params: { seed: 'bubbles-attachments' }, mark: 'chat' }),
  // The assistant is mid-reply: the stop button and the thinking line (fixtures/replies/working.jsonl never finishes).
  { ...chat('chat#working', 'view'), session: 'wb-2', params: { reply: 'working' }, open: [type('Find every place the theme is written'), { do: 'key', key: 'Enter' }], waitMs: 1500 },
  // The banners that replace the thinking line when something is wrong.
  { ...chat('chat#attention-stuck', 'view', 'error-state'), session: 'wb-1', params: { seed: 'bubbles-attention-stuck-cc' } },
  { ...chat('chat#attention-session-died', 'view', 'error-state'), session: 'wb-1', params: { seed: 'bubbles-attention-died-cc' } },
];

// WHY: the voice button's states (the fake mic hears one scripted sentence a word at a time; `voice=` sets its readiness).
const MIC = 'Speak your message';
const VOICE: readonly ScreenEntry[] = [
  // Held at a fixed word (`voiceHold`) so every picture shows the same words: just started, then mid-sentence
  // with the first sentence finished (solid) and the rest still settling (grey).
  { ...chat('chat#voice-recording', 'view'), params: { voiceHold: '3' }, open: [MIC], waitMs: 2500 },
  { ...chat('chat#voice-live-words', 'view'), params: { voiceHold: '14' }, open: [MIC], waitMs: 8000 },
  // The mic's own words change with its state, so each picture presses the button under its name for that state.
  ...([['needs-download', 'Speak your message (one-time download)'], ['downloading', 'Voice is downloading'], ['unavailable', "Voice isn't available"]] as const).map(([v, label]) => (
    { ...chat(`chat#voice-${v}`, 'view', ...(v === 'unavailable' ? ['error-state'] : [])), params: { voice: v }, open: [label], waitMs: 400 })),
];

// WHY: the app's one-line notices (the toast), the most-seen wordings. Each is raised through the app's own announce().
const TOASTS: readonly ScreenEntry[] = ['resume-failed', 'model-switch-failed', 'handoff-unavailable', 'slash-unavailable', 'stop-offline', 'mode-unconfirmed', 'download-failed']
  .map((t) => ({ name: `dev/toast#${t}`, tags: ['chat', 'toast'], params: { toast: t } }));

// WHY: the permission chip changes colour and words with each mode; each picture clicks it to the next mode.
const MODES: readonly ScreenEntry[] = [
  { ...chat('chat#permission-mode-accept', 'view'), session: 'wb-1', open: [{ do: 'click', target: { role: 'button', labelStarts: 'NORMAL' } }] },
  { ...chat('chat#permission-mode-plan', 'view'), session: 'wb-1', open: [{ do: 'click', target: { role: 'button', labelStarts: 'NORMAL' } }, { do: 'click', target: { role: 'button', labelStarts: 'ACCEPT' } }] },
  { ...chat('chat#permission-mode-auto-edit', 'view'), session: 'wb-2', open: [{ do: 'click', target: { role: 'button', labelStarts: 'ASK FIRST' } }] },
];

const file = (id: string, extra: Partial<ScreenEntry> = {}, suffix = ''): ScreenEntry =>
  ({ ...chat(`chat/files/open/${id}${suffix}`, 'pane', 'viewer'), session: 'wb-1', ...extra });
const btn = (label: string) => ({ do: 'click', target: { role: 'button', label } }) as const;

// WHY: the Files drawer's other faces and every viewer state (fixture files in fixtures/artifacts.ts).
const FILES: readonly ScreenEntry[] = [
  { ...chat('chat/files#empty', 'pane'), params: { files: 'none' } },
  { ...chat('chat/files#list-error', 'pane', 'error-state'), params: { fail: 'artifacts.listSession' } },
  { ...file('a-pitfalls', { mark: 'chat/files', params: { fail: 'artifacts.get' } }, '#preview-error'), tags: ['chat', 'pane', 'viewer', 'error-state'] },
  file('a-pitfalls'),                         // Markdown
  file('a-chatview'),                         // code
  file('a-big-log'),                          // partial-file banner, can load whole
  file('a-huge-dump'),                        // partial-file banner, cannot load whole
  file('a-clip-mp4'),                         // a format with no viewer
  file('a-sent-mockup'),                      // HTML
  file('a-survey-csv', { params: { extraFiles: 'csv' } }), // CSV
  file('a-old-plan'),                         // deleted since
  file('a-chatview', { open: ['Edit'] }, '#edit-mode'),
  // Edit mode with a change typed in (Save is live). The "unsaved changes" dialog itself has no screen mark (see report), so it is not photographed.
  { ...file('a-chatview', { open: ['Edit', { do: 'type', target: { role: 'textbox', labelStarts: 'import React' }, text: ' // draft' }] }, '#edit-typed') },
];

// WHY: the git review's other states beyond the commit card (fake git in the shim; `git=clean` = nothing uncommitted).
const REVIEW = ['Review changes'];
const GIT: readonly ScreenEntry[] = [
  { ...file('a-launch-brief', { mark: 'chat/files', open: REVIEW }, '#git-review-uncommitted') },
  // The commit box filled in (a file ticked "Include in commit" and a message typed), and the Revert confirm.
  { ...file('a-launch-brief', { mark: 'chat/files', open: [...REVIEW, { do: 'click', target: { role: 'checkbox', label: 'Include in commit' } }, { do: 'type', target: { role: 'textbox', label: 'Commit message' }, text: 'launch brief: tighten the beta dates' }] }, '#git-review-commit') },
  { ...file('a-launch-brief', { mark: 'chat/files', params: { git: 'clean' }, open: REVIEW }, '#git-review-clean') },
  { ...file('a-launch-brief', { mark: 'chat/files', params: { git: 'error' }, open: REVIEW }, '#git-review-error'), tags: ['chat', 'pane', 'viewer', 'error-state'] },
];

// WHY: Office's failure states (`office=` in the shim's fake host), a second tab, and Office on a phone.
const OFFICE: readonly ScreenEntry[] = [
  { name: 'office/versions#error', tags: ['office', 'error-state'], params: { office: 'versions-error' }, mark: 'office/versions' },
  { name: 'office/versions#empty', tags: ['office'], params: { office: 'versions-empty' }, mark: 'office/versions' },
  ph({ name: 'office/home#phone', tags: ['office'], mark: 'office/home' }),
  ph({ name: 'office/document#phone', tags: ['office'], mark: 'office/document' }),
];

// WHY: the terminal on a phone (the touch keys and the message box docked under it), and the games' play states.
const TERMINAL: readonly ScreenEntry[] = [
  ph({ ...chat('chat/terminal#phone', 'view'), mark: 'chat/terminal', params: { platform: 'android' } }),
];
const ARCADE: readonly ScreenEntry[] = [
  // Flappy left alone: the bird falls and the run-over card appears.
  { ...chat('chat/games/flappy/play#run-over', 'pane', 'games'), params: { signedIn: '1' }, mark: 'chat/games/flappy/play',
    open: [{ do: 'click', target: { role: 'application', labelStarts: 'Flappy.' } }, { do: 'key', key: 'Space' }], waitMs: 4500 },
];

// WHY: right-click menus beyond the five existing ones, and the tooltips people meet most.
const link = { role: 'link', label: 'release checklist' } as const;
const MENUS: readonly ScreenEntry[] = [
  { ...chat('chat#menu-link', 'menu'), session: 'wb-2', params: { seed: 'bubbles-links' }, open: [{ do: 'right-click', target: link }] },
  { ...file('a-chatview', { open: ['Edit', { do: 'right-click', target: { role: 'textbox', labelStarts: 'import React' } }] }, '#edit-menu') },
  { ...chat('chat#tooltip-permission', 'view', 'tooltip'), session: 'wb-1', open: [{ do: 'hover', target: { role: 'button', labelStarts: 'NORMAL' } }] },
  { ...chat('chat#tooltip-model', 'view', 'tooltip'), session: 'wb-1', open: [{ do: 'hover', target: { role: 'button', labelStarts: 'Sonnet' } }] },
  { ...chat('chat#tooltip-open-pages', 'view', 'tooltip'), open: [{ do: 'hover', target: { role: 'button', label: 'Open pages' } }] },
  { ...chat('chat#tooltip-session-files', 'view', 'tooltip'), open: [{ do: 'hover', target: { role: 'button', label: 'Session files' } }] },
];

export const COVERAGE_B: readonly ScreenEntry[] = [
  ...CHAT_CARDS,
  ...VOICE,
  ...TOASTS,
  ...MODES,
  ...FILES,
  ...GIT,
  ...OFFICE,
  ...TERMINAL,
  ...ARCADE,
  ...MENUS,
];
