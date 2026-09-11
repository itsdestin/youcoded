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
  // The cast: DOMPurify 3.4.x's factory param requires a `trustedTypes` property,
  // which this TypeScript DOM lib does not declare on Window — a types-only gap
  // (every browser this runs in has window.trustedTypes). Cast to exactly the
  // parameter type rather than `any` so the rest of the call stays checked.
  const instance = DOMPurify(window as unknown as Parameters<typeof DOMPurify>[0]);
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
  // Fail CLOSED (2026-09-10 review): if DOMPurify reports itself unsupported it
  // returns its input unchanged, and this is the ONLY defense on mammoth's raw
  // HTML — a silent pass-through of any javascript:/onerror it produced. Throw so
  // DocxView shows its error state instead of inlining unsanitized markup.
  if (!DOMPurify.isSupported) throw new Error('document viewer unavailable');
  // ADD_ATTR keeps `target` (not in the default allowlist) so the link hook's
  // target=_blank survives; the default profile permits it on no element where it
  // would do harm.
  return purifier().sanitize(html, { ADD_ATTR: ['target'] });
}
