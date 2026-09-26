import React, { useState } from 'react';
import { Button, ConsentRow, Dialog, SettingRow, Toggle } from '../ui';

// Claude Code's one permission setting: the Skip Permissions switch. It lived
// in SettingsPanel.tsx's Session Defaults popup; it is now the first block of
// Assistant settings → Permissions (review round 1, 2026-09-05, P-5 note:
// "the permissions stuff from claude can move to permissions").
//
// What is NOT here any more: the "Advanced" list of protection overrides
// (Auto-approve all, config files, protected directories, the two compound-cd
// switches) and its "This is extremely dangerous" confirmation. Destin dropped
// the whole idea on the round-1 deck (P-4 note, P-14): "we should probably
// completely drop the 'approve protected requests' idea, as it may get us in
// trouble with anthropic." Round 2 (R2-5, pick a) decided the stored values:
// the build stage resets every one of them to off on first launch.
//
// Wording (P-13, then R2-4): Destin rewrote the row himself — "Enable Skip
// Permissions Mode?" over a hint that names the Claude Code flag it sets. His
// copy, used verbatim.
//
// Round 3 (R3-3): the red banner that used to appear under the switch is gone.
// Turning the switch ON now opens a dialog you have to read and tick before it
// moves — the shape of Claude Code's own bypass-permissions screen. Turning it
// OFF is immediate; only the dangerous direction is gated.

export interface PermissionOverrides {
  approveAll: boolean;
  protectedConfigFiles: boolean;
  protectedDirectories: boolean;
  compoundCdRedirect: boolean;
  compoundCdGit: boolean;
}

export default function SkipPermissionsSection({ defaults, onDefaultsChange }: {
  defaults: { skipPermissions: boolean };
  onDefaultsChange: (updates: { skipPermissions?: boolean }) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const close = () => { setConfirming(false); setAccepted(false); };

  return (
    <section>
      <SettingRow
        variant="item"
        title="Enable Skip Permissions Mode?"
        description="Allows you to toggle claude code's --dangerously-skip-permissions flag when creating a session. Claude won't ask before taking action"
        control={
          <Toggle
            checked={defaults.skipPermissions}
            onChange={() => {
              if (defaults.skipPermissions) { onDefaultsChange({ skipPermissions: false }); return; }
              setConfirming(true);
            }}
            tone="danger"
            aria-label="Enable Skip Permissions Mode?"
          />
        }
      />

      {/* layer 3 + destructive: this is the app's shape for a confirmation
          that must not be lost behind the thing it is confirming. */}
      <Dialog open={confirming} onClose={close} title="Skip Permissions Mode" size="prompt" layer={3} destructive>
        <div className="space-y-3 text-xs text-fg leading-relaxed">
          {/* Destin's copy (round 4, R4-3) — the three measured paragraphs it
              replaced read as a wall of grey. */}
          <p>
            When you begin a session in skip permissions mode, Claude Code will not ask before taking
            actions or running commands. You should be cautious when attempting to use this mode with
            Haiku- or Sonnet-class models.
          </p>
          {/* WHY ConsentRow (fix batch 2, 2026-09-26 — decisions.md "Consent
              tick box", settings-pieces#P-6): the whole line is one tappable
              box with the tick on the left, lighting up when ticked. It was a
              bare 14px square beside the sentence — Destin: "the vibe is off"
              (fix batch 1, B1-2). "Turn it on" below still waits for the tick. */}
          <ConsentRow checked={accepted} onChange={setAccepted}>
            I understand, and I use Skip Permissions at my own risk.
          </ConsentRow>
          {/* WHY stacked, danger on top (fix batch 1, 2026-09-24): this is a
              `size="prompt"` (340px) dialog — a NARROW popup, so two buttons
              stack full width with the main action (here the destructive
              confirm) on top, per the design guide's button-placement rule.
              Was side by side, hugging the right edge — the wide-popup shape. */}
          <div className="flex flex-col gap-2 pt-1">
            <Button
              variant="danger"
              disabled={!accepted}
              onClick={() => { onDefaultsChange({ skipPermissions: true }); close(); }}
              className="w-full"
            >
              Turn it on
            </Button>
            <Button variant="secondary" onClick={close} className="w-full">Cancel</Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
