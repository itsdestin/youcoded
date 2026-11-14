// The engine's own output, kept on disk (~/.youcoded/engine/engine.log).
//
// WHY (2026-10-29): llama-server's output used to live only in a 4,000-character
// memory tail used for startup errors, so a load that took 40 s instead of 12 s
// left nothing anyone could read afterwards. This keeps the whole stream, per
// machine (the engine folder is not synced), bounded: past MAX_BYTES the file
// becomes engine.log.1 (replacing the previous one) and a fresh file starts.
//
// Never allowed to affect the engine: every write is async and every failure is
// swallowed — a full disk or a read-only folder only means no log.
//
// What it holds: llama.cpp's log lines (load steps, memory sizes, timings,
// errors). At the verbosity we run it does not print prompt or reply text.

import * as fs from 'fs';

const MAX_BYTES = 4 * 1024 * 1024;

export interface EngineLog {
  /** Mark the start of a spawn, so one file's runs can be told apart. */
  begin(args: readonly string[]): void;
  write(chunk: Buffer | string): void;
}

export function openEngineLog(filePath: string, maxBytes = MAX_BYTES): EngineLog {
  let stream: fs.WriteStream | null = null;
  let size = 0;
  let rotating = false;
  let failed = false;

  // Opened on first write: the folder is the one models.ini was just written to
  // before the spawn, so it exists — no blocking mkdir needed.
  const open = () => {
    stream = fs.createWriteStream(filePath, { flags: 'a' });
    stream.on('error', () => { stream = null; failed = true; }); // no log beats a crash
  };

  const rotate = () => {
    if (rotating || !stream) return;
    rotating = true;
    const old = stream;
    stream = null;
    old.end(() => {
      fs.promises.rename(filePath, `${filePath}.1`).catch(() => { /* keep appending to the same file */ })
        .finally(() => { size = 0; rotating = false; });
    });
  };

  const write = (chunk: Buffer | string) => {
    if (rotating || failed) return;
    if (!stream) open();
    const n = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    stream!.write(chunk);
    size += n;
    if (size > maxBytes) rotate();
  };

  // Size the existing file once, at open, so a long-lived file still rotates.
  fs.promises.stat(filePath).then((st) => { size += st.size; }, () => { /* new file */ });

  return {
    begin: (args) => write(`\n===== ${new Date().toISOString()} engine start: ${args.join(' ')}\n`),
    write,
  };
}
