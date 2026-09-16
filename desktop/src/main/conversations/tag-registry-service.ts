// src/main/conversations/tag-registry-service.ts
// Module singleton for the tag registry (design §"Storage & sync layout").
// Mirrors conversations/service.ts: reads the Personal sync space's managed root
// and owns the createTagRegistry instance. Works with sync OFF — the Tags dir is
// created on first write regardless of the enable flag (same as conversations).
import path from 'node:path';
import { createTagRegistry, TagRegistry } from './tag-registry';
import { getManagedRoots } from '../sync-spaces/service';
import type { TagRecord } from '../../shared/tags';

let registry: TagRegistry | null = null;

export function getTagRegistry(): TagRegistry | null { return registry; }

/**
 * The tag list as a host answers `tags:list`: the list, or `{ ok: false, error }`.
 *
 * WHY (error inventory 2026-09-10, false message 16): main's handler and remote-server's
 * each turned an absent or unreadable registry into [], so every screen read a failed
 * read as "this person has no tags" — the tag manager said "No tags yet — create one
 * above" to someone who had tags. One answer for both hosts, so they cannot drift again;
 * useTagRegistry turns the failure into "Couldn't load your tags". The reason is said
 * without a guessed cause: an absent registry is only known to be absent.
 */
export async function listTagsForHost(): Promise<TagRecord[] | { ok: false; error: string }> {
  if (!registry) return { ok: false, error: "tag storage isn't available" };
  try {
    return await registry.list();
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message ? e.message : 'the tag list could not be read' };
  }
}

export function startTagRegistry(opts?: { tagsRoot?: string }): void {
  stopTagRegistry();
  const personalRoot = getManagedRoots()?.personalRoot;
  const root = opts?.tagsRoot ?? (personalRoot ? path.join(personalRoot, 'Tags') : null);
  if (!root) return; // managed roots unavailable — registry stays off this launch
  registry = createTagRegistry(root);
}

function stopTagRegistry(): void {
  registry = null;
}
