import DOMPurify from 'dompurify';

/**
 * Sanitizes a theme-provided rig SVG before it is inlined into the buddy DOM.
 *
 * SECURITY BOUNDARY: themes are third-party content, and inline SVG executes
 * in our renderer with access to window.claude. Everything that can run
 * script or reach the network is stripped; only static drawing content,
 * same-document references (#id) and embedded data:image/* rasters survive.
 *
 * Three passes, and the LAST one is the guarantee (2026-09-10 security review):
 *  1. Parse as XML and keep only elements and text. The markup is read as XML
 *     here but re-read as HTML when React inlines it, and the two readers
 *     disagree about where a comment or a `<?…?>` ends — text hidden inside one
 *     came back as a live `<img onerror>` in the page.
 *  2. The tag blocklist, compared case-insensitively (XML is case-sensitive, so
 *     `<FOREIGNOBJECT>` walked past a lowercase match), and the attribute scrub.
 *  3. DOMPurify over the serialized result. It parses with the same HTML parser
 *     the page uses, so whatever survives it is exactly what the page will build.
 * wecoded-themes CI (scripts/audit-svg-safety.mjs) rejects the same tricks at
 * submission, but a hand-installed theme never passes through it.
 *
 * Returns the sanitized SVG markup, or null when the input isn't a parseable SVG.
 */
const BLOCKED_TAGS = new Set([
  'script', 'foreignobject', 'iframe', 'object', 'embed', 'link', 'meta', 'style',
  'animate', 'animatetransform', 'animatemotion', 'set',
]);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

const PURIFY_SVG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  // `<use href="#part">` reuses a part of the same drawing, a documented rig
  // capability DOMPurify leaves out by default. DOMPurify still strips any href
  // on it that is not a same-document reference.
  ADD_TAGS: ['use'],
  FORBID_TAGS: ['style', 'animate', 'animateTransform', 'animateMotion', 'set', 'foreignObject'],
};

/** Pass 3 on its own, for SVG markup assembled from an already-inlined rig (the
 *  buddy's peek hands re-serialize part of the live rig with outerHTML). */
export function purifySvgMarkup(markup: string): string {
  return DOMPurify.sanitize(markup, PURIFY_SVG);
}

export function sanitizeRigSvg(svgText: string): string | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  } catch {
    return null;
  }
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null;

  // Pass 1 — elements and text only. Copy childNodes before walking: removing
  // from a live NodeList while iterating it skips the next sibling.
  const keepElementsAndText = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === ELEMENT_NODE) keepElementsAndText(child);
      else if (child.nodeType === CDATA_SECTION_NODE) node.replaceChild(doc.createTextNode(child.nodeValue ?? ''), child);
      else if (child.nodeType !== TEXT_NODE) node.removeChild(child);
    }
  };
  keepElementsAndText(root);

  // Pass 2 — blocklist, then attributes.
  for (const el of Array.from(root.getElementsByTagName('*'))) {
    if (BLOCKED_TAGS.has(el.localName.toLowerCase())) el.parentNode?.removeChild(el);
  }

  const scrub = (el: Element): void => {
    // Array.from, not spread — the repo tsconfig lacks DOM.Iterable.
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (name === 'href' || name === 'xlink:href') {
        if (!(value.startsWith('#') || value.toLowerCase().startsWith('data:image/'))) {
          el.removeAttribute(attr.name);
        }
      } else if (name === 'style' && /url\s*\(\s*['"]?\s*(?!#|data:image\/)/i.test(value)) {
        // fill:url(https://…) can exfiltrate via fetch — allow only #refs/data images.
        el.removeAttribute(attr.name);
      }
    }
    for (const child of Array.from(el.children)) scrub(child);
  };
  scrub(root);

  // Pass 3 — the guarantee.
  const clean = purifySvgMarkup(new XMLSerializer().serializeToString(root));
  return /^\s*<svg[\s>]/i.test(clean) ? clean : null;
}
