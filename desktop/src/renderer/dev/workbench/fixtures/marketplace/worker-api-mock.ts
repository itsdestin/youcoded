// The workbench's stand-in for the YouCoded Worker (the Cloudflare backend
// behind install counts, ratings, thumbs and comments).
//
// WHY: the stats/ratings code talks to the Worker with plain `fetch`, not
// through `window.claude`, so the mock shim could not intercept it — every
// workbench session hit the PRODUCTION Worker for numbers, which made the
// review rig's Before/After diffs drift whenever a real install landed, and
// meant the marketplace overhaul design (thumbs + comments, 2026-08-27)
// could not be shown at all since those routes don't exist yet. Answering
// from fixtures here makes the numbers deterministic and keeps the
// workbench offline, like the rest of the fake backend.
//
// Routes with NO real backend yet (the backend to-do once the design is
// approved — the Worker equivalent of mock-only.ts):
//   GET  /comments/:plugin_id   → { comments: [...], total }
//   POST /comments              → { id }
//   POST /thumbs                → { ok: true }
//   GET  /stats                 → plugins[id] gains thumbs_up / thumbs_down
import { MARKETPLACE_API_HOST } from '../../../../state/marketplace-api-client';
import { FAKE_COMMENTS, FAKE_STATS, type FakeComment } from './catalog';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function installWorkerApiMock(): void {
  // jsdom test runs have no fetch; the unit suite only checks the bridge.
  if (typeof window.fetch !== 'function') return;
  const realFetch = window.fetch.bind(window);
  // Per-session mutable copies so posting a comment or a thumb shows up
  // immediately, the way the real Worker would echo it back.
  const comments: Record<string, FakeComment[]> = JSON.parse(JSON.stringify(FAKE_COMMENTS));
  const stats = JSON.parse(JSON.stringify(FAKE_STATS)) as typeof FAKE_STATS;
  // The signed-in viewer's own vote per plugin — backs GET /thumbs/<id>.
  const myVotes: Record<string, 'up' | 'down'> = {};

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(MARKETPLACE_API_HOST)) return realFetch(input, init);
    const path = url.slice(MARKETPLACE_API_HOST.length).split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();

    if (path === '/stats' && method === 'GET') {
      return json({ generated_at: Math.floor(Date.now() / 1000), plugins: stats, themes: { 'golden-sunbreak': { likes: 41, installs: 512 }, 'meadow-mist': { likes: 88, installs: 1240 }, 'halftone-dimension': { likes: 120, installs: 87 } } });
    }
    if (path.startsWith('/ratings/') && method === 'GET') return json({ ratings: [] });
    if (path.startsWith('/comments/') && method === 'GET') {
      const id = decodeURIComponent(path.slice('/comments/'.length));
      // `total` mirrors the Worker (2026-09-01): the full visible count beside
      // the 50-row page, so the "showing the 50 most recent of N" line can be
      // exercised here by seeding a fixture with more than 50 rows.
      const list = comments[id] ?? [];
      return json({ comments: list.slice(0, 50), total: list.length });
    }
    if (path === '/comments' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { plugin_id: string; text: string };
      const row: FakeComment = { id: `c${Date.now()}`, user_id: 'github:you', user_login: 'you', user_avatar_url: '', text: body.text, created_at: Math.floor(Date.now() / 1000) };
      (comments[body.plugin_id] ??= []).unshift(row);
      // Shape matches the real Worker: { ok, id, hidden }. `hidden` lets the
      // workbench show the "held for review" path without a classifier.
      return json({ ok: true, id: row.id, hidden: false });
    }
    // One vote per viewer, like the real route: re-voting REPLACES rather than
    // adding, and `null` clears — otherwise clicking Helpful twice in the
    // workbench shows +2 and nothing here would ever look wrong.
    if (path === '/thumbs' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { plugin_id: string; value: 'up' | 'down' | null };
      const s = (stats[body.plugin_id] ??= { installs: 0, review_count: 0, rating: 0, thumbs_up: 0, thumbs_down: 0 });
      const previous = myVotes[body.plugin_id] ?? null;
      if (previous === 'up') s.thumbs_up -= 1;
      if (previous === 'down') s.thumbs_down -= 1;
      if (body.value === 'up') s.thumbs_up += 1;
      if (body.value === 'down') s.thumbs_down += 1;
      if (body.value === null) delete myVotes[body.plugin_id];
      else myVotes[body.plugin_id] = body.value;
      // The real route returns the new totals with the write — mirror that, or
      // the workbench cannot show the number moving on click.
      return json({ ok: true, vote: body.value, thumbs_up: s.thumbs_up, thumbs_down: s.thumbs_down });
    }
    // GET /thumbs/<id> — the viewer's own vote. In-memory so the workbench can
    // demonstrate the point of the route: vote, navigate away, come back, and
    // the thumb is still lit.
    if (path.startsWith('/thumbs/') && method === 'GET') {
      const id = decodeURIComponent(path.slice('/thumbs/'.length));
      // Totals ride the read like the real route, so the workbench shows the
      // count surviving a navigate-away-and-back rather than resetting.
      const s = stats[id];
      return json({ vote: myVotes[id] ?? null, thumbs_up: s?.thumbs_up ?? 0, thumbs_down: s?.thumbs_down ?? 0 });
    }
    if (path === '/installs' && method === 'POST') return json({ ok: true });
    if (path === '/health') return json({ ok: true });
    return json({ error: `workbench: no fake for ${method} ${path}` }, 404);
  };
}
