// @ts-ignore mammoth.browser lacks type declarations
import mammoth from 'mammoth/mammoth.browser';
import DocxConvertWorker from './docx-convert.worker?worker';
import type { DocxConvertReply } from './docx-convert.worker';

export interface DocxConvertJob { promise: Promise<string>; cancel: () => void }
type Spawn = () => Pick<Worker, 'onmessage' | 'onerror' | 'postMessage' | 'terminate'>;

/** WHY a time limit (card #161): a crafted Word file can keep the converter busy forever, which left the viewer on
 *  "Loading document" with no way out. A real document of any size we have measured converts in well under a second
 *  (~0.5 s for ~800 pages), so 60 s only ever cuts off a file that would never finish. */
export const DOCX_CONVERT_TIME_LIMIT_MS = 60_000;

/** Thrown when the time limit passes, so the viewer can say exactly that rather than a generic failure. */
export class DocxConvertTimeoutError extends Error {
  constructor() { super('document conversion took longer than the time limit'); this.name = 'DocxConvertTimeoutError'; }
}

/** WHY includeEmbeddedStyleMap: false (card #161): a .docx may carry its own "style map" (only Mammoth's own tool
 *  writes one), and Mammoth's reader for it can take exponential time on a crafted file. Real Word documents never
 *  have one, so ignoring it changes nothing a user sees. Shared by the worker and the on-page fallback. */
const MAMMOTH_OPTIONS = { includeEmbeddedStyleMap: false } as const;

/** The old behaviour, kept as the safety net: convert on the page. Used only when no worker can be started. */
async function convertOnPage(bytes: Uint8Array): Promise<string> {
  // mammoth wants an ArrayBuffer; pass the bytes' underlying buffer.
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer }, MAMMOTH_OPTIONS);
  return result.value;
}

/** Word -> HTML without freezing the page (see docx-convert.worker.ts). Falls back to the in-page conversion ONLY
 *  when a Worker cannot be created; a worker that crashes, a real conversion error, or the time limit passing are
 *  all passed on as errors. */
export function convertDocx(bytes: Uint8Array, spawn: Spawn | null = defaultSpawn(), timeLimitMs = DOCX_CONVERT_TIME_LIMIT_MS): DocxConvertJob {
  let cancelled = false;
  let worker: ReturnType<Spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<string>((resolve, reject) => {
    const finish = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const ok = (html: string) => { finish(); resolve(html); };
    const fail = (e: unknown) => { finish(); reject(e); };
    // WHY: on expiry stop the worker (it may be spinning on a hostile file) and fail, so the viewer leaves "Loading".
    timer = setTimeout(() => { timer = undefined; worker?.terminate(); reject(new DocxConvertTimeoutError()); }, timeLimitMs);
    const fallback = () => { if (!cancelled) convertOnPage(bytes).then(ok, fail); };
    if (!spawn) { fallback(); return; }
    try {
      worker = spawn();
    } catch { fallback(); return; } // no worker on this platform: the old on-page conversion
    try {
      worker.onmessage = (event: MessageEvent<DocxConvertReply>) => {
        worker?.terminate();
        const reply = event.data;
        if (reply?.ok) ok(reply.html);
        else fail(new Error(reply && 'error' in reply ? reply.error : 'conversion failed'));
      };
      // WHY no on-page retry here (card #161): a worker that crashed mid-conversion may have crashed BECAUSE of the
      // file; re-running that file on the page could freeze the whole window. Fail instead.
      worker.onerror = (event) => { event.preventDefault?.(); worker?.terminate(); fail(new Error('the document converter stopped unexpectedly')); };
      // Copy: the caller keeps its bytes; a transfer would detach them.
      const copy = bytes.slice().buffer;
      worker.postMessage({ bytes: copy }, [copy] as any);
    } catch {
      // The file never reached the worker (it could not be handed over), so this is still "no usable worker", not a
      // crash caused by the file: the on-page conversion is safe to use here.
      worker.terminate(); worker = undefined; fallback();
    }
  });
  return { promise, cancel: () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); timer = undefined; worker?.terminate(); } };
}

function defaultSpawn(): Spawn | null {
  return typeof Worker === 'undefined' ? null : () => new DocxConvertWorker();
}
