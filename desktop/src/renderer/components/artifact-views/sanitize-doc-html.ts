import DOMPurify from 'dompurify';

/**
 * Cleans the HTML mammoth produces from a .docx before it is inlined into the
 * app's page.
 *
 * WHY (2026-09-10 security review): mammoth copies a document's link targets
 * verbatim, so a `javascript:` link inside a downloaded .docx ran in the app —
 * with window.claude — when clicked, and a `file://` link could navigate the
 * window away. Text, headings, tables and embedded images come through unchanged.
 *
 * Links after cleaning:
 *  - http(s) and mailto open in a new window, which the desktop shell hands to the
 *    system browser (main.ts setWindowOpenHandler) — the route chat links take.
 *    Before this, clicking one did nothing on desktop.
 *  - `#bookmark` links keep scrolling within the document.
 *  - anything else loses its href and stays as plain text.
 */
let docPurify: typeof DOMPurify | null = null;

function purifier(): typeof DOMPurify {
  if (docPurify) return docPurify;
  // A PRIVATE instance, created on first use: the link hook below must never run
  // over the mascot sanitizer, which uses the default instance.
  const instance = DOMPurify(window);
  instance.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName !== 'A' || !node.hasAttribute('href')) return;
    const href = (node.getAttribute('href') ?? '').trim();
    if (/^(https?:|mailto:)/i.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else if (!href.startsWith('#')) {
      node.removeAttribute('href');
    }
  });
  docPurify = instance;
  return instance;
}

export function sanitizeDocHtml(html: string): string {
  return purifier().sanitize(html, { ADD_ATTR: ['target'] });
}
