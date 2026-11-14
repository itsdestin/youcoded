// T1 rig: records every path a device's JavaScript hands to `fs` that lies under the REAL home folder but
// outside the rig's own allowed folders. Loaded with `node -r`, before any app code.
// WHY: the jail (bubblewrap) makes real-home paths land in an empty decoy, so nothing can be damaged; this
// preload answers the other question, "what did it TRY to touch", read or write, by name.
// Limit: only calls made from JavaScript in this process. Child processes (git, claude, node-pty workers,
// `gh`) and native addons are not seen; the jail + decoy is what covers them.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const REAL = process.env.RIG_REAL_HOME;
const ALLOW = (process.env.RIG_ALLOW || '').split(path.delimiter).filter(Boolean);
const OUT = process.env.RIG_FS_AUDIT;
if (REAL && OUT) {
  const WRITE = /^(write|append|mkdir|mkdtemp|rm|rmdir|unlink|rename|copyFile|cp|truncate|ftruncate|chmod|chown|utimes|lutimes|symlink|link|createWriteStream|writeFile|appendFile)/;
  const seen = new Set();
  const note = (op, p, kind) => {
    let s; try { s = typeof p === 'string' ? p : Buffer.isBuffer(p) ? p.toString() : p instanceof URL ? p.pathname : null; } catch { return; }
    if (!s || !path.isAbsolute(s)) return;
    s = path.resolve(s);
    if (s !== REAL && !s.startsWith(REAL + path.sep)) return;
    if (ALLOW.some((a) => s === a || s.startsWith(a + path.sep))) return;
    const key = kind + ' ' + op + ' ' + s;
    if (seen.has(key)) return; seen.add(key);
    try { fs.appendFileSync(OUT, JSON.stringify({ kind, op, path: s }) + '\n'); } catch { /* audit must never break the app */ }
  };
  const wrap = (obj, label) => {
    for (const k of Object.keys(obj)) {
      const f = obj[k];
      if (typeof f !== 'function' || /^[A-Z]/.test(k) || k === 'promises' || k === 'constants') continue;
      const kind = WRITE.test(k.replace(/Sync$/, '')) ? 'write' : 'read';
      try {
        obj[k] = function (...a) {
          // open() reads unless its flags ask to write/append/create
          const kk = /^open(Sync)?$/.test(k) ? (typeof a[1] === 'string' && /[wa+]/.test(a[1]) || typeof a[1] === 'number' && (a[1] & 3) !== 0 ? 'write' : 'read') : kind;
          note(label + k, a[0], kk);
          if (k.startsWith('rename') || k.startsWith('copyFile') || k.startsWith('link') || k.startsWith('symlink') || k === 'cp' || k === 'cpSync') note(label + k, a[1], 'write');
          return f.apply(this, a);
        };
      } catch { /* non-writable property */ }
    }
  };
  wrap(fs, 'fs.'); wrap(fs.promises, 'fsp.');
}
