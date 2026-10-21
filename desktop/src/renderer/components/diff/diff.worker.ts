import { diffRowsFromStrings, type DiffRow } from './diff-rows';

export type DiffRequest = { oldStr: string; newStr: string };
export type DiffReply = { ok: true; rows: DiffRow[] } | { ok: false };

// WHY a browser worker: even the collapsed 15-row preview used to compute a
// 10,000-line unrelated comparison synchronously, freezing chat for 16 seconds.
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<DiffRequest>) => void;
  postMessage: (reply: DiffReply) => void;
};
scope.onmessage = ({ data }) => {
  try { scope.postMessage({ ok: true, rows: diffRowsFromStrings(data.oldStr, data.newStr) }); }
  catch { scope.postMessage({ ok: false }); }
};
