// first-frames.ts — a phone's sign-in and first requests carried in the socket's opening request (2026-10-22 phone speed).
//
// WHY: after the socket opened, the phone sent its sign-in and early requests and waited one more round trip (~470 ms on
// Destin's phone) for the answers. A WebSocket's opening request can name "subprotocols", which reach the computer WITH the
// upgrade, so the phone puts those first messages there and the computer answers them in the same flight as its "connected".
//
// The phone offers three names, in this order:
//   'youcoded'                  — what a computer that knows nothing of this picks (ws picks the first offered when the server
//                                 has no handleProtocols), so the phone sees it and sends its messages itself, as before;
//   'youcoded-first-frames'     — what a computer that took the messages picks: the phone sends nothing more;
//   'yc-frames.<base64url>'     — the messages: a JSON array of the frames' text, base64url so every character is allowed in a
//                                 subprotocol name.

export const PLAIN_PROTOCOL = 'youcoded';
export const TOOK_FRAMES_PROTOCOL = 'youcoded-first-frames';
const FRAMES_PREFIX = 'yc-frames.';

/** Largest encoded name accepted. Header limits are ~8–16 KB; the sign-in and two requests are well under 1 KB. */
const MAX_FRAMES_CHARS = 8 * 1024;
const MAX_FRAMES = 16;

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(data: string): string {
  const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** The subprotocol list for a socket carrying `frames` (already-serialised messages), or null when they do not fit. */
export function firstFrameProtocols(frames: string[]): string[] | null {
  if (frames.length === 0 || frames.length > MAX_FRAMES) return null;
  const name = FRAMES_PREFIX + toBase64Url(JSON.stringify(frames));
  return name.length > MAX_FRAMES_CHARS ? null : [PLAIN_PROTOCOL, TOOK_FRAMES_PROTOCOL, name];
}

/** The frames an opening request carries, from its offered subprotocols, or null when it carries none (or anything malformed). */
export function readFirstFrames(protocols: Iterable<string>): string[] | null {
  const offered = [...protocols];
  if (!offered.includes(TOOK_FRAMES_PROTOCOL)) return null;
  const name = offered.find((p) => p.startsWith(FRAMES_PREFIX));
  if (!name || name.length > MAX_FRAMES_CHARS) return null;
  try {
    const frames: unknown = JSON.parse(fromBase64Url(name.slice(FRAMES_PREFIX.length)));
    if (!Array.isArray(frames) || frames.length === 0 || frames.length > MAX_FRAMES || !frames.every((f) => typeof f === 'string')) return null;
    return frames as string[];
  } catch {
    return null;
  }
}
