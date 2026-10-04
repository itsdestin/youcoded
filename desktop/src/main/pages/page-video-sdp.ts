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

/** The address field of one candidate line (`candidate:<id> <comp> <proto> <prio> <addr> <port> typ <type> ...`), or null when the line is malformed. */
function candidateAddress(line: string): string | null {
  const body = line.replace(/^a=/, '').trim();
  if (!body.startsWith('candidate:')) return null;
  const f = body.split(/\s+/);
  return f.length >= 8 && f[6] === 'typ' ? f[4] : null;
}

/** Filter an answer SDP. `a=candidate` lines naming a hostname, or a never-dial
 *  address, are dropped (as are `a=remote-candidates` and `a=rtcp` address
 *  lines that break the rule). A `c=` line that breaks the rule becomes the
 *  standard "no address, use the candidates" form `0.0.0.0` rather than being
 *  removed, so the rest of the answer stays a valid SDP. `usable` counts the
 *  candidate lines that survive. */
export function filterAnswerSdp(sdp: string): { sdp: string; usable: number } {
  let usable = 0;
  const out: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('a=candidate:')) {
      const addr = candidateAddress(line);
      if (addr !== null && usableAddress(addr)) { usable++; out.push(line); }
      continue;
    }
    if (line.startsWith('a=remote-candidates')) continue;
    const c = /^c=IN (IP4|IP6) (\S+)/.exec(line);
    if (c) {
      const ok = usableAddress(c[2]) || c[2] === '0.0.0.0' || c[2] === '::';
      out.push(ok ? line : `c=IN ${c[1]} ${c[1] === 'IP6' ? '::' : '0.0.0.0'}`);
      continue;
    }
    const r = /^a=rtcp:\d+ IN (IP4|IP6) (\S+)/.exec(line);
    if (r && !(usableAddress(r[2]) || r[2] === '0.0.0.0' || r[2] === '::')) continue;
    out.push(line);
  }
  return { sdp: out.join('\r\n'), usable };
}

/** One trickled candidate from the device: a string, or an object holding one
 *  (an RTCIceCandidateInit). Returns the JSON to hand the host, or null when it
 *  must be dropped (a hostname, a never-dial address, malformed, or the empty
 *  end-of-candidates marker). Only the four standard fields are passed on. */
export function filterCandidate(value: unknown): string | null {
  const init = typeof value === 'string' ? { candidate: value } : value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!init || typeof init.candidate !== 'string' || init.candidate.length > 1024) return null;
  const addr = candidateAddress(init.candidate);
  if (addr === null || !usableAddress(addr)) return null;
  const out: Record<string, unknown> = { candidate: init.candidate };
  if (typeof init.sdpMid === 'string' && init.sdpMid.length <= 64) out.sdpMid = init.sdpMid;
  if (typeof init.sdpMLineIndex === 'number' && Number.isInteger(init.sdpMLineIndex) && init.sdpMLineIndex >= 0 && init.sdpMLineIndex < 16) out.sdpMLineIndex = init.sdpMLineIndex;
  if (typeof init.usernameFragment === 'string' && init.usernameFragment.length <= 64) out.usernameFragment = init.usernameFragment;
  return JSON.stringify(out);
}
