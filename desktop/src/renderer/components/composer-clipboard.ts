// Is this clipboard a picture, rather than words that happen to come with one?
// Read by the composer's paste handler (InputBar) to decide between attaching
// the picture and letting the browser paste text.
//
// WHY (Destin, 2026-11-18: Ctrl+V of a Chrome "Copy image" did nothing, while
// right-click → Paste worked): Chrome's Copy image puts the picture AND a small
// HTML snippet (`<img src="…">`) on the clipboard. The old rule — "any text/*
// item means it's a text paste" — saw that snippet as text and stepped aside,
// and a textarea cannot paste HTML, so nothing happened. A screenshot tool puts
// only the picture there, which is why it worked "sometimes".
// Words still win whenever real words were copied: a page selection, or a
// spreadsheet range (Excel and LibreOffice add a picture of the cells too).
export function isImageOnlyClipboard(data: Pick<DataTransfer, 'items' | 'getData'>): boolean {
  if (!Array.from(data.items ?? []).some((item) => item.type.startsWith('image/'))) return false;
  const html = data.getData('text/html');
  let imageSources: string[] = [];
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Real words in the HTML → the person copied text; let the normal paste run.
    if ((doc.body.textContent ?? '').trim()) return false;
    imageSources = Array.from(doc.images, (img) => img.getAttribute('src') ?? '');
  }
  const plain = data.getData('text/plain').trim();
  // No plain text, or the plain text is only the picture's own address.
  return !plain || imageSources.includes(plain);
}
