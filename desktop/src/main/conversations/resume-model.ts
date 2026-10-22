// resume-model.ts — which Claude model a resumed Claude Code conversation
// launches on when the screen that resumed it did not choose one.
//
// WHY (found 2026-10-21): every screen used to fill the gap itself, and each
// filled it differently — the open tab's model, a hard-coded 'sonnet' before
// the saved defaults had loaded, or a record a helper agent had overwritten.
// An Opus conversation reopened after a crash came back on Sonnet. The
// conversation's own history is the one answer that cannot be wrong, so main
// reads it here, for every caller on both doors, just before the launch.
import { claudeAliasForModelId } from '../../shared/model-ids';
import { readSessionTranscriptMeta } from '../session-browser';
import { readDefaults } from '../prefs-service';
import { getConversationStore } from './service';

export interface ResumeModelSources {
  /** `message.model` of the last real main-conversation assistant line in the
   *  local transcript, or null/undefined when there is no local transcript or
   *  its tail holds none. */
  transcriptModelId: () => Promise<string | null | undefined>;
  /** The conversation record's lastUsedModel id — the copy that travels with a
   *  conversation synced in from another device. */
  storedModelId: () => Promise<string | null | undefined>;
  /** The app's saved default Claude model (Settings → defaults). */
  defaultModel: () => string | null | undefined | Promise<string | null | undefined>;
}

/** The alias to pass as `--model`, or undefined to leave the choice to Claude
 *  Code's own settings. A source that throws or names no Claude family counts
 *  as silent and the next one answers. */
export async function resolveResumeModel(src: ResumeModelSources): Promise<string | undefined> {
  // Transcript first: it is what actually ran, and it cannot hold a helper's
  // model (helpers write their own files). The record can, if it was written
  // by a build from before conversationModelOf existed.
  for (const read of [src.transcriptModelId, src.storedModelId]) {
    try {
      const id = await read();
      const alias = id ? claudeAliasForModelId(id) : null;
      if (alias) return alias;
    } catch { /* silent source — try the next */ }
  }
  try {
    const fallback = await src.defaultModel();
    if (typeof fallback === 'string' && fallback) return fallback;
  } catch { /* no saved default */ }
  return undefined;
}

/** `opts` with the conversation's own model filled in when it is a Claude Code
 *  resume that names none. A model the person picked in a resume form always
 *  wins, and every other session passes through untouched. `jsonlPath` is the
 *  local transcript (snapshotResumeBoundary), absent when there is none. */
export async function withResumeModel<T extends { provider?: string; resumeSessionId?: string; model?: string }>(
  opts: T, jsonlPath: string | undefined,
): Promise<T> {
  if (opts.provider !== 'claude' || !opts.resumeSessionId || opts.model) return opts;
  const conversationId = opts.resumeSessionId;
  const model = await resolveResumeModel({
    transcriptModelId: async () => (jsonlPath ? (await readSessionTranscriptMeta(jsonlPath, false)).lastModelId : null),
    storedModelId: async () => (await getConversationStore()?.get('claude', conversationId))?.lastUsedModel?.modelId,
    defaultModel: async () => (await readDefaults()).model,
  });
  return model ? { ...opts, model } : opts;
}
