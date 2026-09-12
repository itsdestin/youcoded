import { announce } from '../../utils/announce';

// Save a copy of a file to THIS device — remote access batch 3 (questions deck
// 2026-09-10, Q-7 yes). One helper for the three places that offer it (the
// session drawer's toolbar, the Project View file header, the too-big card), so
// they cannot drift in wording or in what they do when the host says no.
//
// The channel resolves as soon as the host has accepted the request; the bytes
// then arrive through the browser's own download, which is what shows progress
// and the finished file. The toast is the acknowledgement the tester missed
// (2026-09-10, U1/U2): without it a tap on Download looked like nothing.
/**
 * The host's refusal codes (remote-download.ts, remote-server.ts), in words.
 * Each code is ONE decision the host made, so each sentence says only that —
 * 'not-allowed' covers several and names none (T7 review, finding 8: it used
 * to say "outside the folders" for a private file inside a project). Anything
 * else is shown as the host gave it, never guessed at
 * (docs/error-message-standards.md).
 */
const REFUSALS: Record<string, string> = {
  'busy': 'two downloads are already running on this connection. Wait for one to finish.',
  'sensitive': 'it’s in a private location (like keys, passwords or .env files) that remote access never sends.',
  'outside-roots': 'this file is outside the folders remote access can read.',
  'not-a-file': 'that isn’t a file.',
  'orphan': 'the file is no longer on the computer.',
  'not-allowed': 'the computer won’t send this file.',
  'no path': 'the file has no path.',
};

export async function downloadFile(absolutePath: string, opts?: { projectRoot?: string; artifactId?: string }): Promise<void> {
  const name = absolutePath.split('/').pop() ?? absolutePath;
  const download = (window.claude as any)?.artifacts?.download;
  if (typeof download !== 'function') {
    announce(`Download isn’t available here.`);
    return;
  }
  try {
    const res = await download(absolutePath, opts);
    if (res && res.ok) {
      announce(`Saving ${name} to this device…`);
    } else {
      // The host's own reason when it gives one; never a guess.
      const reason = typeof res?.error === 'string' ? (REFUSALS[res.error] ?? res.error) : null;
      announce(reason ? `Couldn’t download ${name}: ${reason}` : `Couldn’t download ${name}.`, 5000);
    }
  } catch (err: any) {
    announce(err?.message ? `Couldn’t download ${name}: ${String(err.message)}` : `Couldn’t download ${name}.`, 5000);
  }
}
