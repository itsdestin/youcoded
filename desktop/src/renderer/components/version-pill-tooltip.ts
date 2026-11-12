// The words on the status bar's version pill tooltip, kept as a plain function so a test can pin them.
interface PillStatus { current: string; latest: string; update_available: boolean; downloaded?: boolean; managed_by_other_package?: boolean }

export function versionPillTooltip(s: PillStatus): string {
  // WHY (card #186): an install owned by another package (AUR youcoded-bin) still shows the glowing
  // pill, but the popup cannot download for it. "click to download" would promise what the popup then
  // refuses, so this case names the real route. The pill's look is unchanged.
  if (s.update_available && s.managed_by_other_package) return `Update available: v${s.latest} — update it with your package manager`;
  if (s.update_available && s.downloaded) return `v${s.latest} is downloaded — click to restart and update`;
  if (s.update_available) return `Update available: v${s.latest} — click to download`;
  return `YouCoded v${s.current}`;
}
