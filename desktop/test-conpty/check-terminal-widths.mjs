#!/usr/bin/env node
// Replays probe-terminal-widths.mjs output into the app's own headless terminal and reports, per probe, what the
// message-box row reads and whether the app's screen reader still finds the box. Usage: node check-terminal-widths.mjs <out-dir> [--plain]
// --plain uses Unicode 11 widths only (the app before 2026-10-22), to show the difference.
import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {Terminal}=require('@xterm/headless');const {Unicode11Addon}=require('@xterm/addon-unicode11');
const {readInputFocus}=require(desktop+'/dist/shared/cc-input-focus.js');
const plain=process.argv.includes('--plain');
const dir=path.resolve(process.argv[2]);const o=fs.existsSync(dir+'/tmp/_o')?dir+'/tmp/_o':dir;
const m=JSON.parse(fs.readFileSync(o+'/marks.json','utf8'));const raw=fs.readFileSync(o+'/terminal.raw','utf8');
const write=(t,d)=>new Promise(r=>t.write(d,r));
let bad=0;
for(const mark of m.marks){
 const t=new Terminal({cols:m.cols,rows:m.rows,allowProposedApi:true,scrollback:0});
 t.loadAddon(new Unicode11Addon());t.unicode.activeVersion='11';
 if(!plain){const {useClaudeCodeWidths}=require(desktop+'/dist/shared/terminal-widths.js');useClaudeCodeWidths(t);}
 await write(t,raw.slice(0,mark.offset));
 const b=t.buffer.active;const rows=[];for(let i=0;i<t.rows;i++)rows.push(b.getLine(b.viewportY+i)?.translateToString(true)??'');
 const text=m.results.find(r=>r.name===mark.name)?.text??'';
 // The message box is the LAST ❯ row (sent messages above it start with ❯ too).
 const boxRow=[...rows].reverse().find(r=>/^❯/.test(r.trim()))??'';
 const shown=boxRow.trim().replace(/^❯\s?/,'');
 const focus=readInputFocus(rows.join('\n')).kind;
 // Compare as a person reads it: composed accents, invisible joiners and emoji-style selectors set aside. A misdrawn
 // line shows up as missing, extra or doubled characters and spaces.
 const norm=x=>x.normalize('NFC').replace(/[​-‍⁠﻿️]/g,'');
 const ok=focus==='message-box'&&norm(shown)===norm(text);
 if(!ok)bad++;
 console.log((ok?'ok  ':'BAD ')+mark.name.padEnd(24)+' focus='+focus.padEnd(12)+' row='+JSON.stringify(boxRow.trim()));
 t.dispose();
}
console.log(bad?bad+' probe(s) misdrawn':'all probes drawn as Claude Code meant');process.exitCode=bad?1:0;
