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
export type PaneVariant = 'column' | 'sheet' | 'margin' | 'titled';

const VARIANTS: readonly PaneVariant[] = ['column', 'sheet', 'margin', 'titled'];

export function readPaneVariant(): PaneVariant {
  try {
    const v = new URLSearchParams(window.location.search).get('commentsPane');
    return (VARIANTS as readonly string[]).includes(v ?? '') ? (v as PaneVariant) : 'column';
  } catch {
    return 'column';
  }
}
