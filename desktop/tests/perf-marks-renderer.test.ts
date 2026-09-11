import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
const R = join(__dirname, '..', 'src', 'renderer');
const index = readFileSync(join(R, 'index.tsx'), 'utf8');
const app = readFileSync(join(R, 'App.tsx'), 'utf8');
describe('renderer perf marks (read by youcoded-dev/scripts/perf-lab)', () => {
  // The name is 'yc:modules-evaluated' and not anything with "start" in it: ESM
  // hoists every import above the module body, so the mark fires only once the
  // whole bundle (React, react-dom, globals.css, App.tsx and its component
  // graph) has finished evaluating.
  // The rig recovers the hidden window before it as modulesEvaluated −
  // documentStart, using performance.timeOrigin.
  it('index.tsx marks modules-evaluated and root render, in that order', () => {
    const a = index.indexOf(`performance.mark('yc:modules-evaluated')`);
    const b = index.indexOf(`performance.mark('yc:root-render')`);
    expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a);
  });
  it('App.tsx marks mount and sessions-listed', () => {
    expect(app).toContain(`performance.mark('yc:app-mounted')`);
    expect(app).toContain(`performance.mark('yc:sessions-listed')`);
  });
  // App.tsx has TWO window.claude.session.list() call sites: the mount-time
  // fetch, and the one inside the onConnectionModeChange handler that reloads
  // after a local <-> remote switch. Only the first is startup. This pins that
  // judgment call so a future edit can't silently move the mark to the reload.
  it('sessions-listed marks the MOUNT-time session.list, not the connection-mode reload', () => {
    const mark = app.indexOf(`performance.mark('yc:sessions-listed')`);
    const modeChangeHandler = app.indexOf('onConnectionModeChange(');
    expect(mark).toBeGreaterThan(-1);
    expect(modeChangeHandler).toBeGreaterThan(mark);
    // ...and it really is inside a session.list() .then(), not floating loose.
    const listBefore = app.lastIndexOf('window.claude.session.list()', mark);
    expect(listBefore).toBeGreaterThan(-1);
    expect(mark - listBefore).toBeLessThan(400); // same .then() body, not a distant one
  });
});
