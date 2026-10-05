import './brand.css';
import appIcon from './app-icon-192.png';

/**
 * The stacked YouCoded logo: the glass app icon, "youcoded" under it, the tagline under
 * that. Every measure is a brand decision (DECISIONS.md, rounds 9–26): Outfit SemiBold at
 * −3.5% tracking, "you" in the purple-to-pink gradient, the tagline at 0.34× the name's
 * size pulled 6px tighter at a 36px name (v26 STACK sc). `size` is the name's height in px;
 * the icon and gaps scale with it, so the logo keeps its proportions at any size.
 */
export function BrandLockup({ size = 36, tagline = true }: { size?: number; tagline?: boolean }) {
  const k = size / 36;
  return (
    <div className="flex flex-col items-center select-none" aria-label="YouCoded" role="img">
      <img src={appIcon} alt="" width={68 * k} height={68 * k} className="brand-icon" draggable={false} />
      <span className="brand-name" style={{ fontSize: size, marginTop: 10 * k }}>
        <span className="brand-name__you">you</span>coded
      </span>
      {tagline && (
        <span className="brand-tagline" style={{ fontSize: size * 0.34, marginTop: 2 * k, lineHeight: 1 }}>
          agents for everyone
        </span>
      )}
    </div>
  );
}
