import { AnchorTip } from './ui';

// Info tooltip for the "Skip Permissions" toggle: a plain-language explanation of
// Claude Code's native permission system and the tradeoffs of turning prompts off
// for a whole session.
//
// Change 28 moved the panel onto <AnchorTip> (portaled .layer-surface at L4), so
// this file no longer hand-rolls a `fixed z-[9999]` box and Overlay.tsx stays the
// only z-index authority.
//
// It stays a NAMED COMPONENT rather than being deleted, which is where the spec's
// wording ("AnchorTip replaces … SkipPermissionsInfoTooltip") is misleading:
// InfoPopover was a generic primitive and is genuinely superseded, but this is a
// piece of COPY with two call sites (SessionStrip, ResumeBrowser). Inlining it
// would fork ~40 lines of safety guidance into two places that could drift apart.
// The wrapper is the deduplication; AnchorTip is the presentation.
//
// trigger="hover" is deliberate and matches the previous behavior — this explains
// a toggle you're hovering, not a click target. AnchorTip's hover mode keeps the
// panel pointer-events-none, so it can't swallow a click aimed at the toggle.
export function SkipPermissionsInfoTooltip() {
  return (
    <AnchorTip
      label="About skip permissions"
      trigger="hover"
      placement="top"
      widthClass="w-80"
      className="ml-1"
    >
      <p className="text-xs font-semibold text-fg mb-1.5">Normally, your assistant asks first</p>
      <p>
        Before Claude does anything that could change your computer — like editing a file, running a command, or going online — a little box pops up asking you to approve it. Reading files in your project is safe and doesn't need approval.
      </p>

      <p className="text-xs font-semibold text-fg mt-2.5 mb-1.5">What this toggle does</p>
      <p>
        Flipping it on tells Claude to stop asking. It will edit files, run commands, and use the internet on its own, without checking with you first.
      </p>

      {/* Fix (ROADMAP L205): this section used to promise that even with the
          toggle on, Claude would "still stop and ask" before touching the
          project's save history, the terminal's startup files or its own
          settings — and pointed at Settings → Advanced to switch those off.
          Measured false against the real CLI (v2.1.226, 2026-08-09,
          docs/active/investigations/2026-08-09-native-skip-permissions.md):
          under --dangerously-skip-permissions it read a .env, wrote outside
          the working directory, wrote .git/config and wrote to $HOME with no
          prompt for any. The ONE thing it still refuses is a delete command
          aimed at the project folder itself (or a system folder). The copy now
          says exactly that and nothing more — a safety net that is not there
          must not be advertised (docs/error-message-standards.md). */}
      <p className="text-xs font-semibold text-fg mt-2.5 mb-1.5">What still gets stopped</p>
      <p>
        Almost nothing. The only refusal we have measured is a command that would delete your whole project folder or a system folder. Everything else we tested went through without asking — reading private files, changing files outside your project, and editing your project's saved history or your assistant's own settings.
      </p>

      {/* Was a raw text-[#DD4444] hex. Same change-17 reasoning as the
          skip-permissions warnings elsewhere: this heading is danger
          messaging, so it rides the theme's destructive token rather than
          a fixed red a community pack can't touch. */}
      <p className="text-xs font-semibold text-destructive-fg mt-2.5 mb-1.5">What could go wrong</p>
      <div className="space-y-1">
        <div className="flex items-start gap-1.5">
          <span className="shrink-0 mt-px">·</span>
          <span>Your assistant can make mistakes, just like anyone. Normally the approval box gives you a chance to catch one. Without it, a wrong command could delete or overwrite your work before you see it happen.</span>
        </div>
        <div className="flex items-start gap-1.5">
          <span className="shrink-0 mt-px">·</span>
          <span>Your assistant reads a lot of outside stuff — websites, documents, the output of commands. Sometimes that content contains sneaky instructions trying to trick it into doing something you didn't ask for. The approval box is what normally stops that.</span>
        </div>
        <div className="flex items-start gap-1.5">
          <span className="shrink-0 mt-px">·</span>
          <span>Safest to use this only in a test folder or a project you wouldn't mind redoing — somewhere a mistake can't hurt anything important.</span>
        </div>
      </div>
    </AnchorTip>
  );
}
