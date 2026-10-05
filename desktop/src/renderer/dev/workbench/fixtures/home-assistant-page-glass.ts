// The Home page on glass (owner, 2026-10-05): "i want it to peek through to the real theme background … the office word editor
// currently does this". Replaces the Background setting (Plain / Frosted / House colours), which he did not want.
//
// The app puts <html data-yc-see-through> on a page ONLY while the page pane is glass over the theme's wallpaper and the page's
// "Show theme background" switch is on; the style kit then makes the page's own backdrop transparent. This file does the page's
// part: the big room and settings cards become glass like the app's own panes — the theme's panel colour at the theme's panel
// opacity — so the wallpaper reads through them. Everything below sits behind that attribute, so with it absent (plain themes, the
// switch off) not one rule matches and the page is pixel-identical to before.
//
// WHY NO backdrop-filter on the cards: the app allows one blur and never one per card (react-renderer.md, performance.md); the pane
// behind the page already carries the blur. The card fill is 60% of the pane's own density: the pane behind the page is already the
// theme's panel colour at its panels-opacity, so a card at the SAME density stacked on it read as a near-solid slab (first picture,
// 2026-10-05) and hid the wallpaper; at 60% it still lifts off the pane while the wallpaper reads through, and small text stays
// readable (the two layers together are ~85% panel colour on a 0.74 theme). Borders, the top highlight and the glow of anything that is ON are left exactly as the look layer
// draws them. The smaller tiles inside a card keep their own fill (they are lifted off the glass, which is what reads as a card).
// Template string: no backticks, no dollar-brace, no backslashes.
export const HOME_GLASS_CSS = `
  :root[data-yc-see-through] .yc-card.room, :root[data-yc-see-through] .yc-card.set-sec {
    background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 6%, transparent), transparent 55%),
      color-mix(in srgb, var(--panel) calc(var(--panels-opacity, 1) * 60%), transparent); }
  /* The thermostat card (a room card / Favourites, and the big one on the Climate tab) was drawn in --inset, which is a solid pale slab
     on light wallpaper themes (owner: it "stays opaque white while the other cards are glass"). Same light glass as the cards, at the
     same 60%; the dial's track and buttons keep their own fills (they lift off the glass like the other tiles' controls). */
  :root[data-yc-see-through] .th-hero {
    background: linear-gradient(180deg, color-mix(in srgb, var(--fg) 6%, transparent), transparent 55%),
      color-mix(in srgb, var(--panel) calc(var(--panels-opacity, 1) * 60%), transparent); }
  :root[data-yc-see-through] .th-now { stroke: color-mix(in srgb, var(--panel) 80%, transparent); }
`;
