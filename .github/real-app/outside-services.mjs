#!/usr/bin/env node
// Daily check: do the outside services the app depends on still answer?
// (plan: youcoded-dev docs/active/plans/2026-11-01-real-app-testing.md, Phase 2)
//
// WHY: the online games server vanished and nothing noticed (Android report, 2026-11-01). These can break any day
// with no code change from us, so a release-time check alone would miss them for weeks.
// Each entry names what a USER loses if it fails, so the run summary reads as a plain list.
// KEEP IN STEP with the hostnames in desktop/src (grep for https://): a new outside service belongs here.
//
// expect: 'ok'   → must answer 2xx (an API or file the app reads)
//         'page' → must answer at all, below 500 (sign-in pages may refuse robots with 403; that's fine —
//                  what we're catching is the address vanishing or the site being down)
//         'json' → 2xx and parses as JSON (a file the app parses)
// mustMatchBody (optional, with 'page'): the answer's text must also match. WHY: the games rooms moved from hosted PartyKit
// (shut down 2026-10-23) into our server on 2026-11-01 (party-client.ts); a websocket-only room answers a plain GET with
// 404 "Not implemented", and any other 404 (server without the rooms deployed) is also under 500, so status alone can't tell them apart.
// Same probe as desktop/test-engine/services-watch.mjs.

const CHECKS = [
  // Our own services
  { name: 'YouCoded server (sign-in, marketplace, friends, sync between devices)', url: 'https://api.youcoded.ai/health', expect: 'ok' },
  { name: 'Online games with friends (Connect 4, Chess)', url: 'https://api.youcoded.ai/parties/connectfour/health-check', expect: 'page', mustMatchBody: /Not implemented/ },
  { name: 'Marketplace list of skills', url: 'https://raw.githubusercontent.com/itsdestin/wecoded-marketplace/master/index.json', expect: 'json' },
  { name: 'Marketplace list of themes', url: 'https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/registry/theme-registry.json', expect: 'json' },
  { name: 'Update check', url: 'https://api.github.com/repos/itsdestin/youcoded/releases/latest', expect: 'json' },
  { name: 'Announcements', url: 'https://raw.githubusercontent.com/itsdestin/youcoded/master/announcements.txt', expect: 'ok' },
  { name: 'Suggested local models list', url: 'https://raw.githubusercontent.com/itsdestin/youcoded/master/curated-models.json', expect: 'json' },
  // Sign-in routes the walk-through doesn't chat through (Destin, 2026-11-01): the pages load, the free addresses answer
  { name: 'OpenRouter models list (app\'s own assistant)', url: 'https://openrouter.ai/api/v1/models', expect: 'json' },
  { name: 'OpenRouter sign-in page', url: 'https://openrouter.ai/auth', expect: 'page' },
  { name: 'ChatGPT sign-in page', url: 'https://auth.openai.com/', expect: 'page' },
  { name: 'Claude sign-in page', url: 'https://claude.ai/login', expect: 'page' },
  { name: 'Claude developer sign-in page', url: 'https://platform.claude.com/', expect: 'page' },
  { name: 'Model details for custom providers', url: 'https://models.dev/api.json', expect: 'json' },
  // First-time setup downloads
  { name: 'Claude Code download (first-time setup)', url: 'https://registry.npmjs.org/@anthropic-ai/claude-code', expect: 'json' },
  { name: 'Node download (first-time setup)', url: 'https://nodejs.org/dist/index.json', expect: 'json' },
  { name: 'Local model downloads', url: 'https://huggingface.co/api/models?limit=1', expect: 'json' },
];

async function probe({ url, expect, mustMatchBody }) {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'YouCoded-service-check (+https://github.com/itsdestin/youcoded)' } });
    const ms = Date.now() - started;
    if (expect === 'page' && mustMatchBody) {
      const body = await res.text();
      return mustMatchBody.test(body) ? { ok: true, why: `answered ${res.status}`, ms } : { ok: false, why: `answered ${res.status} but not as the game rooms`, ms };
    }
    if (expect === 'page') return res.status < 500 ? { ok: true, why: `answered ${res.status}`, ms } : { ok: false, why: `server error ${res.status}`, ms };
    if (!res.ok) return { ok: false, why: `answered ${res.status}`, ms };
    if (expect === 'json') { try { JSON.parse(await res.text()); } catch { return { ok: false, why: 'answer is not readable data', ms }; } }
    return { ok: true, why: `answered ${res.status}`, ms };
  } catch (e) {
    // Name the cause only when it is known: a missing address vs a timeout vs anything else.
    const code = e?.cause?.code;
    const why = code === 'ENOTFOUND' ? 'address no longer exists' : e?.name === 'TimeoutError' ? 'no answer in 20s' : `could not connect (${code ?? e?.message})`;
    return { ok: false, why, ms: Date.now() - started };
  }
}

// One retry after a pause: a single blip shouldn't email anyone.
async function check(c) {
  let r = await probe(c);
  if (!r.ok) { await new Promise((ok) => setTimeout(ok, 15_000)); r = await probe(c); }
  return { ...c, ...r };
}

const results = await Promise.all(CHECKS.map(check));
const down = results.filter((r) => !r.ok);
const lines = results.map((r) => `${r.ok ? '✅' : '❌'} ${r.name} — ${r.why}`);
const summary = [`### Outside services: ${down.length ? `${down.length} down` : 'all answering'}`, '', ...lines.map((l) => `- ${l}`)].join('\n');
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) (await import('node:fs')).appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
process.exit(down.length ? 1 : 0);
