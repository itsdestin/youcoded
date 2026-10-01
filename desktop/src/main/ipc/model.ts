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
        await fs.promises.mkdir(path.dirname(modelPrefPath()), { recursive: true });
        await fs.promises.writeFile(modelPrefPath(), JSON.stringify({ model }));
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
