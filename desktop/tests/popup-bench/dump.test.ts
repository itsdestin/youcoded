// Debug helper (not part of the suite unless POPUP_DUMP is set):
// POPUP_DUMP="scenario:note" prints each distinct screen in that truth region.
import fs from 'fs'; import path from 'path';
import { it } from 'vitest';
import { replay } from './bench-lib';
import { CANDIDATES } from './candidates';
const spec = process.env.POPUP_DUMP;
it.skipIf(!spec)('prints every screen of the POPUP_DUMP truth region with each candidate verdict', async () => {
  const [scn, note] = spec!.split(':');
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'popup-corpus', `${scn}.json`), 'utf8'));
  const segs = await replay(fx);
  const out: string[] = [];
  let last = -1;
  for (const g of segs) {
    if (note && !g.note.includes(note)) continue;
    if (g.frame === last) continue; last = g.frame;
    const flags = CANDIDATES.map((c) => `${c.name}=${c.blocked(g.screen) ? 'Y' : '.'}`).join(' ');
    out.push(`==== t=${g.t} ms=${g.ms} state=${g.state} [${g.note}] ${flags}\n` + g.screen.split('\n').slice(-18).join('\n'));
  }
  fs.writeFileSync(process.env.POPUP_DUMP_OUT ?? '/dev/stdout', out.join('\n'));
});
