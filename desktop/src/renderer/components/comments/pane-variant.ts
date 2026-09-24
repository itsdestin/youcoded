// Which framing the Comments-mode side pane uses — a DESIGN-REVIEW selector
// (Destin, round 15: "i want to see a few different ways to style/frame/place
// the side panel with the comments"). Read from `?commentsPane=` on the
// workbench URL, which WorkbenchFrame forwards to the app verbatim. Once a
// framing is picked, the losers and this file go; nothing ships reading a URL.
//
//   column — full-height column, divider line, panel background (round 14)
//   sheet  — a rounded, bordered panel inset from the pane's edges
//   margin — no column chrome: cards sit on the document's own background
//   titled — the Session Files pane's shape: a title row ("Comments 4" +
//            Show resolved) over the list
//   combined — DEFAULT (round 16, Destin: "the rounded corners and such of
//            sheet, the bigger panel from column, and the title from
//            titled… show resolved should be a toggle at the top like show
//            completed in resume browser")
export type PaneVariant = 'combined' | 'column' | 'sheet' | 'margin' | 'titled';

const VARIANTS: readonly PaneVariant[] = ['combined', 'column', 'sheet', 'margin', 'titled'];

/** Framings whose title row carries Show resolved — only Ask Your Assistant
 *  floats at the bottom in these. */
export function hasTitleRow(v: PaneVariant): boolean {
  return v === 'titled' || v === 'combined';
}

export function readPaneVariant(): PaneVariant {
  try {
    const v = new URLSearchParams(window.location.search).get('commentsPane');
    return (VARIANTS as readonly string[]).includes(v ?? '') ? (v as PaneVariant) : 'combined';
  } catch {
    return 'combined';
  }
}
