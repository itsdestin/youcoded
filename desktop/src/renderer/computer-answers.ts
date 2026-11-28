// The phone app's "couldn't connect" check: is the computer there at all? Split out of remote-shim.ts
// (its line budget) — remote-shim's socket close calls it before choosing which sentence to show.

/** The phone app's two "couldn't connect" sentences (Destin, 2026-11-18, release wording deck W-1). */
export const PHONE_COMPUTER_TOO_OLD = 'Please update YouCoded on your computer to use remote access.';
export const PHONE_COMPUTER_UNREACHABLE = 'Unable to reach your computer: please ensure YouCoded is open and Tailscale is enabled on both devices.';
const COMPUTER_ANSWERS_TIMEOUT_MS = 3_000;

/** Does anything answer plain web requests at the computer's address? WHY: a computer still on
 *  v1.3.3 refuses the phone app's page address, so its socket closes before opening exactly like an
 *  unreachable one; a web request (any answer, even a refusal) tells them apart. `no-cors` because
 *  only "an answer came back" matters, never its content. Never throws. */
export async function computerAnswers(wsUrl: string, timeoutMs = COMPUTER_ANSWERS_TIMEOUT_MS): Promise<boolean> {
  let httpUrl: string;
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/'; u.search = ''; u.hash = '';
    httpUrl = u.toString();
  } catch { return false; }
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
  try {
    await fetch(httpUrl, { mode: 'no-cors', cache: 'no-store', signal: ctrl?.signal });
    return true;
  } catch { return false; } finally { clearTimeout(timer); }
}
