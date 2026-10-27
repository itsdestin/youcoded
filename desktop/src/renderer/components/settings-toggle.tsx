// settings-toggle.tsx — Settings' on/off switch, with its original `enabled`/`onToggle`/`color` signature.
//
// WHY its own file (2026-10-22 phone speed): it lived in SettingsPanel.tsx, and AboutPopup and BetaChannelToggle (reached
// from the Help popup and the update panel) imported it from there, which put the whole Settings screen into the code a
// phone downloads before anything shows. Settings now loads on its own (App.tsx, deferred screens).
import { Toggle as UiToggle } from './ui';

// Was a hand-rolled 32x16 track (green-600 on / red-600 for danger) with its own
// knob math; now a thin wrapper over the shared <Toggle> primitive so there is
// one 36x20 geometry app-wide (changes 15-17). Kept as a named export — and with
// its original `enabled`/`onToggle`/`color` signature — because AboutPopup's
// analytics opt-out imports `Toggle` from this file.
//
// color="red" maps to tone="danger" (the theme's destructive token, replacing the
// raw red-600); the default maps to the app accent, replacing green-600.

export function Toggle({ enabled, onToggle, color = 'green', label, disabled }: { enabled: boolean; onToggle: () => void; color?: 'green' | 'red'; label?: string; disabled?: boolean }) {
  return (
    <UiToggle
      // The primitive already dims and blocks a disabled switch; this wrapper just
      // never passed it through, so a caller could not express "shown, not operable".
      disabled={disabled}
      checked={enabled}
      // The primitive hands back the next state; every call site here is a plain
      // flip, so we discard it and keep the existing zero-arg handlers intact.
      onChange={() => onToggle()}
      tone={color === 'red' ? 'danger' : 'default'}
      // None of these switches had an accessible name before (a <button> inside a
      // <label> does not inherit one); call sites pass the visible row text.
      aria-label={label}
    />
  );
}
