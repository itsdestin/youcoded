// Copy for the conversation-lease takeover dialog (Destin sign-off 2026-07-23;
// 'force' lead reworded 2026-09-21 — the hub relays the request but gets no
// acknowledgement back (room.ts sets ok before safeSend, which swallows closed
// sockets), so "didn't answer" claimed more than the system can know. Chosen
// from lease-handoff deck Q-7).
// Extracted from App.tsx as a pure function so the approved strings are
// pinnable (tests/takeover-dialog-copy.test.ts) and future copy edits are
// deliberate rather than a drive-by JSX tweak. Returns RAW strings with
// `device` already interpolated — the `font-medium` bold-device span for
// 'undeliverable'/'force' stays a JSX concern in App.tsx (this module has no
// JSX dependency), which splits `lead` on the device substring to wrap it.
export type TakeoverDialogPhase = 'confirm' | 'force' | 'undeliverable';

export interface TakeoverDialogCopy {
  // First paragraph. Always present.
  lead: string;
  // Second paragraph — the "you can still take over, here's the tradeoff"
  // explainer. Absent for 'confirm', which is a single-paragraph ask.
  consequence?: string;
}

export function takeoverDialogCopy(phase: TakeoverDialogPhase, device: string): TakeoverDialogCopy {
  switch (phase) {
    case 'confirm':
      return { lead: `This session is active on ${device} — take over here?` };
    case 'undeliverable':
      // The hub had no delivery path — the other device was never asked. Do NOT
      // blame it for "not responding" (that's the 'force' phase, a different,
      // honest claim about a request that WAS delivered).
      return {
        lead: `This conversation is open on ${device}, and that device can't be reached right now.`,
        consequence: `You can still take over. When ${device} reconnects it will stop and save on its own — but anything it writes before then is kept as a separate copy, not added to this conversation.`,
      };
    case 'force':
      return {
        // The hub cannot distinguish "asked, no reply" from "the handoff
        // finished after our poll gave up" — both look like a timeout. State
        // only what is known: no confirmed handoff.
        lead: `We couldn't confirm that ${device} handed off this conversation. It may be offline or busy.`,
        consequence: `You can still take over. When ${device} catches up it will stop and save on its own — but anything it writes before then is kept as a separate copy, not added to this conversation.`,
      };
  }
}
