import { FoldRow } from '../ui/FoldRow';
import { SectionLabel } from '../ui';
import { READONLY_COMMAND_GROUPS } from '../../../shared/safe-readonly-commands';

// "Commands that never ask" (Destin's decision 2026-10-31): the built-in list of
// look-only commands the assistant runs without a card in Ask first and Auto edit.
//
// WHY it is shown at all: a person who watches the assistant run `git status` with no
// question deserves to find out why, and to read exactly what is on the list. The
// list is NOT a control (nothing here can be turned on or off), matching the modes
// card above it, so it is a closed fold — reference on demand, not a wall of text.
// Siblings: the "Permission modes" card and the (i) explainer's "Things it always
// asks about", which this section reads like. The list comes from the same module the
// engine decides with, so this page cannot promise something the engine does not do.
export function NeverAskCommands() {
  return (
    <div>
      <SectionLabel className="mb-2">Commands that never ask</SectionLabel>
      <FoldRow
        title="Look-only commands"
        description="Used in Ask first and Auto edit. Checking things never interrupts you."
      >
        <div className="space-y-2.5">
          <p className="text-2xs text-fg-2 leading-relaxed">
            These only look; they never change, delete, send or run anything else. If a command is not on this list, or is used in any other way, you are asked. Looking at passwords, keys or saved logins always asks.
          </p>
          {READONLY_COMMAND_GROUPS.map((g) => (
            <div key={g.title}>
              <p className="text-2xs font-medium text-fg">{g.title}</p>
              <p className="text-2xs text-fg-2 leading-relaxed font-mono break-words">{g.commands.join(', ')}</p>
              {g.note && <p className="text-3xs text-fg-muted leading-relaxed">{g.note}</p>}
            </div>
          ))}
        </div>
      </FoldRow>
    </div>
  );
}
