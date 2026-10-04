// Camera video played by the app (spec 2026-10-04, Part 2), main side.
//
// Two kinds of test, like the live socket's:
//   · a real `ws` server stands in for Home Assistant and speaks its shape
//     (login, then result / session / answer / candidate events for the offer);
//   · a scripted fake socket, under FAKE timers where time matters (lease,
//     5-minute stop, waiting limits), for everything else — so nothing sleeps.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { parseConnections } from '../src/main/pages/page-connections';
import { PageRateGate, REDACTED } from '../src/main/pages/page-fetch';
import type { DeviceSocketAccess } from '../src/main/pages/page-socket';
import { PageLiveVideos, VIDEO_LIMITS } from '../src/main/pages/page-live-video';
import type { LiveWsLike, SocketOwner } from '../src/main/pages/page-live-socket';
import type { PageConnection, PageSocketEvent } from '../src/shared/pages-types';

const KEY = 'ha-long-lived-token-value';
const HELLO = '{"type":"auth","access_token":"{{key}}"}';
const SEND = '{"id":1,"type":"camera/webrtc/offer","entity_id":{{target}},"offer":{{offer}}}';
const URL_HA = 'http://192.168.4.54:8123/api/websocket';
const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
const GOOD = 'a=candidate:1 1 udp 2130706431 192.168.4.9 50000 typ host';
const SDP = (...lines: string[]) => ['v=0', 'o=- 1 2 IN IP4 0.0.0.0', 's=-', 'c=IN IP4 0.0.0.0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', ...lines, ''].join('\r\n');

type Dev = Extract<PageConnection, { kind: 'device' }>;
function device(over: Record<string, unknown> = {}, video: Record<string, unknown> | null = {}): Dev {
  const [c] = parseConnections([{
    id: 'ha', kind: 'device', service: 'Home Assistant', address: '192.168.4.54:8123', access: 'full',
    socketHello: HELLO, socketReady: 'auth_ok', socketAuthFailed: 'auth_invalid', socketDeny: ['config/core'],
    ...(video === null ? {} : { videoProfile: { targetPrefix: 'camera.', send: SEND, answer: 'event.answer', candidate: 'event.candidate', failed: 'event.message', ...video } }),
    ...over,
  }]);
  return c as Dev;
}
const okAccess = (conn: Dev = device()): DeviceSocketAccess => ({
  ok: true, connection: conn, httpUrl: new URL(URL_HA),
  credential: { in: 'header', param: 'authorization', value: `Bearer ${KEY}`, secret: KEY },
  secrets: [`Bearer ${KEY}`, KEY], hello: conn.socketHello,
});
const noAccess = (message = 'This page may not open a socket to that device.'): DeviceSocketAccess => ({ ok: false, refusal: { ok: false, reason: 'not-approved', message } });

class FakeWs extends EventEmitter {
  sent: string[] = [];
  terminated = false;
  send(d: string) { this.sent.push(d); }
  terminate() { this.terminated = true; }
  accept() { this.emit('open'); }
  say(obj: unknown) { this.emit('message', Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)), false); }
}

const call = { page: 'personal:home', frame: 'frame-1' };
const req = (over: Record<string, unknown> = {}) => ({ ...call, connection: 'ha', target: 'camera.living_room', offer: OFFER, ...over });

interface Rig { videos: PageLiveVideos; events: PageSocketEvent[]; wss: FakeWs[]; access: ReturnType<typeof vi.fn>; owner: (key?: string) => SocketOwner }
function rig(access?: () => Promise<DeviceSocketAccess>): Rig {
  const events: PageSocketEvent[] = [];
  const wss: FakeWs[] = [];
  const accessFn = vi.fn(access ?? (async () => okAccess()));
  const videos = new PageLiveVideos({
    access: accessFn, gate: new PageRateGate(),
    connect: () => { const w = new FakeWs(); wss.push(w); return w as unknown as LiveWsLike; },
  });
  return { videos, events, wss, access: accessFn, owner: (key = 'window:1') => ({ key, push: (e) => { events.push(e); return 'sent'; } }) };
}
/** Start a video and let the device log in: the template goes out. */
async function playing(r: Rig, over: Record<string, unknown> = {}, owner = r.owner()) {
  const res = await r.videos.start(owner, req(over));
  if (!res.ok) throw new Error(res.message);
  const w = r.wss.at(-1)!;
  w.accept();
  w.say({ type: 'auth_ok' });
  return { id: res.video, ws: w };
}
const kinds = (r: Rig) => r.events.map((e) => e.kind);
const answers = (r: Rig) => r.events.filter((e): e is Extract<PageSocketEvent, { kind: 'video-answer' }> => e.kind === 'video-answer');
const candidates = (r: Rig) => r.events.filter((e): e is Extract<PageSocketEvent, { kind: 'video-candidate' }> => e.kind === 'video-candidate').map((e) => JSON.parse(e.candidate));
const stopped = (r: Rig) => r.events.filter((e): e is Extract<PageSocketEvent, { kind: 'video-stopped' }> => e.kind === 'video-stopped').at(-1);
const answerMsg = (sdp: string) => ({ id: 1, type: 'event', event: { type: 'answer', answer: sdp } });
const candMsg = (c: unknown) => ({ id: 1, type: 'event', event: { type: 'candidate', candidate: c } });

describe('what a page may ask for', () => {
  it('is refused with no device connection, and nothing is opened', async () => {
    const r = rig(async () => noAccess());
    const res = await r.videos.start(r.owner(), req());
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining('may not open') });
    expect(r.wss).toHaveLength(0);
    expect(r.videos.count).toBe(0);
  });

  it('is refused when the connection has no video profile', async () => {
    const r = rig(async () => okAccess(device({}, null)));
    expect(await r.videos.start(r.owner(), req())).toMatchObject({ ok: false, message: expect.stringContaining('does not offer camera video') });
    expect(r.wss).toHaveLength(0);
    expect(r.videos.count).toBe(0);
  });

  it('is refused when the profile prefix does not end with a dot (the profile is dropped when read)', async () => {
    expect(device({}, { targetPrefix: 'camera' }).videoProfile).toBeUndefined();
    expect(device({}, { targetPrefix: 'c' }).videoProfile).toBeUndefined();
  });

  it.each([
    ['another domain', 'light.kitchen'],
    ['upper case', 'camera.Living'],
    ['an empty name', 'camera.'],
    ['a dash', 'camera.front-door'],
    ['a space', 'camera.front door'],
    ['a name over 64 characters', `camera.${'a'.repeat(65)}`],
    ['the bare prefix with an injected message', 'camera.a","type":"auth/long_lived_access_token'],
  ])('is refused for a target that is %s', async (_n, target) => {
    const r = rig();
    expect((await r.videos.start(r.owner(), req({ target }))).ok).toBe(false);
    expect(r.wss).toHaveLength(0);
    expect(r.videos.count).toBe(0);
  });

  it('accepts a name of exactly 64 characters', async () => {
    const r = rig();
    expect((await r.videos.start(r.owner(), req({ target: `camera.${'a'.repeat(64)}` }))).ok).toBe(true);
  });

  it('is refused when the offer is over 32 KB, before anything is checked', async () => {
    const r = rig();
    expect((await r.videos.start(r.owner(), req({ offer: 'v'.repeat(32 * 1024 + 1) }))).ok).toBe(false);
    expect(r.access).not.toHaveBeenCalled();
    expect((await r.videos.start(r.owner(), req({ offer: 'v'.repeat(32 * 1024) }))).ok).toBe(true);
  });

  it('is refused for a shape it cannot read', async () => {
    const r = rig();
    for (const bad of [{ page: '' }, { frame: 7 }, { connection: '' }, { target: 5 }, { offer: '' }]) expect((await r.videos.start(r.owner(), req(bad as any))).ok).toBe(false);
    expect(r.wss).toHaveLength(0);
  });
});

describe('the conversation with the device', () => {
  it('greets first and sends nothing else until the device says it is logged in', async () => {
    const r = rig();
    const res = await r.videos.start(r.owner(), req());
    expect(res.ok).toBe(true);
    const w = r.wss[0];
    w.accept();
    expect(w.sent.map((s) => JSON.parse(s).type)).toEqual(['auth']);
    expect(JSON.parse(w.sent[0]).access_token).toBe(KEY);
    // A reply that is not the "logged in" type changes nothing.
    w.say({ type: 'auth_required' });
    w.say({ type: 'pong' });
    expect(w.sent).toHaveLength(1);
    w.say({ type: 'auth_ok' });
    expect(w.sent.map((s) => JSON.parse(s).type)).toEqual(['auth', 'camera/webrtc/offer']);
  });

  it('fills the template exactly: target and offer as JSON values, never filled again', async () => {
    const r = rig();
    const offer = 'v=0\r\na="quoted"\\path\n{{target}} {{offer}} {{key}}';
    const { ws } = await playing(r, { offer });
    const parsed = JSON.parse(ws.sent[1]);
    expect(parsed).toEqual({ id: 1, type: 'camera/webrtc/offer', entity_id: 'camera.living_room', offer });
    // What went out is the checked, re-serialised message, byte for byte.
    expect(ws.sent[1]).toBe(JSON.stringify(parsed));
    // The key never enters the template, even when the offer writes the token.
    expect(ws.sent[1]).not.toContain(KEY);
  });

  it('refuses a filled template whose type is denied (the floor and the manifest list), sending nothing but the greeting', async () => {
    for (const type of ['auth/long_lived_access_token', 'config/core/update']) {
      const r = rig(async () => okAccess(device({}, { send: `{"id":1,"type":"${type}","entity_id":{{target}},"offer":{{offer}}}` })));
      const { ws } = await playing(r);
      expect(ws.sent.map((s) => JSON.parse(s).type)).toEqual(['auth']);
      expect(stopped(r)?.why).toBeTruthy();
      expect(r.videos.count).toBe(0);
      expect(ws.terminated).toBe(true);
    }
  });

  it('refuses a template that does not fill to a JSON object', async () => {
    const r = rig(async () => okAccess(device({}, { send: '[{{target}},{{offer}}]' })));
    const { ws } = await playing(r);
    expect(ws.sent).toHaveLength(1);
    expect(r.videos.count).toBe(0);
  });

  it('with no login reply to wait for, sends the template at once after the greeting-less open', async () => {
    const r = rig(async () => okAccess(device({ socketHello: undefined, socketReady: undefined })));
    await r.videos.start(r.owner(), req());
    r.wss[0].accept();
    expect(r.wss[0].sent.map((s) => JSON.parse(s).type)).toEqual(['camera/webrtc/offer']);
  });

  it('gives up if the device never says it is logged in, within 10 seconds', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      await r.videos.start(r.owner(), req());
      r.wss[0].accept();
      await vi.advanceTimersByTimeAsync(VIDEO_LIMITS.readyWaitMs - 1);
      expect(r.videos.count).toBe(1);
      await vi.advanceTimersByTimeAsync(2);
      expect(stopped(r)?.why).toContain('did not log in');
      expect(r.videos.count).toBe(0);
      expect(r.wss[0].terminated).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('stops at once, with the key advice, when the device refuses the key', async () => {
    const r = rig();
    const { ws } = await playing(r);
    ws.say({ type: 'auth_invalid' });
    expect(stopped(r)?.why).toContain('refused the saved key');
    expect(r.videos.count).toBe(0);
  });

  it('hands over the answer and each candidate from the paths in the profile, and ignores the rest', async () => {
    const r = rig();
    const { ws } = await playing(r);
    ws.say({ id: 1, type: 'result', success: true, result: null });
    ws.say({ id: 1, type: 'event', event: { type: 'session', session_id: 'abc' } });
    ws.say('not json at all');
    ws.say(answerMsg(SDP(GOOD)));
    ws.say(candMsg({ candidate: 'candidate:2 1 udp 2130706431 192.168.4.10 50001 typ host', sdpMid: '0', sdpMLineIndex: 0, extra: 'dropped' }));
    ws.say(candMsg('candidate:3 1 udp 1 192.168.4.11 50002 typ host'));
    expect(kinds(r)).toEqual(['video-answer', 'video-candidate', 'video-candidate']);
    expect(answers(r)[0].answer).toContain(GOOD);
    expect(candidates(r)).toEqual([
      { candidate: 'candidate:2 1 udp 2130706431 192.168.4.10 50001 typ host', sdpMid: '0', sdpMLineIndex: 0 },
      { candidate: 'candidate:3 1 udp 1 192.168.4.11 50002 typ host' },
    ]);
    // Only the first answer counts.
    ws.say(answerMsg(SDP(GOOD)));
    expect(answers(r)).toHaveLength(1);
  });

  it('stops with the device\'s own words when it reports a failure, and plainly when the request itself is refused', async () => {
    const r = rig();
    const a = await playing(r);
    a.ws.say({ id: 1, type: 'event', event: { type: 'error', code: 'x', message: 'Camera is asleep' } });
    expect(stopped(r)?.why).toBe('Camera is asleep');
    const r2 = rig();
    const b = await playing(r2);
    b.ws.say({ id: 1, type: 'result', success: false, error: { code: 'unknown_command', message: 'whatever' } });
    expect(stopped(r2)?.why).toBe('The device did not start the video.');
  });

  it('redacts a failure text that contains the key, before it reaches anyone', async () => {
    const r = rig();
    const { ws } = await playing(r);
    ws.say({ id: 1, type: 'event', event: { type: 'error', message: `token ${KEY} rejected, Bearer ${KEY}` } });
    const why = stopped(r)!.why;
    expect(why).not.toContain(KEY);
    expect(why).toContain(REDACTED);
    // And the same for an answer and a candidate.
    const r2 = rig();
    const b = await playing(r2);
    b.ws.say(answerMsg(SDP(GOOD, `a=ice-ufrag:${KEY}`)));
    b.ws.say(candMsg({ candidate: 'candidate:2 1 udp 1 192.168.4.10 50001 typ host', usernameFragment: KEY }));
    expect(JSON.stringify(r2.events)).not.toContain(KEY);
  });
});

describe('a key the device writes with JSON escapes', () => {
  /** The key as a device would write it inside a JSON string: every character as a \uXXXX escape. */
  const ESCAPED = KEY.split('').map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');

  it('is redacted from a failure text after it is decoded', async () => {
    const r = rig();
    const { ws } = await playing(r);
    // Sent as written: the key only appears once JSON.parse has decoded the escapes.
    ws.say(`{"id":1,"type":"event","event":{"type":"error","message":"token ${ESCAPED} rejected"}}`);
    const why = stopped(r)!.why;
    expect(why).not.toContain(KEY);
    expect(why).toContain(REDACTED);
  });

  it('is redacted from an answer and a candidate after they are decoded', async () => {
    const r = rig();
    const { ws } = await playing(r);
    ws.say(`{"type":"event","event":{"type":"answer","answer":${JSON.stringify(SDP(GOOD, 'a=ice-ufrag:@@')).replace('@@', ESCAPED)}}}`);
    ws.say(`{"type":"event","event":{"type":"candidate","candidate":{"candidate":"candidate:2 1 udp 1 192.168.4.10 50001 typ host","usernameFragment":"${ESCAPED}"}}}`);
    expect(kinds(r)).toEqual(['video-answer', 'video-candidate']);
    expect(JSON.stringify(r.events)).not.toContain(KEY);
  });
});

describe('what is let through from the device\'s answer', () => {
  const bad = [
    ['a hostname', 'a=candidate:1 1 udp 1 camera.local 50000 typ host'],
    ['loopback', 'a=candidate:1 1 udp 1 127.0.0.1 50000 typ host'],
    ['link-local', 'a=candidate:1 1 udp 1 169.254.10.10 50000 typ host'],
    ['the cloud metadata address', 'a=candidate:1 1 udp 1 169.254.169.254 50000 typ host'],
    ['v6 loopback', 'a=candidate:1 1 udp 1 ::1 50000 typ host'],
    ['v6 link-local', 'a=candidate:1 1 udp 1 fe80::1 50000 typ host'],
    ['v4-mapped metadata', 'a=candidate:1 1 udp 1 ::ffff:169.254.169.254 50000 typ host'],
    ['v4-mapped metadata in hex', 'a=candidate:1 1 udp 1 ::ffff:a9fe:a9fe 50000 typ host'],
    // Other spellings of the same addresses (step 3 review, finding 1): a text compare missed all of these.
    ['v6 loopback, fully written out', 'a=candidate:1 1 udp 1 0:0:0:0:0:0:0:1 50000 typ host'],
    ['v6 loopback with leading zeros', 'a=candidate:1 1 udp 1 ::0001 50000 typ host'],
    ['v6 loopback with a zero group', 'a=candidate:1 1 udp 1 0::1 50000 typ host'],
    ['v6 unspecified, fully written out', 'a=candidate:1 1 udp 1 0:0:0:0:0:0:0:0 50000 typ host'],
    ['v4-compatible loopback', 'a=candidate:1 1 udp 1 ::127.0.0.1 50000 typ host'],
    ['v4-mapped loopback, fully written out', 'a=candidate:1 1 udp 1 0:0:0:0:0:ffff:127.0.0.1 50000 typ host'],
    ['v4-mapped loopback in hex, fully written out', 'a=candidate:1 1 udp 1 0:0:0:0:0:ffff:7f00:1 50000 typ host'],
    ['v4-mapped loopback in capitals', 'a=candidate:1 1 udp 1 ::FFFF:7F00:1 50000 typ host'],
    ['v4-compatible metadata in hex', 'a=candidate:1 1 udp 1 ::a9fe:a9fe 50000 typ host'],
    ['AWS v6 metadata with a leading zero', 'a=candidate:1 1 udp 1 fd00:0ec2::254 50000 typ host'],
    ['AWS v6 metadata in capitals', 'a=candidate:1 1 udp 1 FD00:EC2:0:0:0:0:0:254 50000 typ host'],
    ['v6 link-local with a zone', 'a=candidate:1 1 udp 1 fe80::1%eth0 50000 typ host'],
    ['v6 link-local, upper end of its range', 'a=candidate:1 1 udp 1 febf::1 50000 typ host'],
    ['v4-mapped link-local with a zone-free expanded spelling', 'a=candidate:1 1 udp 1 0:0:0:0:0:ffff:a9fe:1 50000 typ host'],
    ['Alibaba metadata address', 'a=candidate:1 1 udp 1 100.100.100.200 50000 typ host'],
    ['a multicast address', 'a=candidate:1 1 udp 1 224.0.0.251 50000 typ host'],
    ['v6 multicast', 'a=candidate:1 1 udp 1 ff02::fb 50000 typ host'],
    ['the broadcast address', 'a=candidate:1 1 udp 1 255.255.255.255 50000 typ host'],
    ['a NAT64 form of loopback', 'a=candidate:1 1 udp 1 64:ff9b::7f00:1 50000 typ host'],
    ['an upper-case type word on a metadata address', 'A=CANDIDATE:1 1 udp 1 169.254.169.254 50000 TYP host'],
    ['a malformed line', 'a=candidate:bad'],
  ];

  it.each(bad)('drops an answer line naming %s and keeps the good one', async (_n, line) => {
    const r = rig();
    const { ws } = await playing(r);
    ws.say(answerMsg(SDP(line, GOOD)));
    const sdp = answers(r)[0].answer;
    expect(sdp).toContain(GOOD);
    expect(sdp).not.toContain(line);
  });

  it.each(bad.slice(0, -1))('drops a trickled candidate naming %s', async (_n, line) => {
    const r = rig();
    const { ws } = await playing(r);
    ws.say(answerMsg(SDP(GOOD)));
    ws.say(candMsg(line.replace('a=', '')));
    ws.say(candMsg({ candidate: line.replace('a=', '') }));
    expect(candidates(r)).toEqual([]);
  });

  it('rewrites a c= line (and drops an rtcp line) that names a loopback address or a hostname, leaving the rest of the answer valid', async () => {
    const r = rig();
    const { ws } = await playing(r);
    ws.say(answerMsg(['v=0', 'c=IN IP4 127.0.0.1', 'm=video 9 RTP/AVP 96', 'c=IN IP4 camera.local', 'a=rtcp:9 IN IP4 169.254.169.254', 'c=IN IP4 192.168.4.9', GOOD, 'a=remote-candidates:1 127.0.0.1 9'].join('\r\n')));
    const sdp = answers(r)[0].answer.split('\r\n');
    expect(sdp).toEqual(['v=0', 'c=IN IP4 0.0.0.0', 'm=video 9 RTP/AVP 96', 'c=IN IP4 0.0.0.0', 'c=IN IP4 192.168.4.9', GOOD]);
  });

  it('keeps home-network and public-looking addresses that merely look similar to blocked ones', async () => {
    const r = rig();
    const { ws } = await playing(r);
    const fine = ['a=candidate:1 1 udp 1 192.168.4.9 50000 typ host', 'a=candidate:2 1 udp 1 fd12:3456::9 50000 typ host', 'a=candidate:3 1 udp 1 ::ffff:c0a8:409 50000 typ host', 'a=candidate:4 1 udp 1 100.100.100.201 50000 typ host', 'a=candidate:5 1 udp 1 2001:db8::1 50000 typ host'];
    ws.say(answerMsg(SDP(...fine)));
    for (const l of fine) expect(answers(r)[0].answer).toContain(l);
  });

  it.each([
    ['two spaces', 'c=IN  IP4 127.0.0.1'],
    ['lower case', 'c=in ip4 127.0.0.1'],
    ['a tab', 'c=IN\tIP4\t169.254.169.254'],
    ['a trailing space', 'c=IN IP4 127.0.0.1 '],
    ['an extra word', 'c=IN IP4 127.0.0.1 extra'],
    ['a fully written-out v6 loopback', 'c=IN IP6 0:0:0:0:0:0:0:1'],
  ])('rewrites a c= line with %s so it cannot carry a blocked address', async (_n, line) => {
    const r = rig();
    const { ws } = await playing(r);
    ws.say(answerMsg(['v=0', line, GOOD].join('\r\n')));
    const out = answers(r)[0].answer;
    expect(out).not.toContain('127.0.0.1');
    expect(out).not.toContain('169.254');
    expect(out).not.toContain('0:0:0:0:0:0:0:1');
    expect(out.split('\r\n')[1]).toMatch(/^c=IN IP[46] (0\.0\.0\.0|::)$/);
  });

  it.each([
    ['two spaces', 'a=rtcp:9 IN  IP4 127.0.0.1'],
    ['lower case', 'a=rtcp:9 in ip4 169.254.169.254'],
    ['junk after the port', 'a=rtcp:9 whatever 127.0.0.1'],
  ])('drops an rtcp line with %s', async (_n, line) => {
    const r = rig();
    const { ws } = await playing(r);
    ws.say(answerMsg(['v=0', line, GOOD].join('\r\n')));
    expect(answers(r)[0].answer).not.toMatch(/rtcp|127\.0\.0\.1|169\.254/);
  });

  it('keeps a plain rtcp line and a c= line that is exactly right', async () => {
    const r = rig();
    const { ws } = await playing(r);
    ws.say(answerMsg(['v=0', 'c=IN IP4 192.168.4.9', 'a=rtcp:9', 'a=rtcp:9 IN IP4 192.168.4.9', 'a=rtcp-mux', GOOD].join('\r\n')));
    expect(answers(r)[0].answer.split('\r\n')).toEqual(['v=0', 'c=IN IP4 192.168.4.9', 'a=rtcp:9', 'a=rtcp:9 IN IP4 192.168.4.9', 'a=rtcp-mux', GOOD]);
  });

  it('checks text after a bare carriage return as its own line', async () => {
    const r = rig();
    const { ws } = await playing(r);
    ws.say(answerMsg(`v=0\rc=IN IP4 127.0.0.1\r\n${GOOD}`));
    expect(answers(r)[0].answer).not.toContain('127.0.0.1');
  });

  it.each([
    ['a line break', 'candidate:1 1 udp 1 192.168.1.2 5 typ host\r\na=candidate:2 1 udp 1 127.0.0.1 5 typ host'],
    ['a bare line feed', 'candidate:1 1 udp 1 192.168.1.2 5 typ host\na=candidate:2 1 udp 1 127.0.0.1 5 typ host'],
    ['a control character', 'candidate:1 1 udp 1 192.168.1.2 5 typ host\u0000'],
  ])('drops a trickled candidate containing %s, passing nothing on', async (_n, text) => {
    const r = rig();
    const { ws } = await playing(r);
    ws.say(answerMsg(SDP(GOOD)));
    ws.say(candMsg(text));
    ws.say(candMsg({ candidate: text }));
    expect(candidates(r)).toEqual([]);
  });

  it('hands the host a trickled candidate rebuilt from its fields, with single spaces', async () => {
    const r = rig();
    const { ws } = await playing(r);
    ws.say(answerMsg(SDP(GOOD)));
    ws.say(candMsg('candidate:2   1 udp 1  192.168.4.12 50000 typ   host'));
    expect(JSON.stringify(candidates(r))).toContain('candidate:2 1 udp 1 192.168.4.12 50000 typ host');
  });

  it('refuses an answer left with no usable address, once nothing usable arrives in 10 seconds', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      const { ws } = await playing(r);
      ws.say(answerMsg(SDP('a=candidate:1 1 udp 1 127.0.0.1 50000 typ host')));
      ws.say(candMsg('candidate:2 1 udp 1 169.254.169.254 50000 typ host'));
      expect(answers(r)).toEqual([]);
      await vi.advanceTimersByTimeAsync(VIDEO_LIMITS.candidateWaitMs + 1);
      expect(answers(r)).toEqual([]);
      expect(stopped(r)?.why).toContain('no address');
      expect(r.videos.count).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('accepts such an answer when a usable candidate arrives separately: the answer first, then the candidate', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      const { ws } = await playing(r);
      ws.say(answerMsg(SDP('a=candidate:1 1 udp 1 127.0.0.1 50000 typ host')));
      await vi.advanceTimersByTimeAsync(5_000);
      ws.say(candMsg('candidate:2 1 udp 1 192.168.4.12 50000 typ host'));
      expect(kinds(r)).toEqual(['video-answer', 'video-candidate']);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(r.videos.count).toBe(1); // the wait timer was cancelled
    } finally { vi.useRealTimers(); }
  });
});

describe('limits, ownership and when a video must end', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('allows 2 videos per page and 4 in the whole app, counted apart from sockets', async () => {
    const r = rig();
    expect((await r.videos.start(r.owner(), req())).ok).toBe(true);
    expect((await r.videos.start(r.owner(), req())).ok).toBe(true);
    expect(await r.videos.start(r.owner(), req())).toMatchObject({ ok: false, message: expect.stringContaining('at most 2') });
    expect((await r.videos.start(r.owner(), req({ page: 'personal:two' }))).ok).toBe(true);
    expect((await r.videos.start(r.owner(), req({ page: 'personal:two' }))).ok).toBe(true);
    expect(await r.videos.start(r.owner(), req({ page: 'personal:three' }))).toMatchObject({ ok: false, message: expect.stringContaining('at most 4') });
    expect(r.videos.count).toBe(4);
  });

  it('counts a start that is still waiting for its checks, so two quick starts cannot both pass', async () => {
    const waiting: Array<() => void> = [];
    const r = rig(() => new Promise((res) => { waiting.push(() => res(okAccess())); }));
    const a = r.videos.start(r.owner(), req());
    const b = r.videos.start(r.owner(), req());
    const c = r.videos.start(r.owner(), req());
    expect(await c).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    waiting.forEach((w) => w());
    await Promise.all([a, b]);
  });

  it('takes a slot from the rate gate for every start', async () => {
    const gate = { acquire: vi.fn(async () => true), release: vi.fn() };
    const videos = new PageLiveVideos({ access: async () => okAccess(), gate, connect: () => new FakeWs() as unknown as LiveWsLike });
    await videos.start({ key: 'window:1', push: () => 'sent' }, req());
    expect(gate.acquire).toHaveBeenCalledWith('personal:home');
    expect(gate.release).toHaveBeenCalledWith('personal:home');
    const denied = new PageLiveVideos({ access: async () => okAccess(), gate: { acquire: async () => false, release: vi.fn() }, connect: () => new FakeWs() as unknown as LiveWsLike });
    expect(await denied.start({ key: 'window:1', push: () => 'sent' }, req())).toMatchObject({ ok: false, message: expect.stringContaining('faster than') });
    expect(denied.count).toBe(0);
  });

  it('answers stop and ping only for the window that started the video, from the same frame', async () => {
    const r = rig();
    const { id } = await playing(r);
    expect(r.videos.ping('window:2', { ...call, video: id }).ok).toBe(false);
    expect(r.videos.stop('window:2', { ...call, video: id }).ok).toBe(false);
    expect(r.videos.stop('window:1', { ...call, frame: 'other', video: id }).ok).toBe(false);
    expect(r.videos.stop('window:1', { ...call, video: 'lv_nope' }).ok).toBe(false);
    expect(r.videos.ping('window:1', { ...call, video: id }).ok).toBe(true);
    expect(r.videos.count).toBe(1);
    expect(r.videos.stop('window:1', { ...call, video: id }).ok).toBe(true);
    expect(r.videos.count).toBe(0);
    expect(r.wss[0].terminated).toBe(true);
    // The page asked for it: nothing is pushed back.
    expect(stopped(r)).toBeUndefined();
  });

  it('stops a video nobody has pinged for 60 seconds, and keeps one that is pinged', async () => {
    vi.useFakeTimers();
    const r = rig();
    const { id } = await playing(r);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(r.videos.ping('window:1', { ...call, video: id }).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(r.videos.count).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stopped(r)?.why).toContain('stopped checking in');
    expect(r.videos.count).toBe(0);
    expect(r.wss[0].terminated).toBe(true);
  });

  it('stops by itself after 5 minutes, even if pinged, and says so', async () => {
    vi.useFakeTimers();
    const r = rig();
    const { id } = await playing(r);
    for (let t = 0; t < 4 * 60_000 + 30_000; t += 20_000) {
      await vi.advanceTimersByTimeAsync(20_000);
      r.videos.ping('window:1', { ...call, video: id });
    }
    expect(r.videos.count).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stopped(r)?.why).toContain('5-minute limit');
    expect(r.videos.count).toBe(0);
    expect(r.wss[0].terminated).toBe(true);
  });

  it('closeFor stops the page\'s videos (one connection, or all); closeOwner stops a window\'s', async () => {
    const r = rig();
    await playing(r);
    await playing(r, { page: 'personal:two' });
    r.videos.closeFor('personal:home', 'other-connection');
    expect(r.videos.count).toBe(2);
    r.videos.closeFor('personal:home', 'ha', 'The saved key was deleted.');
    expect(r.videos.count).toBe(1);
    expect(stopped(r)?.why).toBe('The saved key was deleted.');
    expect(r.wss[0].terminated).toBe(true);
    await playing(r, { page: 'personal:home' }, r.owner('client:A'));
    r.videos.closeOwner('client:A');
    expect(r.videos.count).toBe(1);
    r.videos.closeFor('personal:two');
    expect(r.videos.count).toBe(0);
  });

  it('stops when the device closes the connection or it errors, and stops a client that is not keeping up', async () => {
    const r = rig();
    const { ws } = await playing(r);
    ws.emit('close');
    expect(stopped(r)?.why).toContain('Lost the connection');
    const r2 = rig();
    const b = await playing(r2);
    b.ws.emit('error', new Error(`boom ${KEY}`));
    expect(stopped(r2)?.why).not.toContain(KEY);
    const events: PageSocketEvent[] = [];
    const slow = rig();
    const c = await playing(slow, {}, { key: 'client:B', push: (e) => { events.push(e); return 'backed-up'; } });
    c.ws.say(answerMsg(SDP(GOOD)));
    expect(slow.videos.count).toBe(0);
    expect(c.ws.terminated).toBe(true);
    // The card is told, or it would keep showing a frozen picture as if it were playing.
    expect(events.at(-1)).toMatchObject({ kind: 'video-stopped', why: expect.stringContaining('not keeping up') });
  });

  it('stops, without a push to a window that is gone, and a failed push closes only that video', async () => {
    const r = rig();
    const { ws } = await playing(r, {}, { key: 'window:1', push: () => 'gone' });
    ws.say(answerMsg(SDP(GOOD)));
    expect(r.videos.count).toBe(0);
    expect(ws.terminated).toBe(true);
  });
});

describe('with a real Home Assistant stand-in', () => {
  let server: WebSocketServer;
  let port = 0;
  let received: string[];
  beforeEach(async () => {
    received = [];
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'auth_required' }));
      ws.on('message', (raw) => {
        const text = raw.toString();
        received.push(text);
        const m = JSON.parse(text);
        if (m.type === 'auth') ws.send(JSON.stringify({ type: m.access_token === KEY ? 'auth_ok' : 'auth_invalid' }));
        if (m.type === 'camera/webrtc/offer') {
          ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: null }));
          ws.send(JSON.stringify({ id: m.id, type: 'event', event: { type: 'session', session_id: 's1' } }));
          ws.send(JSON.stringify({ id: m.id, type: 'event', event: { type: 'answer', answer: SDP(GOOD, 'a=candidate:9 1 udp 1 127.0.0.1 1 typ host') } }));
          ws.send(JSON.stringify({ id: m.id, type: 'event', event: { type: 'candidate', candidate: { candidate: 'candidate:7 1 udp 1 192.168.4.30 4000 typ host', sdpMid: '0' } } }));
        }
      });
    });
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('plays the whole exchange: login, offer, filtered answer, candidate; closes the wire on stop', async () => {
    const events: PageSocketEvent[] = [];
    let wake: () => void = () => {};
    const videos = new PageLiveVideos({
      access: async () => okAccess(), gate: new PageRateGate(),
      connect: (url, headers) => new WebSocket(`ws://127.0.0.1:${port}${new URL(url).pathname}`, { headers, followRedirects: false }) as unknown as LiveWsLike,
    });
    const owner: SocketOwner = { key: 'window:1', push: (e) => { events.push(e); wake(); return 'sent'; } };
    const res = await videos.start(owner, req());
    if (!res.ok) throw new Error(res.message);
    await new Promise<void>((resolve) => { wake = () => { if (events.some((e) => e.kind === 'video-candidate')) resolve(); }; wake(); });
    expect(received.map((t) => JSON.parse(t).type)).toEqual(['auth', 'camera/webrtc/offer']);
    expect(JSON.parse(received[1])).toMatchObject({ entity_id: 'camera.living_room', offer: OFFER });
    const answer = events.find((e) => e.kind === 'video-answer') as { answer: string };
    expect(answer.answer).toContain('192.168.4.9');
    expect(answer.answer).not.toContain('127.0.0.1 1 typ');
    // The wire stays open for the video's life, then closes when the page stops it.
    expect(videos.count).toBe(1);
    const closed = new Promise<void>((resolve) => server.clients.forEach((c) => c.once('close', () => resolve())));
    expect(videos.stop('window:1', { ...call, video: res.video }).ok).toBe(true);
    await closed;
    expect(videos.count).toBe(0);
  });
});
