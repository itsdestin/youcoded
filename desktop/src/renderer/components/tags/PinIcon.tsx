// The pin that marks a session pinned to the top of its lists — Priority's face since
// pick-menus-2#PM2-3. One glyph, so the sessions menu, Resume and Tags & note agree.
export function PinIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 17v5M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5Z" />
    </svg>
  );
}
