// Shared by preparation and the delivery adapter: limits apply AFTER file-path instructions are assembled.
export const CLAUDE_QUEUE_WIRE_LIMITS = {
  maxCharacters: 262_144,
  // JSON string encoding is measured, leaving room inside the bridge's 1 MiB envelope for identity/lease metadata.
  maxJsonBytes: 512 * 1024,
} as const;
