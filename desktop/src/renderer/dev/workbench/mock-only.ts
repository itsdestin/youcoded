// Channels the workbench implements that have NO real backend yet. Each names
// the unbuilt feature it belongs to, so a fake can never quietly ship as real —
// and so this list doubles as the backend to-do when a design is approved.
// Spec §3.2, §6.2.
//
// Adding an entry is the SUPPORTED way to design UI ahead of its backend.
// Deleting the guard test because a channel is "obviously fine" is not.
// Empty: Task 8 shipped the real backend for the six specialists channels
// (list, the tier get/set pair, steer/interrupt, and the specialists:event
// push) — see ipc-handlers.ts/preload.ts/remote-shim.ts's `specialists:*`
// surfaces. The seventh row this list used to carry, `specialists.openFolder`,
// turned out not to need its own channel at all: Task 10's "Open folder"
// button calls the existing generic `shell.openPath`, so there is no bespoke
// channel left to build. (The mock namespace in mock-shim.ts STAYS — the
// workbench still needs fixture data — only the "no real backend" claim goes.)
//
// chatsearch.resolve / chatsearch.read were listed here too while the session
// reference cards were designed ahead of their backend, and came off when the
// real IPC landed. Same rule, same reason: their fake namespace stays so the
// tool gallery can show every row state without a real index.
//
// G-1 background Bash's `native.killShell` was listed here while the card was
// designed ahead of its backend, and came off when `native:kill-shell` landed
// on all five surfaces (2026-08-28). Same rule, same reason as the rows above:
// the fake in mock-shim.ts stays so the tool gallery can show every card state
// without a real process — only the "no real backend" claim goes.
// The three games-arcade rows (`arcade.status`, `arcade.leaderboard`,
// `arcade.submitScore`) came off when their real backend landed: the Worker's
// /games/scores routes, main/arcade-handlers.ts, and all five surfaces. Exactly
// the lifecycle this registry is for — the UI was designed and reviewed against
// a fake, the fake told us what to build, and the fakes in mock-shim.ts stay so
// the workbench can still show the you-alone, empty and stale-board states
// without a live leaderboard. `no MOCK_ONLY entry has since gained a real
// channel` in workbench-mock-contract.test.ts is what forces this cleanup.
//
// `engine.prereqs` came off this list on 2026-09-05 when the real check landed
// (main/engine/rocm-prereqs.ts on all five surfaces). Its fake in mock-shim.ts
// stays, so the workbench can still walk the "missing, then present" flow
// without a machine that is actually missing the libraries.
//
// 2026-09-05 — local-engine upgrades (docs/active/design/2026-09-04-local-engine-upgrades):
// six channels were designed in the workbench ahead of main, and all six have now landed on
// every surface (ipc-handlers + preload + remote-shim + remote-server + SessionService.kt):
//   engine.prereqs, engine.runInTerminal, engine.setConfig (which replaced engine.setSpeed),
//   models.settings, models.setSettings, models.addVision.
// `models.dismissMemoryWarning` never got a channel of its own: it folded into
// models.setSettings, so one write covers everything a model's settings own. Every fake in
// mock-shim.ts stays — the workbench still has no machine, no PTY and no engine — only the
// "no real backend" claim goes.
// The three Linux/KDE buddy helper rows (`buddy.helperStatus`,
// `buddy.installHelper`, `buddy.removeHelper`) came off on 2026-09-04 when their
// real backend landed: kwin-helper.ts plus the `buddy:helper-status`,
// `buddy:install-helper` and `buddy:remove-helper` channels on all three of the
// surfaces this feature has (shared/types.ts + preload.ts, ipc-handlers.ts,
// remote-shim.ts). Exactly the lifecycle this registry is for — the popup was
// designed and reviewed against a fake, and the fake told us what to build. The
// fakes in mock-shim.ts stay, so the workbench can still show the not-added,
// added and not-supported states without a KDE desktop; only the "no real
// backend" claim goes. `no MOCK_ONLY entry has since gained a real channel` in
// workbench-mock-contract.test.ts is what forces this deletion.
// The eight voice-prompting rows (`voice.status`, `.download`, `.start`,
// `.stop`, `.cancel`, `.onEvent`, `.sendAudio`, `.micAccess`) came off the same
// way on 2026-09-05, the moment preload.ts gained the real `voice` namespace and
// main/voice/voice-handlers.ts registered the six channels behind it. The fake
// in mock-shim.ts STAYS — the workbench still needs a mic that "hears" a
// scripted sentence with no speech engine downloaded — only the "no real
// backend" claim goes.
// The four Sign-in-with-ChatGPT rows (`chatgpt.status`, `chatgpt.signIn`,
// `chatgpt.cancelSignIn`, `chatgpt.signOut`) were listed here while the Settings
// card and the first-run screen were designed against a fake account (design
// 2026-09-04), and came off when the real backend landed on all five surfaces
// (backend design 2026-09-05: main/providers/chatgpt-auth.ts, the four
// `chatgpt:*` handlers, preload / remote-shim / remote-server / Android). Same
// rule, same reason as the rows above: the fake in mock-shim.ts stays so the
// workbench can still pin signed-out / waiting / signed-in / blocked without a
// browser round-trip — only the "no real backend" claim goes.
//
// Add a row the moment you design a channel ahead of its backend; delete the row, never the
// guard, when it ships. An empty list is the healthy state.
export const MOCK_ONLY: ReadonlyArray<{ channel: string; feature: string }> = [
  // Step 3 (2026-08-17, broadened): the session-start context panel. The real
  // backend (a session-start push carrying the full starting context — system
  // prompt, fitProjectInstructions / fitInjection results, droppedMcpServers)
  // does not exist yet — the panel is designed against claim-data seeded
  // through the SESSION_CONTEXT reducer action (fixture-loader.ts). This names
  // the channel the backend will provide so the design UI can never quietly
  // ship as real.
  { channel: 'native.onSessionContext', feature: 'session context panel (Step 3)' },
];
