#!/usr/bin/env node
// Capture the COMPLETE raw byte stream from welcome through full response,
// then text-search for any seconds counter / "esc to interrupt" / "esc to
// cancel" pattern. Confirms (or refutes) the headline finding that CC
// v2.1.119 has dropped these strings from the spinner display.

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

async function main() {
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const cwd = path.join(os.tmpdir(), `cc-fullcap-${stamp}`);
  fs.mkdirSync(cwd, { recursive: true });
  pretrustCwd(cwd);

  const claude = resolveClaudeCommand();
  let raw = '';
  const child = pty.spawn(claude, [], {
    name: 'xterm-256color',
    cols: 200,  // wider terminal in case the seconds counter only shows when there's room
    rows: 50,
    cwd,
    env: { ...process.env },
  });
  child.onData((data) => { raw += data; });

  console.log('waiting for welcome…');
  const welcomeDeadline = Date.now() + 25_000;
  while (Date.now() < welcomeDeadline) {
    if (/Welcome|Tips|Recent\s*activity/i.test(raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''))) break;
    await sleep(150);
  }
  await sleep(3500);

  console.log('sending prompt…');
  child.write('what is 2+2? answer with just the number\r');
  // Wait long enough for response.
  await sleep(40_000);
  child.kill();
  await sleep(300);

  // Save the full raw stream (with escapes) for grep.
  const tracePath = path.join(__dirname, 'spinner-full.log');
  fs.writeFileSync(tracePath, raw);
  console.log(`wrote ${tracePath} (${raw.length} bytes)`);

  // Text search through the raw stream.
  const probes = [
    { name: 'esc to interrupt', re: /esc\s*to\s*interrupt/gi },
    { name: 'esc to cancel',    re: /esc\s*to\s*cancel/gi },
    { name: '(Ns · esc',        re: /\(\d+s\s*[·•]\s*esc/gi },
    { name: 'NNs (parens)',     re: /\((\d+)s\)/g },
    { name: 'tokens',           re: /tokens?/gi },
    { name: 'interrupt',        re: /\binterrupt\w*/gi },
    { name: 'spinner glyphs',   re: /[✻✽✢✳✶⏺◉]/g },
    { name: 'gerund …',         re: /[A-Za-z]+ing…/g },
  ];
  console.log(`\nProbe results:`);
  for (const p of probes) {
    const matches = raw.match(p.re) || [];
    const unique = [...new Set(matches)].slice(0, 8);
    console.log(`  ${p.name.padEnd(20)} hits=${matches.length}  unique=${JSON.stringify(unique)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
