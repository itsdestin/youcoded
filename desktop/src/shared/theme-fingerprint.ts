// theme-fingerprint.ts — a short "what the theme store lists for this theme's files" stamp.
//
// WHY: the marketplace "Update" badge for a theme used to look only at the version number.
// A theme edited in place without a version bump (Morning Rounds, 1.0.0 -> 1.0.0 with a new
// mascot) therefore never offered Update. The theme store lists a SHA-256 for every file
// (`fileHashes`) and, on older entries, one `contentHash`; both change only when the files
// change. We stamp the installed record with this value at install/update time and flag an
// update when the listed value differs.
//
// Pure JS (no node crypto) because the main process (to record) and the renderer (to compare)
// must compute exactly the same string from the same registry entry.

export interface FingerprintSource {
  fileHashes?: Record<string, string>;
  contentHash?: string;
}

// cyrb53-style 53-bit string hash, twice with different seeds, so the stamp stays short in the
// synced config file. It only has to notice "something changed", not resist an attacker (the
// installer's own SHA-256 check is what protects the download).
function hash53(str: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * The stamp for a registry entry, or undefined when the entry lists nothing to compare
 * (such a theme stays quiet rather than guessing). The prefix names the kind of evidence so a
 * stamp recorded from one kind is never compared with the other (a registry that gains
 * `fileHashes` later must not make every older `contentHash` install look changed).
 */
export function themeFingerprint(entry: FingerprintSource | null | undefined): string | undefined {
  if (!entry) return undefined;
  const fh = entry.fileHashes;
  if (fh && typeof fh === 'object' && Object.keys(fh).length > 0) {
    // Sorted so key order in the registry file can never change the stamp.
    const canon = Object.keys(fh).sort().map(k => `${k}=${String(fh[k]).toLowerCase()}`).join('\n');
    return `fh:${hash53(canon, 0)}${hash53(canon, 1)}`;
  }
  if (typeof entry.contentHash === 'string' && entry.contentHash) return `ch:${entry.contentHash.toLowerCase()}`;
  return undefined;
}

/**
 * True only when BOTH sides carry the same kind of stamp and the values differ. Missing on either
 * side (installs made before this existed, local themes, entries with no hashes) is "no news".
 */
export function themeFilesChanged(recorded: string | undefined, listed: string | undefined): boolean {
  if (!recorded || !listed) return false;
  if (recorded.slice(0, 3) !== listed.slice(0, 3)) return false;
  return recorded !== listed;
}
