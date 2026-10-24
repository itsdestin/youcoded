import { Workbook } from 'exceljs';
import XlsxParseWorker from './xlsx-parse.worker?worker';
import type { XlsxParseReply } from './xlsx-parse.worker';
import { extractSheets, PlainSheet } from './xlsx-extract';

export interface XlsxParseJob { promise: Promise<PlainSheet[]>; cancel: () => void }
type Spawn = () => Pick<Worker, 'onmessage' | 'onerror' | 'postMessage' | 'terminate'>;

/** The old behaviour, kept as the safety net: parse on the page. Used only when no worker can be started. */
async function parseOnPage(bytes: Uint8Array): Promise<PlainSheet[]> {
  const wb = new Workbook();
  await wb.xlsx.load(bytes.buffer as any);
  return extractSheets(wb).map((d) => new PlainSheet(d));
}

/**
 * Open a workbook without freezing the page. WHY: see xlsx-parse.worker.ts. Falls back to the in-page parse when a
 * Worker cannot be created (very old WebView, blocked worker script, test environment) AND when the worker itself
 * fails before answering; a file that is genuinely not a spreadsheet then fails the same way it always did.
 */
export function parseXlsx(bytes: Uint8Array, spawn: Spawn | null = defaultSpawn()): XlsxParseJob {
  let cancelled = false;
  let worker: ReturnType<Spawn> | undefined;
  const promise = new Promise<PlainSheet[]>((resolve, reject) => {
    const fallback = () => { if (!cancelled) parseOnPage(bytes).then(resolve, reject); };
    if (!spawn) { fallback(); return; }
    try {
      worker = spawn();
      worker.onmessage = (event: MessageEvent<XlsxParseReply>) => {
        worker?.terminate();
        const reply = event.data;
        if (reply?.ok) resolve(reply.sheets.map((d) => new PlainSheet(d)));
        else reject(new Error(reply && 'error' in reply ? reply.error : 'parse failed'));
      };
      worker.onerror = (event) => { event.preventDefault?.(); worker?.terminate(); fallback(); };
      // Copy: the caller keeps its bytes (other readers may share the buffer), a transfer would detach them.
      const copy = bytes.slice().buffer;
      worker.postMessage({ bytes: copy }, [copy] as any);
    } catch { fallback(); }
  });
  return { promise, cancel: () => { cancelled = true; worker?.terminate(); } };
}

function defaultSpawn(): Spawn | null {
  return typeof Worker === 'undefined' ? null : () => new XlsxParseWorker();
}
