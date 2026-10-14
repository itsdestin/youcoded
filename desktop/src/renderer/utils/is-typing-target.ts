// ONE answer to "is the user typing here?" for every global keyboard shortcut.
//
// The app's global shortcuts (composer auto-focus, Shift-hold session
// switcher, arrow chat scroll, permission-prompt keys, Shift+Space model
// cycle, Shift+Tab permission cycle) all guarded on tagName INPUT/TEXTAREA —
// which the CodeMirror artifact editor is neither: it is a contenteditable
// DIV (spec 2026-07-20 §12.6). Before this helper existed, typing in the code
// editor yanked focus into the composer, and a stray key could reach a
// permission prompt. Every capture/window-level key handler must use this
// instead of re-implementing the tag check.
export function isTypingTarget(el: Element | null | undefined): boolean {
  const h = el as HTMLElement | null;
  if (!h) return false;
  const tag = h.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (h.isContentEditable) return true;
  // closest() also covers CM6 sub-elements that are not themselves marked
  // contenteditable (gutters, panels) — keys there belong to the editor.
  // [data-keyboard-owner]: a surface that sends every key on (the Browser
  // panel's page picture types into the page) — no shortcut may take them.
  return !!h.closest?.('.cm-editor, [data-keyboard-owner]');
}
