// src/shared/tags.ts
// Shared tag constants + the renderer-facing TagRecord shape. Imported by both
// the Electron main process (registry IO) and the React renderer (Tag Picker),
// so the palette and id conventions have exactly one definition.

// The 10 fixed themed color slots (design §"Color palette"). These are SLOT
// KEYS, never raw hex — theme-engine.ts maps each to a theme-legible color so a
// tag stays readable on every theme. Order is the swatch order shown in the UI.
export const TAG_COLORS = [
  'tag-red', 'tag-orange', 'tag-amber', 'tag-green', 'tag-teal',
  'tag-blue', 'tag-indigo', 'tag-purple', 'tag-pink', 'tag-gray',
] as const;

export type TagColor = typeof TAG_COLORS[number];

// Default color for tags created without an explicit color, and the clamp
// target for any unrecognized color read off disk.
export const DEFAULT_TAG_COLOR: TagColor = 'tag-gray';

export function isTagColor(v: unknown): v is TagColor {
  return typeof v === 'string' && (TAG_COLORS as readonly string[]).includes(v);
}

// Tag ids are prefixed so they're visually distinct in the flag map's
// `tag:<id>` keys and can never collide with a reserved flag name.
export const TAG_ID_PREFIX = 'tag_';

// A conversation record's flag key for an applied tag.
export function tagFlagKey(tagId: string): string {
  return `tag:${tagId}`;
}

// The renderer-facing tag shape (the internal store record is a superset with
// per-field timestamps; the registry's list/create/update return this).
export interface TagRecord {
  id: string;
  label: string;
  color: TagColor;
  archived: boolean;
  createdAt: string;
}

// ── What the tags:* channels answer (one-core R3-1; the contract's request/response types) ──

/** A failed host answer. Never an empty list: see listTagsForHost. */
type TagFailure = { ok: false; error: string };
/** tags:list — the list, or why it could not be read. */
export type TagListResult = TagRecord[] | TagFailure;
/** tags:create / tags:update */
export type TagMutationResult = { ok: true; tag: TagRecord } | TagFailure;
/** tags:delete */
export type TagDeleteResult = { ok: true } | TagFailure;
/** tags:update's patch: only the fields being changed. */
export interface TagPatch { label?: string; color?: TagColor | string; archived?: boolean }
