import { Button, Dialog } from './ui';

const DONATE_URL = 'https://buymeacoffee.com/itsdestin';

/**
 * "Okay to open donation link?" confirmation (change 30).
 *
 * This existed as two BYTE-IDENTICAL 41-line blocks in SettingsPanel.tsx — one in
 * AndroidSettings, one in DesktopSettings. Both were live; the duplication came
 * from the platform split, not from dead code. Converting each in place would
 * have left two copies of the converted thing, so it is one component now.
 *
 * L3, not the old hardcoded z-[9999]. It is a confirmation gate, which is what L3
 * is for, and 9999 was only ever reaching over the 9000 host band — nothing in
 * that band can be open while a settings sub-modal is up.
 */
export function DonateConfirm({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;

  // P-15: every dialog carries the shared header so it has a visible title and
  // a ✕ — this one had neither. Dialog already portals itself, so the extra
  // createPortal wrapper it used to sit in is gone too.
  return (
    <Dialog
      screen="settings/donate"
      open
      onClose={onClose}
      layer={3}
      size="prompt"
      title="Support YouCoded"
      scrollBody={false}
    >
      {/* P-15 review (2026-08-26): with a real header and ✕, the "Cancel" button
          is redundant — the ✕ IS cancel — so the dialog is one explanation and
          one action. */}
      <div className="p-5 space-y-4">
        <div className="flex items-center gap-2">
          {/* Custom coffee-mug icon: body + handle + rising steam. Ties to "Buy Me a Coffee" label via BMC yellow. */}
          <svg className="w-5 h-5 text-[#FFDD00] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 2v2M11 2v2M15 2v2" />
            <path d="M3 8h14v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z" />
            <path d="M17 11h2a2.5 2.5 0 0 1 0 5h-2" />
          </svg>
          <span className="text-sm font-bold text-fg">Buy Me a Coffee</span>
        </div>
        <p className="text-xs text-fg-muted">
          Donations are handled by Buy Me a Coffee. The link opens in your browser.
        </p>
        {/* Change 52: hover:brightness-110 was invisible on Light/Creme's
            near-black accent and blew out the glow packs. */}
        <Button
          onClick={() => {
            window.open(DONATE_URL, '_blank');
            onClose();
          }}
          className="w-full py-2.5"
        >
          Open Buy Me a Coffee
        </Button>
      </div>
    </Dialog>
  );
}
