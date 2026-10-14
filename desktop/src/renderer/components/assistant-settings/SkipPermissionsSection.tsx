import React, { useState } from 'react';
import { Button, ConsentRow, Dialog, OneJobCard, OneJobText, SettingRow, Toggle, Tooltip } from '../ui';
import { useScreenOpen } from '../../shoot-mode';

// Claude Code's one permission setting: the Skip permissions switch. It lived
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
  useScreenOpen('settings/assistant/permissions/skip-confirm', () => setConfirming(true));

  const close = () => { setConfirming(false); setAccepted(false); };

  return (
    <section>
      <SettingRow
        variant="item"
        title="Enable skip permissions mode?"
        description="Allows you to toggle claude code's --dangerously-skip-permissions flag when creating a session. Claude won't ask before taking action"
        control={
          <Toggle
            checked={defaults.skipPermissions}
            onChange={() => {
              if (defaults.skipPermissions) { onDefaultsChange({ skipPermissions: false }); return; }
              setConfirming(true);
            }}
            tone="danger"
            aria-label="Enable skip permissions mode?"
          />
        }
      />

      {/* layer 3 + destructive: this is the app's shape for a confirmation
          that must not be lost behind the thing it is confirming. */}
      <Dialog open={confirming} onClose={close} title="Skip permissions mode" size="panel" layer={3} destructive screen="settings/assistant/permissions/skip-confirm">
        {/* WHY the shared one-job card (popup-cards-1#PC-1, popup-cards-2#A-2): the same width,
            words, tick box and stacked buttons as the chat's first-time warnings — it was 340px
            with 12px main-colour words while they were 420px with grey ones. Destin's copy (round
            4, R4-3). The tick box is the shared ConsentRow (decisions.md "Consent tick box"); the
            red "Turn it on" is the main action, so it goes on top (guide "Destructive confirm"),
            with the "tick the box" hover hint while it is grey (final-fixes#ST-12). */}
        <OneJobCard actions={<>
          <Tooltip text={accepted ? '' : 'Tick the box to continue'}>
            <Button
              variant="danger"
              disabled={!accepted}
              onClick={() => { onDefaultsChange({ skipPermissions: true }); close(); }}
            >
              Turn it on
            </Button>
          </Tooltip>
          <Button variant="secondary" onClick={close}>Cancel</Button>
        </>}>
          <OneJobText>
            <p>
              When you begin a session in skip permissions mode, Claude Code will not ask before taking
              actions or running commands. You should be cautious when attempting to use this mode with
              Haiku- or Sonnet-class models.
            </p>
          </OneJobText>
          <ConsentRow checked={accepted} onChange={setAccepted}>
            I understand, and I use Skip permissions at my own risk.
          </ConsentRow>
        </OneJobCard>
      </Dialog>
    </section>
  );
}
