import { useEffect, useState } from 'react';
import type { ArtifactViewProps } from './types';
import { BinaryContent, CenterNote } from './BinaryContent';
import { sanitizeDocHtml } from './sanitize-doc-html';
// Doc comments (Destin, questions deck Q-4: Word comments "work fully
// natively"): a Word document gets the same highlights, hover card and
// comment pane as a markdown file — CommentableDocument is that shared layout.
import { CommentableDocument } from '../comments/CommentableDocument';

// @ts-ignore mammoth.browser lacks type declarations
import mammoth from 'mammoth/mammoth.browser';

export function DocxView({ absolutePath, path, commentsMode, onOpenComments, focusThreadId }: ArtifactViewProps) {
  // BinaryContent owns loading/error for the byte read and remounts the inner
  // component per file, so html/parseError can't go stale across switches.
  return (
    <BinaryContent absolutePath={absolutePath} noun="document">
      {(bytes) => (
        <DocxContent
          bytes={bytes}
          path={path}
          commentsMode={commentsMode}
          onOpenComments={onOpenComments}
          focusThreadId={focusThreadId}
        />
      )}
    </BinaryContent>
  );
}

type CommentProps = Pick<ArtifactViewProps, 'path' | 'commentsMode' | 'onOpenComments' | 'focusThreadId'>;

function DocxContent({ bytes, path, commentsMode, onOpenComments, focusThreadId }: { bytes: Uint8Array } & CommentProps) {
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
    <CommentableDocument
      path={path}
      commentsMode={commentsMode}
      onOpenComments={onOpenComments}
      focusThreadId={focusThreadId}
      source="rendered"
      contentClassName="doc-html max-w-none"
    >
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </CommentableDocument>
  );
}
