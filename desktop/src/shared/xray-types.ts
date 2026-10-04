// desktop/src/shared/xray-types.ts
//
// The wire shape of `window.claude.xray` — the developer X-ray view's reader of a
// session's saved file. Shared by main (the reader), preload/remote-shim (the
// bridge) and the renderer (the view), so all of them agree on one shape.

/** What normal chat did with a saved line. Main decides it by running the
 *  chat's own transcript reader over that line. `trimmed` = shown, but with
 *  part of its text removed (a reminder tag, terminal colour codes). */
export type XrayChatFate = 'shown' | 'hidden' | 'trimmed';

/** One saved line, exactly as written. */
export interface XrayRawLine {
  /** 1-based line number in the saved file. */
  n: number;
  raw: string;
  chat: XrayChatFate;
}

export type XrayFormat = 'claude-code' | 'native';

export type XrayReadResult =
  | {
      ok: true;
      /** The saved file's full path, shown so a fixing session can open it. */
      file: string;
      format: XrayFormat;
      /** Lines in the whole file; `lines` may be only the newest of them. */
      total: number;
      lines: XrayRawLine[];
    }
  | { ok: false; error: 'no-file' | 'read-failed'; detail?: string };

export interface XrayBridge {
  /** The newest `limit` lines before line `before` (default: the end). */
  read(sessionId: string, opts?: { before?: number; limit?: number }): Promise<XrayReadResult>;
  /** Lines appended to the file after the last read, as they are written. */
  onLines(sessionId: string, cb: (lines: XrayRawLine[]) => void): () => void;
}
