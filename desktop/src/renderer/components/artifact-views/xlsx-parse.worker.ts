import { Workbook } from 'exceljs';
import { extractSheets, type PlainSheetData } from './xlsx-extract';

export type XlsxParseReply = { ok: true; sheets: PlainSheetData[] } | { ok: false; error: string };

// WHY a browser worker: ExcelJS's unzip + XML parse of a big sheet (200,000 rows: ~1.8 s) used to run on the page's
// own thread and froze the whole app window. Here it freezes nothing; only the cells the viewer can draw come back.
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ bytes: ArrayBuffer }>) => void;
  postMessage: (reply: XlsxParseReply) => void;
};
scope.onmessage = async ({ data }) => {
  try {
    const wb = new Workbook();
    await wb.xlsx.load(data.bytes as any);
    scope.postMessage({ ok: true, sheets: extractSheets(wb) });
  } catch (e: any) {
    scope.postMessage({ ok: false, error: String(e?.message ?? e) });
  }
};
