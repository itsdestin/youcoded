import { diffRowsFromStrings, type DiffRow } from './diff-rows';

export type DiffRequest = { oldStr: string; newStr: string };
export type DiffReply = { ok: true; rows: DiffRow[] } | { ok: false };

// WHY a browser worker: even the collapsed 15-row preview used to compute a
// large unrelated comparison synchronously, freezing chat before drawing it.
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<DiffRequest>) => void;
  postMessage: (reply: DiffReply) => void;
};
scope.onmessage = ({ data }) => {
  try { scope.postMessage({ ok: true, rows: diffRowsFromStrings(data.oldStr, data.newStr) }); }
  catch { scope.postMessage({ ok: false }); }
};
