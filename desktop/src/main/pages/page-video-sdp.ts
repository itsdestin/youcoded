// What the app lets through from a camera's WebRTC answer (spec 2026-10-04,
// Part 2, R2-7 / R3-5).
//
// WHY: the answer comes from the approved device, but it names network
// addresses the app's own peer connection will then dial. A device (or whatever
// sits between it and the app) must not be able to make the app dial this
// computer, a cloud-metadata address or a link-local address, nor an address
// that is only a name (a name is looked up later, where no home-address check
// runs). Anything that breaks the rule is dropped; the rest passes untouched.
import { isIP } from 'node:net';
import { isNeverDialIp } from '../harness/tools/net-guard';

/** A usable candidate address: an IP literal that is not on the never-dial list. */
const usableAddress = (a: string): boolean => isIP(a) !== 0 && !isNeverDialIp(a);

/** A control character (CR, LF, NUL, ...). WHY refused inside a candidate: only the first line of a
 *  value was ever looked at, so "good\r\na=candidate:... 127.0.0.1" carried a second, unchecked line. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The fields of one candidate line (`candidate:<id> <comp> <proto> <prio> <addr> <port> typ <type> ...`),
 *  or null when it is malformed, has a control character, or the type word is missing. The address is f[4]. */
function candidateFields(line: string): string[] | null {
  if (CONTROL.test(line)) return null;
  const body = line.replace(/^a=/i, '').trim();
  if (!/^candidate:/i.test(body)) return null;
  const f = body.split(/\s+/);
  return f.length >= 8 && f[6].toLowerCase() === 'typ' ? f : null;
}

/** An address a c= / a=rtcp line may carry: a usable literal, or the "no address" forms. */
const okOrNone = (a: string): boolean => usableAddress(a) || a === '0.0.0.0' || a === '::';

/** Filter an answer SDP. `a=candidate` lines naming a hostname, or a never-dial
 *  address, are dropped (as are `a=remote-candidates` and `a=rtcp` address
 *  lines that break the rule). A `c=` line that breaks the rule becomes the
 *  standard "no address, use the candidates" form `0.0.0.0` rather than being
 *  removed, so the rest of the answer stays a valid SDP. `usable` counts the
 *  candidate lines that survive. */
export function filterAnswerSdp(sdp: string): { sdp: string; usable: number } {
  let usable = 0;
  const out: string[] = [];
  // WHY \r alone also ends a line: a bare CR is a line break to some parsers, so
  // text after it must be checked as its own line, not hidden inside this one.
  for (const line of sdp.split(/\r\n|\r|\n/)) {
    if (/^a=(remote-)?candidate/i.test(line)) {
      if (/^a=remote-candidates/i.test(line)) continue;
      const f = /^a=candidate:/i.test(line) ? candidateFields(line) : null;
      if (f !== null && usableAddress(f[4])) { usable++; out.push(line); }
      continue;
    }
    // WHY every c= line is judged by its exact shape: a regex that only matched
    // one spelling ("c=IN IP4 x") let "c=IN  IP4 127.0.0.1" through untouched.
    // Anything but exactly `c=IN IP4|IP6 <address>` with an allowed address is
    // rewritten to the "no address, use the candidates" form.
    if (/^c=/i.test(line)) {
      const c = /^c=IN (IP4|IP6) (\S+)$/.exec(line);
      if (c && okOrNone(c[2])) { out.push(line); continue; }
      const six = /^c=\s*in\s+ip6\b/i.test(line);
      out.push(six ? 'c=IN IP6 ::' : 'c=IN IP4 0.0.0.0');
      continue;
    }
    // An rtcp line is kept only as a bare port or an exact, allowed address; anything unparsable is dropped.
    if (/^a=rtcp:/i.test(line)) {
      const r = /^a=rtcp:\d+(?: IN (IP4|IP6) (\S+))?$/.exec(line);
      if (r && (r[2] === undefined || okOrNone(r[2]))) out.push(line);
      continue;
    }
    out.push(line);
  }
  return { sdp: out.join('\r\n'), usable };
}

/** One trickled candidate from the device: a string, or an object holding one
 *  (an RTCIceCandidateInit). Returns the JSON to hand the host, or null when it
 *  must be dropped (a hostname, a never-dial address, malformed, containing a line break, or the empty
 *  end-of-candidates marker). Only the four standard fields are passed on. */
export function filterCandidate(value: unknown): string | null {
  const init = typeof value === 'string' ? { candidate: value } : value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!init || typeof init.candidate !== 'string' || init.candidate.length > 1024) return null;
  const f = candidateFields(init.candidate);
  if (f === null || !usableAddress(f[4])) return null;
  // Rebuilt from the parsed fields (single spaces), never the original text.
  const out: Record<string, unknown> = { candidate: f.join(' ') };
  if (typeof init.sdpMid === 'string' && init.sdpMid.length <= 64) out.sdpMid = init.sdpMid;
  if (typeof init.sdpMLineIndex === 'number' && Number.isInteger(init.sdpMLineIndex) && init.sdpMLineIndex >= 0 && init.sdpMLineIndex < 16) out.sdpMLineIndex = init.sdpMLineIndex;
  if (typeof init.usernameFragment === 'string' && init.usernameFragment.length <= 64) out.usernameFragment = init.usernameFragment;
  return JSON.stringify(out);
}
