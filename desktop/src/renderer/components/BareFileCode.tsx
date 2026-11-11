import React from 'react';
import { useArtifactSelectorOptional } from '../state/ArtifactContext';
import { looksLikeExtension } from '../hooks/useInlineFilepathDetector';
import { FilepathToken } from './FilepathToken';

// WHY (2026-11-01 phone test): "I created `pancakes.md` in your home directory" showed the name as plain code, while a
// reply that spelled out a folder ("notes/tacos.md") became a tappable file chip. The path finder
// (useInlineFilepathDetector) deliberately needs a folder separator, so ordinary words like "plan.md" or "e.g." in
// prose never turn into buttons. That guess is right in general but wrong when the chat KNOWS the file: it created or
// edited it this session. So an inline-code span that is only a bare file name becomes the chip when exactly one file
// with that name is on this session's file list. Anything else stays code, as before.
const BARE_NAME_RE = /^[\w][\w.-]*\.([A-Za-z0-9]+)$/;

/** The inline `code` renderer for a chat message that has a session: a bare file name this session worked on is a file chip. */
export function BareFileCode({ sessionId, Base, ...rest }: { sessionId: string; Base: React.ElementType } & Record<string, any>) {
  const text = typeof rest.children === 'string' ? rest.children : null;
  const m = rest['data-block'] === undefined && text ? BARE_NAME_RE.exec(text) : null;
  const name = m && looksLikeExtension(m[1]) ? text : null;
  // Selector returns an existing record or undefined (never a new object), so it only re-renders when the answer moves.
  const record = useArtifactSelectorOptional((s) => {
    if (!name) return undefined;
    const hits = (s.sessionArtifacts[sessionId] ?? []).filter((a) => {
      const p = ((a.kind === 'internal' ? a.path : a.absolutePath) ?? '').replace(/\\/g, '/');
      return p.split('/').pop() === name;
    });
    // Two different files with one name: refuse to guess which is meant.
    return hits.length === 1 ? hits[0] : undefined;
  });
  const cwd = useArtifactSelectorOptional((s) => s.sessionCwd?.[sessionId]);
  if (!record || !name) return <Base {...rest} />;
  const full = record.kind === 'internal'
    ? (cwd ? cwd.replace(/[\\/]+$/, '') + '/' + record.path : record.path)
    : record.absolutePath;
  if (!full) return <Base {...rest} />;
  return <FilepathToken path={full} sessionId={sessionId} />;
}
