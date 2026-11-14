// A hostile OUTSIDE party for the rig: it knows a pairing meeting's id (which the relay sees) but NOT the typed code. It joins as
// a guest again and again and plays the pairing protocol with a made-up secret. The rig then checks it never got a welcome, never
// reached the host's "Add this device?" prompt, and cost the host no more than its allowed tries.
//
// SAFETY: runs as its own process with an empty environment and a throwaway HOME made by the rig; talks to the rig's relay on
// 127.0.0.1 only; reads nothing but the compiled app code in the rig's build folder; writes nothing; prints one JSON line.
// usage: node attacker.cjs <buildDir> <relayWsUrl> <meetingIdHex> <tries>
const path = require('path');
const [build, url, id, triesArg] = process.argv.slice(2);
const WebSocket = require(path.join(build, 'node_modules/ws'));
const { NewDevice } = require(path.join(build, 'dist/main/mesh/crypto/pairing.js'));
const { generateIdentity } = require(path.join(build, 'dist/main/mesh/crypto/identity.js'));
const { packMessage, unpackMessage } = require(path.join(build, 'dist/shared/mesh-protocol.js'));
const crypto = require('crypto');

const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const result = { tries: 0, joined: 0, refused: 0, welcomed: 0, messagesFromHost: 0 };

function oneTry() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url}/mesh/meet/${id}?v=1`);
    // The attacker does not know the meeting part either (only its hash), so even the session id it feeds the PAKE is a guess.
    const nd = new NewDevice(generateIdentity(), { room: crypto.randomBytes(13), secret: Buffer.from('AAAAAA') }, 'code', { name: 'attacker', platform: 'linux' });
    let n = 0;
    const done = () => { try { ws.close(); } catch {} resolve(); };
    const timer = setTimeout(done, 4000);
    ws.on('error', () => { clearTimeout(timer); resolve(); });
    ws.on('close', () => { clearTimeout(timer); resolve(); });
    ws.on('open', () => ws.send(packMessage({ op: 'meet-join', role: 'guest' })));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const m = unpackMessage(ab(Buffer.from(data)));
      if (!m.ok) return;
      if (m.header.op === 'meet-joined') {
        result.joined++;
        ws.send(packMessage({ op: 'meet-relay', n: ++n }, nd.start()));
      } else if (m.header.op === 'refused') {
        result.refused++;
      } else if (m.header.op === 'meet-relay') {
        result.messagesFromHost++;
        let outs = [];
        try { outs = nd.onMessage(Buffer.from(m.payload)); } catch { /* a refusal from the protocol ends the try */ }
        for (const o of outs) ws.send(packMessage({ op: 'meet-relay', n: ++n }, o));
        const r = nd.result;
        if (r && r.ok) result.welcomed++;
        if (r) { clearTimeout(timer); setTimeout(done, 100); }
      } else if (m.header.op === 'meet-ended') {
        clearTimeout(timer); resolve();
      }
    });
  });
}
(async () => {
  for (let i = 0; i < Number(triesArg); i++) { result.tries++; await oneTry(); await new Promise((r) => setTimeout(r, 150)); }
  console.log(JSON.stringify(result));
  process.exit(0);
})();
