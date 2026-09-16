import { useEffect, useState } from 'react';
import type { ArtifactViewProps } from './types';
import { BinaryContent, CenterNote } from './BinaryContent';
import { sanitizeDocHtml } from './sanitize-doc-html';

// @ts-ignore mammoth.browser lacks type declarations
import mammoth from 'mammoth/mammoth.browser';

export function DocxView({ absolutePath }: ArtifactViewProps) {
  // BinaryContent owns loading/error for the byte read and remounts the inner
  // component per file, so html/parseError can't go stale across switches.
  return (
    <BinaryContent absolutePath={absolutePath} noun="document">
      {(bytes) => <DocxContent bytes={bytes} />}
    </BinaryContent>
  );
}

function DocxContent({ bytes }: { bytes: Uint8Array }) {
  const [html, setHtml] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // mammoth wants an ArrayBuffer; pass the bytes' underlying buffer.
    mammoth
      .convertToHtml({ arrayBuffer: bytes.buffer })
      // Cleaned before it is ever stored for render — see sanitize-doc-html.ts.
      .then((result: any) => { if (!cancelled) setHtml(sanitizeDocHtml(result.value)); })
      .catch((e: any) => { if (!cancelled) setParseError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [bytes]);

  if (parseError) return <CenterNote>Couldn’t open this document.</CenterNote>;
  if (html === null) return <CenterNote>Loading document…</CenterNote>;

  return (
    // .doc-html (globals.css) styles the converted headings/lists/tables with
    // theme tokens. The previous `prose dark:prose-invert` classes were inert —
    // the Tailwind typography plugin isn't installed, and `dark:` follows the OS
    // scheme rather than the active YouCoded theme — so docx bodies rendered as
    // flat unstyled text under the preflight reset.
    <div
      className="doc-html overflow-auto h-full p-4 max-w-none"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
