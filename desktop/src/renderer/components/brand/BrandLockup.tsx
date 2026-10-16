/**
 * The YouCoded name with its tagline stacked under it — setup's logo (deck first-run-6
 * P6-2, no icon). The side-by-side lockup with the icon and the stacked one with the icon
 * were tried on setup and dropped; the approved drawings stay in the brand session's
 * boards (workspace docs/active/design/2026-10-01-brand-identity-v2).
 */
export function BrandWordmark({ size, tagline }: { size: number | string; tagline: 'stack' | 'none' }) {
  // WHY em units: setup passes a size that follows the window (a CSS clamp), so every
  // measure below is a share of the name's size and the proportions hold at any size.
  // From the approved stacked board (v26 STACK sc): −6px and a 16px line at a 36px name,
  // tagline 0.34× the name.
  return (
    <div className="flex flex-col items-center select-none" style={{ fontSize: size, lineHeight: 'normal' }} aria-label="YouCoded" role="img">
      <span className="brand-name" style={{ fontSize: '1em' }}>
        <span className="brand-name__you">you</span>coded
      </span>
      {/* The tagline sits in a block with its own line (16px at a 36px name), as on the board;
          the −6px pull is measured from that line. Without it the tagline sat on the "y"
          (rejected, deck first-run-6). */}
      {tagline === 'stack' && (
        <div style={{ marginTop: `${-6 / 36}em`, fontSize: `${16 / 36}em`, lineHeight: 'normal' }}>
          <span className="brand-tagline inline-block" style={{ fontSize: `${0.34 * 36 / 16}em` }}>agents for everyone</span>
        </div>
      )}
    </div>
  );
}
