// electron-builder afterPack hook: no file in the packaged app may be writable by other users.
//
// WHY (2026-11-04): Electron 44's official Linux download (electron-v44.10.0-linux-x64.zip) stores every file as
// 0666/0777 — writable by ANY user on the computer — where Electron 41's stored 0644/0755. electron-builder copies those
// modes straight into release/linux-unpacked, and the .deb/.rpm/.pacman packages keep them, so another account on a shared
// computer could replace YouCoded's own program or chrome-sandbox (Chromium's privileged helper). CI's AppImage check
// caught it ("Installed app differs from current post-builder app": the AppImage stored 0644, the build folder 0666).
// Removing only the group/other WRITE bit keeps every read and run permission exactly as Electron shipped it.
// Runs before electron-builder flips the fuses and signs, so the signature covers the corrected files.
// Windows has no such bits; skipped there. Pinned by tests/after-pack-permissions.test.ts.
const fs = require('node:fs');
const path = require('node:path');

function removeOthersWrite(root) {
  const fix = (p, st) => { if (st.mode & 0o022) fs.chmodSync(p, st.mode & 0o7755); };
  const walk = (dir) => {
    fix(dir, fs.lstatSync(dir));
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) continue; // a link's own mode is ignored; its target is fixed where it lives
      if (st.isDirectory()) walk(p); else fix(p, st);
    }
  };
  walk(root);
}

async function afterPack(context) {
  if (context.electronPlatformName === 'win32') return;
  removeOthersWrite(context.appOutDir);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.removeOthersWrite = removeOthersWrite;
