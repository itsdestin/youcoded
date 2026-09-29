// modes.ts — fast mode + effort level (~/.claude/youcoded-model-modes.json).
//
// WHY (2026-09-30 one-core R3-1): identical bodies on both doors except sync vs async file
// calls; one body now, async (a phone's call must not freeze the computer's windows). These are not verified from transcripts (Claude Code does not
// record them there): local state is trusted, and the ModelPickerPopup is the source of truth.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IPC } from '../../shared/backend-contract';
import { defineChannel, type MainChannelDef } from './channel-def';

const DEFAULT_MODES = { fast: false, effort: 'auto' };
// Resolved per call (not at load): the home folder is a test's to redirect.
const modesPath = () => path.join(os.homedir(), '.claude', 'youcoded-model-modes.json');

export const modesChannels: MainChannelDef[] = [
  defineChannel({
    name: IPC.MODES_GET, kind: 'handle',
    handler: async () => {
      try { return JSON.parse(await fs.promises.readFile(modesPath(), 'utf-8')); } catch { return { ...DEFAULT_MODES }; }
    },
  }),
  defineChannel({
    name: IPC.MODES_SET, kind: 'handle',
    handler: async (payload) => {
      try {
        let current = { ...DEFAULT_MODES };
        try { current = { ...current, ...JSON.parse(await fs.promises.readFile(modesPath(), 'utf-8')) }; } catch { /* no file yet */ }
        const merged = { ...current, ...payload };
        await fs.promises.mkdir(path.dirname(modesPath()), { recursive: true });
        await fs.promises.writeFile(modesPath(), JSON.stringify(merged));
        return merged;
      } catch {
        return null;
      }
    },
  }),
];
