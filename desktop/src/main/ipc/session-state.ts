// session-state.ts — the per-session maps that more than one group of handlers reads and writes.
//
// WHY (2026-09-29 one-core R1): these were locals of registerIpcHandlers, so they could only
// be shared by living in one giant function. The runtime owns ONE copy and hands it to every
// door and every handler group — never one copy per file, which would silently split the
// state (a topic watcher started by one group would be invisible to the group that stops it).
import type * as fs from 'fs';
import { createProvisionalTitles } from '../native-resume-title';

export interface SessionState {
  /** desktop session id -> Claude Code (or native, identity-mapped) conversation id. */
  sessionIdMap: Map<string, string>;
  /** Last model id written to the store per CLAUDE session id, so a repeat is never re-written.
   *  Bounded in practice by sessions opened this run, one short string each. */
  lastModelSeen: Map<string, string>;
  /** Auto-title topic-file watchers (fs watcher, or the polling interval fallback), by desktop id. */
  topicWatchers: Map<string, fs.FSWatcher | NodeJS.Timeout>;
  /** Last topic APPLIED as a title per desktop id (only set when the title was really applied). */
  lastTopics: Map<string, string>;
  /** Opening-words names planted on a resumed, never-titled native session's pill
   *  (native-resume-title.ts). Shared by the resume handler and the namer's title checks. */
  provisionalResumeTitles: ReturnType<typeof createProvisionalTitles>;
  /** Quit teardown: close every topic watcher and forget all mappings. */
  dispose(): void;
}

export function createSessionState(): SessionState {
  const state: SessionState = {
    sessionIdMap: new Map(),
    lastModelSeen: new Map(),
    topicWatchers: new Map(),
    lastTopics: new Map(),
    provisionalResumeTitles: createProvisionalTitles(),
    dispose() {
      for (const watcher of state.topicWatchers.values()) {
        if (typeof (watcher as fs.FSWatcher).close === 'function') {
          (watcher as fs.FSWatcher).close();
        } else {
          clearInterval(watcher as NodeJS.Timeout);
        }
      }
      state.topicWatchers.clear();
      state.lastTopics.clear();
      state.sessionIdMap.clear();
    },
  };
  return state;
}
