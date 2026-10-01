// model.ts — the remembered model choice (model:get-preference / set-preference) and "which model did
// this transcript last run on" (model:read-last), one table entry each, served to windows and phones.
// (The plural `models:*` channels are the local-model downloader, a different family.)
//
// WHY (2026-09-30 one-core R3-5): written twice; the computer's copy read and wrote with synchronous
// disk calls on the main process, the phone's with async ones. One async body now, so neither door can
// stall the app on a slow disk.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IPC } from '../../shared/backend-contract';
import { defineChannel, type MainChannelDef } from './channel-def';

// Resolved per call, like the phone's copy was, so a changed home folder in a test is honoured.
const modelPrefPath = () => path.join(os.homedir(), '.claude', 'youcoded-model.json');

// WHY (2026-09-30 one-core R3-6, R3-5 review): the screen fires model:set-preference without waiting, and
// the write is async, so (a) a read could land on a half-written file and fall back to 'sonnet', and (b) two
// quick sets could finish out of order and leave the OLDER choice on disk. Writes now go to a temp file and
// are renamed into place (a reader sees the old file or the new one, never half of one), one at a time per
// file, in the order they were asked. No existing async atomic-write helper in the codebase (searched:
// the one in chatsearch-index is synchronous, which would block the main process).
const writeChains = new Map<string, Promise<unknown>>();
let writeCounter = 0;
function writeFileAtomicQueued(file: string, content: string): Promise<void> {
  const run = async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${++writeCounter}`;
    try {
      await fs.promises.writeFile(tmp, content);
      await fs.promises.rename(tmp, file);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  };
  const next = (writeChains.get(file) ?? Promise.resolve()).then(run, run);
  // The chain must keep going after a failed write, and must not hold a finished file in the map forever.
  const settled = next.catch(() => {});
  writeChains.set(file, settled);
  void settled.then(() => { if (writeChains.get(file) === settled) writeChains.delete(file); });
  return next;
}

export const modelChannels: MainChannelDef[] = [
  defineChannel({
    name: IPC.MODEL_GET_PREFERENCE, kind: 'handle',
    handler: async () => {
      try { return JSON.parse(await fs.promises.readFile(modelPrefPath(), 'utf8')).model || 'sonnet'; }
      catch { return 'sonnet'; }
    },
  }),
  defineChannel({
    name: IPC.MODEL_SET_PREFERENCE, kind: 'handle',
    handler: async ({ model }) => {
      try {
        await writeFileAtomicQueued(modelPrefPath(), JSON.stringify({ model }));
        return true;
      } catch { return false; }
    },
  }),
  // The last assistant message's model field from a JSONL transcript. Accepts { transcriptPath } or a raw
  // string (Android and the phone's page wrap it differently) and rejects anything outside
  // ~/.claude/projects BEFORE reading, so it cannot be used to read an arbitrary file.
  defineChannel({
    name: IPC.MODEL_READ_LAST, kind: 'handle',
    handler: async (payload) => {
      const transcriptPath = (payload && typeof payload === 'object' && 'transcriptPath' in payload)
        ? (payload as { transcriptPath: unknown }).transcriptPath
        : payload;
      if (typeof transcriptPath !== 'string') return null;
      try {
        const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
        const resolved = path.resolve(transcriptPath);
        // + path.sep so a sibling like ~/.claude/projects-evil cannot pass the prefix check
        if (!resolved.startsWith(claudeProjects + path.sep)) return null;
        const lines = (await fs.promises.readFile(transcriptPath, 'utf-8')).trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i]);
            if (entry.type === 'assistant' && entry.message?.model) return entry.message.model;
          } catch { continue; }
        }
        return null;
      } catch { return null; }
    },
  }),
];
