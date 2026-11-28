#!/usr/bin/env node
// services-watch.mjs — is every online service the app depends on still there?
//
// WHY (Destin, 2026-11-01): the online games server's address vanished from the
// internet and nobody noticed until a hands-on phone test. This runs daily from
// .github/workflows/services-watch.yml; a red run emails the owner.
//
// Needs no secrets and signs nobody in. Each check only asks "does this address
// exist and answer?" — it never judges content beyond that, so a service that
// answers with an error page still counts as ALIVE unless it is a server error.
//
// Exit codes: 0 all alive · 1 at least one service is gone or broken.
// To add a service: append to SERVICES with the address the app really uses
// (search desktop/src for it) and what a user loses when it is gone.

import { promises as dns } from 'node:dns';

const SERVICES = [
  {
    name: 'Online games rooms (Connect 4, Chess)',
    // desktop/src/renderer/game/party-client.ts PARTYKIT_HOST. The rooms moved from
    // hosted PartyKit (shut down 2026-10-23) into the marketplace Worker on 2026-11-01.
    url: 'https://api.youcoded.ai/parties/connectfour/health-check',
    loses: 'Connect 4 and Chess matches cannot start',
    // WHY a body check: a websocket-only room answers a plain GET with 404 and the
    // text "Not implemented". Any other 404 (e.g. the Worker without the game rooms
    // deployed) is also under 500, so the status alone could not tell them apart.
    mustMatchBody: /Not implemented/,
  },
  {
    name: 'Friends and online status',
    // desktop/src/main/presence-socket.ts PRESENCE_CAPABILITIES_URL
    url: 'https://api.youcoded.ai/social/presence/capabilities',
    loses: 'friends list and "Online" status',
  },
  {
    name: 'Skill marketplace list',
    // desktop/src/main/skill-provider.ts REGISTRY_BASE + /index.json
    url: 'https://raw.githubusercontent.com/itsdestin/wecoded-marketplace/master/index.json',
    loses: 'the Marketplace shows nothing to install',
  },
  {
    name: 'Theme marketplace list',
    url: 'https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/registry/theme-registry.json',
    loses: 'no community themes to browse',
  },
  {
    name: 'Recommended models list',
    url: 'https://raw.githubusercontent.com/itsdestin/youcoded/master/curated-models.json',
    loses: 'the model picker loses its recommendations',
  },
  {
    name: 'OpenRouter (pay-as-you-go models)',
    url: 'https://openrouter.ai/api/v1/models',
    loses: 'OpenRouter models cannot be listed or used',
  },
];

async function check(svc) {
  const host = new URL(svc.url).hostname;
  try {
    await dns.lookup(host);
  } catch (e) {
    return { ok: false, why: `address does not exist (${e.code || e.message})` };
  }
  try {
    const res = await fetch(svc.url, { signal: AbortSignal.timeout(15000) });
    if (res.status < 500) {
      if (svc.mustMatchBody && !svc.mustMatchBody.test(await res.text().catch(() => ''))) {
        return { ok: false, why: `HTTP ${res.status} but not the expected answer (service missing?)` };
      }
      return { ok: true, why: `HTTP ${res.status}` };
    }
    const body = await res.text().catch(() => '');
    if (svc.healthyBody && svc.healthyBody.test(body)) return { ok: true, why: `HTTP ${res.status} (expected for this service)` };
    return { ok: false, why: `server error HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, why: `no answer (${e.name === 'TimeoutError' ? 'timed out' : e.message})` };
  }
}

const results = await Promise.all(SERVICES.map(async (s) => ({ ...s, ...(await check(s)) })));
const lines = ['| Service | Status | If it is down, users lose |', '|---|---|---|'];
for (const r of results) lines.push(`| ${r.name} | ${r.ok ? '✅ ' : '❌ '}${r.why} | ${r.loses} |`);
const summary = lines.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Online services the app depends on\n\n${summary}\n`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
