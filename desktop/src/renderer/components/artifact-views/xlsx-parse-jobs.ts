import { Workbook } from 'exceljs';
import XlsxParseWorker from './xlsx-parse.worker?worker';
import type { XlsxParseReply } from './xlsx-parse.worker';
import { extractSheets, PlainSheet } from './xlsx-extract';

export interface XlsxParseJob { promise: Promise<PlainSheet[]>; cancel: () => void }
type Spawn = () => Pick<Worker, 'onmessage' | 'onerror' | 'postMessage' | 'terminate'>;

/** WHY a time limit (card #161, same 60 s as Word): a crafted spreadsheet can keep the reader busy forever, which left
 *  the viewer on "Loading spreadsheet" with no way out. A 200,000-row sheet reads in ~2 s, so 60 s only ever cuts off a
 *  file that would never finish. */
export const XLSX_PARSE_TIME_LIMIT_MS = 60_000;

/** Thrown when the time limit passes, so the viewer can say exactly that rather than a generic failure. */
export class XlsxParseTimeoutError extends Error {
  constructor() { super('spreadsheet reading took longer than the time limit'); this.name = 'XlsxParseTimeoutError'; }
}

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
export function parseXlsx(bytes: Uint8Array, spawn: Spawn | null = defaultSpawn(), timeLimitMs = XLSX_PARSE_TIME_LIMIT_MS): XlsxParseJob {
  let cancelled = false;
  let worker: ReturnType<Spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<PlainSheet[]>((origResolve, origReject) => {
    const stop = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const resolve = (v: PlainSheet[]) => { stop(); origResolve(v); };
    const reject = (e: unknown) => { stop(); origReject(e); };
    // WHY: on expiry stop the worker (it may be spinning on a hostile file) and fail, so the viewer leaves "Loading".
    timer = setTimeout(() => { timer = undefined; worker?.terminate(); origReject(new XlsxParseTimeoutError()); }, timeLimitMs);
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
  return { promise, cancel: () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); timer = undefined; worker?.terminate(); } };
}

function defaultSpawn(): Spawn | null {
  return typeof Worker === 'undefined' ? null : () => new XlsxParseWorker();
}
