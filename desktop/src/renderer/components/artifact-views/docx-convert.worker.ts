// @ts-ignore mammoth.browser lacks type declarations
import mammoth from 'mammoth/mammoth.browser';

export type DocxConvertReply = { ok: true; html: string } | { ok: false; error: string };

// WHY a browser worker (freeze hunt, 2026-10-24): mammoth's unzip + XML read + HTML build of an ~800-page text
// document held the page ~0.5 s. It needs no DOM, so it runs here and only the finished HTML string comes back;
// the cleaning step (DOMPurify, which does need the page) stays in DocxView.
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ bytes: ArrayBuffer }>) => void;
  postMessage: (reply: DocxConvertReply) => void;
};
scope.onmessage = async ({ data }) => {
  try {
    // WHY includeEmbeddedStyleMap: false (card #161): ignore a file's own embedded style map, whose reader can take
    // exponential time on a crafted file. Same options as MAMMOTH_OPTIONS in docx-convert-jobs.ts (written out here
    // because importing that module would pull the worker constructor into the worker itself).
    const result = await mammoth.convertToHtml({ arrayBuffer: data.bytes }, { includeEmbeddedStyleMap: false });
    scope.postMessage({ ok: true, html: result.value });
  } catch (e: any) {
    scope.postMessage({ ok: false, error: String(e?.message ?? e) });
  }
};
