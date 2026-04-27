#!/usr/bin/env node
// Diagnostic: capture raw bytes from CC during a thinking turn so we can see
// exactly what the spinner emits and whether the "(Ns · esc to interrupt)"
// suffix is on the same line as the gerund or somewhere else.
//
// The attention-states harness saw glyphs like `*` and `✶` in the stripped
// buffer but never with the seconds-counter suffix the regex requires —
// suggesting either ConPTY is dropping bytes, the layout differs from what
// the regex expects, or CC emits the suffix as a separate cursor-positioned
// fragment that our naive ANSI strip mishandles.
//
// Output: a JSON file with each PTY data chunk's raw bytes (hex) + a
// human-readable escape-printed version. Inspect manually.

import pty from 'node-pty';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveClaudeCommand() {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, 'claude' + ext);
      if (fs.existsSync(full)) return full;
    }
  }
  throw new Error('claude not found on PATH');
}

function pretrustCwd(cwd) {
  const cfgPath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(cfgPath)) return;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.projects = cfg.projects || {};
  const fwd = cwd.replace(/\\/g, '/');
  cfg.projects[fwd] = { ...(cfg.projects[fwd] || {}), hasTrustDialogAccepted: true };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

function escapePrint(s) {
  // Render every byte either as a printable char or as \xNN / known escape.
  return s.replace(/[\x00-\x1f\x7f]/g, (c) => {
    const code = c.charCodeAt(0);
    if (code === 0x1b) return '\\e';
    if (code === 0x0a) return '\\n\n';
    if (code === 0x0d) return '\\r';
    if (code === 0x07) return '\\a';
    return '\\x' + code.toString(16).padStart(2, '0');
  });
}

async function main() {
  console.log(`platform=${process.platform} node=${process.version}`);

  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const cwd = path.join(os.tmpdir(), `cc-spin-bytes-${stamp}`);
  fs.mkdirSync(cwd, { recursive: true });
  pretrustCwd(cwd);

  const claude = resolveClaudeCommand();
  const startNs = process.hrtime.bigint();
  const ms = () => Number(process.hrtime.bigint() - startNs) / 1e6;

  let rawAccum = '';
  const chunks = [];
  const child = pty.spawn(claude, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env },
  });
  child.onData((data) => {
    rawAccum += data;
    chunks.push({ t: ms(), data });
  });

  // Wait for welcome + settle.
  console.log(`[${ms().toFixed(0)}ms] waiting for welcome…`);
  const welcomeDeadline = Date.now() + 25_000;
  let welcomeSeen = false;
  while (Date.now() < welcomeDeadline) {
    if (/Welcome|Tips|Recent\s*activity/i.test(rawAccum.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''))) {
      welcomeSeen = true; break;
    }
    await sleep(150);
  }
  if (!welcomeSeen) {
    console.log('!! welcome never appeared');
    child.kill();
    return;
  }
  console.log(`[${ms().toFixed(0)}ms] welcome seen, settling 3.5s`);
  await sleep(3500);

  // Send a prompt that takes ~10s of thinking.
  const prompt = 'write a 500 word essay about the philosophy of time';
  const sendT = ms();
  console.log(`[${sendT.toFixed(0)}ms] sending: ${JSON.stringify(prompt)}`);
  child.write(prompt + '\r');

  // Watch for ~30s — long enough to capture extended spinner state.
  await sleep(30_000);
  child.kill();
  await sleep(300);

  // Dump post-send bytes to a hex log. Filter by timestamp instead of
  // a slice index because the array reference is shared and indices can
  // shift if any cleanup chunk lands during the gap.
  const postSendChunks = chunks.filter((c) => c.t >= sendT);
  const tracePath = path.join(__dirname, 'spinner-bytes.log');
  const out = [];
  out.push(`=== platform=${process.platform} node=${process.version}`);
  out.push(`=== prompt=${JSON.stringify(prompt)}`);
  out.push(`=== ${postSendChunks.length} chunks captured post-send`);
  out.push(``);
  for (const c of postSendChunks) {
    out.push(`--- chunk @ ${c.t.toFixed(0)}ms (${c.data.length}B) ---`);
    out.push(escapePrint(c.data));
    out.push(``);
  }
  fs.writeFileSync(tracePath, out.join('\n'));
  console.log(`wrote ${tracePath}`);

  // Also do a quick text grep for the seconds-counter pattern across the whole
  // post-send raw stream — does CC actually emit "(Ns · esc to interrupt)" at all?
  const allRaw = postSendChunks.map((c) => c.data).join('');
  const interruptHits = allRaw.match(/esc\s*to\s*interrupt/gi) || [];
  const cancelHits = allRaw.match(/esc\s*to\s*cancel/gi) || [];
  const secondsHits = allRaw.match(/\(\d+s\s*[·•]\s*esc/gi) || [];
  console.log(`\n"esc to interrupt" hits: ${interruptHits.length}`);
  console.log(`"esc to cancel" hits:    ${cancelHits.length}`);
  console.log(`"(Ns · esc" pattern hits: ${secondsHits.length}`);
  if (secondsHits.length > 0) {
    console.log(`first 3 seconds-counter samples:`);
    for (const h of secondsHits.slice(0, 3)) console.log(`  ${JSON.stringify(h)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
