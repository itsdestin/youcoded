// @ts-ignore mammoth.browser lacks type declarations
import mammoth from 'mammoth/mammoth.browser';
import DocxConvertWorker from './docx-convert.worker?worker';
import type { DocxConvertReply } from './docx-convert.worker';

export interface DocxConvertJob { promise: Promise<string>; cancel: () => void }
type Spawn = () => Pick<Worker, 'onmessage' | 'onerror' | 'postMessage' | 'terminate'>;

/** The old behaviour, kept as the safety net: convert on the page. Used only when no worker can be started. */
async function convertOnPage(bytes: Uint8Array): Promise<string> {
  // mammoth wants an ArrayBuffer; pass the bytes' underlying buffer.
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
  return result.value;
}

/** Word -> HTML without freezing the page (see docx-convert.worker.ts). Falls back to the in-page conversion when
 *  a Worker cannot be created or dies before answering; a real conversion error is passed on as an error. */
export function convertDocx(bytes: Uint8Array, spawn: Spawn | null = defaultSpawn()): DocxConvertJob {
  let cancelled = false;
  let worker: ReturnType<Spawn> | undefined;
  const promise = new Promise<string>((resolve, reject) => {
    const fallback = () => { if (!cancelled) convertOnPage(bytes).then(resolve, reject); };
    if (!spawn) { fallback(); return; }
    try {
      worker = spawn();
      worker.onmessage = (event: MessageEvent<DocxConvertReply>) => {
        worker?.terminate();
        const reply = event.data;
        if (reply?.ok) resolve(reply.html);
        else reject(new Error(reply && 'error' in reply ? reply.error : 'conversion failed'));
      };
      worker.onerror = (event) => { event.preventDefault?.(); worker?.terminate(); fallback(); };
      // Copy: the caller keeps its bytes; a transfer would detach them.
      const copy = bytes.slice().buffer;
      worker.postMessage({ bytes: copy }, [copy] as any);
    } catch { fallback(); }
  });
  return { promise, cancel: () => { cancelled = true; worker?.terminate(); } };
}

function defaultSpawn(): Spawn | null {
  return typeof Worker === 'undefined' ? null : () => new DocxConvertWorker();
}
