import type { ArtifactRecord, CentralIndexProject } from '../../../../shared/artifacts/types';

// Project View and the artifact panel read these. Shapes verified against
// source 2026-07-29:
//   listProjectsIndex -> { ok, projects: CentralIndexProject[] }  (projects-index.ts:102)
//   listSession       -> { ok, artifacts: ArtifactRecord[] }      (SessionDrawer.tsx:295)
//   listAllFiles      -> { ok, files: ArtifactRecord[], truncated } (ProjectView.tsx:557)
//   get               -> { ok, content, binary?, truncated?, sizeBytes? }
//   checkExistence    -> { ok, missingIds: string[] }             (SessionDrawer.tsx:146)
//
// The extra fields on a project (fileCount, conversationCount) are only present
// when the caller passes { withCounts: true } — the mock mirrors that so the
// no-counts fast path is exercised too, rather than always over-serving.

const T = '2026-07-28T16:20:00.000Z';

function version(sessionId: string, type: 'create' | 'edit' | 'read' | 'delivered', ts: string) {
  return { id: `v-${ts}`, ts, sessionId, type, author: 'agent' as const };
}

/** Tracked + discovered artifacts, keyed by project path. */
const BY_PROJECT: Record<string, ArtifactRecord[]> = {
  '/home/destin/youcoded-dev/youcoded': [
    // --- Files the SendUserFile turn in conversations/claude-code.jsonl hands
    // over. Tracked so the DeliverablesCard's thumbnails have content to show
    // (markdown → first lines, html → scaled page, png → readBinary mock).
    {
      id: 'a-sent-report',
      path: 'docs/reports/scroll-perf-report.md',
      kind: 'internal',
      absolutePath: null,
      lastModified: T,
      status: 'active',
      versions: [version('wb-1', 'create', T), version('wb-1', 'delivered', T)],
      comments: [],
      tags: [],
    },
    {
      id: 'a-sent-mockup',
      path: 'docs/mockups/settings-mockup.html',
      kind: 'internal',
      absolutePath: null,
      lastModified: T,
      status: 'active',
      versions: [version('wb-1', 'create', T)],
      comments: [],
      tags: [],
    },
    {
      id: 'a-sent-chart',
      path: 'latency-chart.png',
      kind: 'external',
      absolutePath: '/tmp/youcoded-scratch/latency-chart.png',
      lastModified: T,
      status: 'active',
      versions: [version('wb-1', 'read', T), version('wb-1', 'delivered', T)],
      comments: [],
      tags: [],
    },
    {
      // Vector image: the one source the magnifier keeps sharp at any zoom.
      id: 'a-sent-diagram',
      path: 'pipeline-diagram.svg',
      kind: 'external',
      absolutePath: '/tmp/youcoded-scratch/pipeline-diagram.svg',
      lastModified: T,
      status: 'active',
      versions: [version('wb-1', 'read', T)],
      comments: [],
      tags: [],
    },
    {
      // No preview for this type — exercises the letter-glyph fallback tile.
      id: 'a-sent-pdf',
      path: 'scroll-perf-report.pdf',
      kind: 'external',
      absolutePath: '/home/destin/Downloads/scroll-perf-report.pdf',
      lastModified: T,
      status: 'active',
      versions: [version('wb-1', 'read', T)],
      comments: [],
      tags: [],
    },
    {
      id: 'a-scroll-notes',
      path: 'docs/scroll-stick-notes.md',
      kind: 'internal',
      absolutePath: null,
      lastModified: T,
      status: 'active',
      versions: [
        version('wb-1', 'create', '2026-07-28T15:00:00.000Z'),
        version('wb-1', 'edit', T),
      ],
      comments: [],
      tags: [],
    },
    {
      // Doc comments mockup (Style A "Margin"): a plan with headings, lists
      // and a table — realistic material for several comments at once. Its
      // exact prose is quoted verbatim by the seeded comments in
      // state/doc-comments-store.ts, so the highlights land on first paint.
      id: 'a-onboarding-plan',
      path: 'docs/active/plans/2026-09-24-onboarding-redesign.md',
      kind: 'internal',
      absolutePath: null,
      lastModified: T,
      status: 'active',
      versions: [version('wb-1', 'create', T)],
      comments: [],
      tags: [],
    },
    {
      // Doc comments mockup: a Word document carrying two comments a
      // colleague left in Word (fixtures/docs/make.mjs), plus YouCoded-made
      // ones — all seeded in state/doc-comments-store.ts.
      id: 'a-launch-brief',
      path: 'docs/launch-brief.docx',
      kind: 'internal',
      absolutePath: null,
      lastModified: T,
      status: 'active',
      versions: [version('wb-1', 'read', T)],
      comments: [],
      tags: [],
    },
    {
      // Doc comments mockup: cell comments on the promo's sales workbook
      // (same bytes as the site scenario's Q3-sales.xlsx — its own name here,
      // since mock-shim.test.ts pins that name as the site scenario's alone).
      id: 'a-q3-sales-comments',
      path: 'reports/q3-sales-by-rep.xlsx',
      kind: 'internal',
      absolutePath: null,
      lastModified: T,
      status: 'active',
      versions: [version('wb-1', 'read', T)],
      comments: [],
      tags: [],
    },
    {
      // Over-cap TEXT, under FULL_READ_MAX_BYTES -> partial banner + "Load the
      // whole file". mock-shim's OVERSIZE_FIXTURES supplies the pretend size.
      id: 'a-big-log',
      path: 'logs/server.log',
      kind: 'internal',
      absolutePath: null,
      lastModified: T,
      status: 'active',
      versions: [version('wb-1', 'create', T)],
      comments: [],
      tags: [],
    },
    {
      // Over-cap TEXT, ABOVE the ceiling -> partial banner with no load action.
      id: 'a-huge-dump',
      path: 'logs/memory-dump.txt',
      kind: 'internal',
      absolutePath: null,
      lastModified: T,
      status: 'active',
      versions: [version('wb-1', 'create', T)],
      comments: [],
      tags: [],
    },
    {
      // A format YouCoded has no viewer for -> the handoff state.
      id: 'a-clip-mp4',
      path: 'media/demo-clip.mp4',
      kind: 'internal',
      absolutePath: null,
      lastModified: T,
      status: 'active',
      versions: [version('wb-1', 'create', T)],
      comments: [],
      tags: [],
    },
    {
      id: 'a-chatview',
      path: 'desktop/src/renderer/components/ChatView.tsx',
      kind: 'internal',
      absolutePath: null,
      lastModified: '2026-07-28T16:05:00.000Z',
      status: 'active',
      versions: [version('wb-1', 'edit', '2026-07-28T16:05:00.000Z')],
      comments: [],
      tags: [],
    },
    {
      // A `read` version: opened but never modified. Renders differently from an
      // edit, and nothing else in the fixture set covers that branch.
      id: 'a-pitfalls',
      path: 'docs/PITFALLS.md',
      kind: 'internal',
      absolutePath: null,
      lastModified: '2026-07-27T09:00:00.000Z',
      status: 'active',
      versions: [version('wb-1', 'read', '2026-07-27T09:00:00.000Z')],
      comments: [],
      tags: [],
    },
    {
      // status:'deleted' — the orphan/deleted treatment is otherwise invisible.
      id: 'a-old-plan',
      path: 'docs/old-approach.md',
      kind: 'internal',
      absolutePath: null,
      lastModified: '2026-07-20T11:00:00.000Z',
      status: 'deleted',
      versions: [version('wb-1', 'create', '2026-07-20T11:00:00.000Z')],
      comments: [],
      tags: [],
    },
    {
      // kind:'external' — lives outside the project root, so it carries an
      // absolutePath and renders with the external badge.
      id: 'a-external-notes',
      path: 'scratch.md',
      kind: 'external',
      absolutePath: '/home/destin/scratch.md',
      lastModified: '2026-07-26T08:30:00.000Z',
      status: 'active',
      versions: [version('wb-1', 'edit', '2026-07-26T08:30:00.000Z')],
      comments: [],
      tags: [],
    },
  ],
  '/home/destin/youcoded-dev/wecoded-themes': [
    {
      // The single `display: render` file the native fixture sends (wb-2).
      id: 'a-sent-theme-preview',
      path: 'previews/halftone-dimension.html',
      kind: 'internal',
      absolutePath: null,
      lastModified: T,
      status: 'active',
      versions: [version('wb-2', 'create', T)],
      comments: [],
      tags: [],
    },
    {
      id: 'a-contrast-report',
      path: 'reports/contrast-audit.md',
      kind: 'internal',
      absolutePath: null,
      lastModified: '2026-07-28T14:00:00.000Z',
      status: 'active',
      versions: [version('wb-2', 'create', '2026-07-28T14:00:00.000Z')],
      comments: [],
      tags: [],
    },
    {
      id: 'a-halftone-manifest',
      path: 'themes/halftone-dimension/manifest.json',
      kind: 'internal',
      absolutePath: null,
      lastModified: '2026-07-28T13:10:00.000Z',
      status: 'active',
      versions: [version('wb-2', 'edit', '2026-07-28T13:10:00.000Z')],
      comments: [],
      tags: [],
    },
  ],
};

/** Files discovered on disk that Claude never tracked. `discovered: true` means
 *  consumers skip orphan/existence checks and resolve content BY PATH — id is
 *  the canonical relative path, not a ULID (shared/artifacts/types.ts). */
function discovered(path: string, lastModified: string): ArtifactRecord {
  return {
    id: path,
    path,
    kind: 'internal',
    absolutePath: null,
    lastModified,
    status: 'active',
    versions: [],
    comments: [],
    tags: [],
    discovered: true,
  };
}

const DISCOVERED: Record<string, ArtifactRecord[]> = {
  '/home/destin/youcoded-dev/youcoded': [
    discovered('README.md', '2026-07-10T10:00:00.000Z'),
    discovered('docs/build-and-release.md', '2026-07-22T10:00:00.000Z'),
    discovered('docs/android-runtime.md', '2026-07-19T10:00:00.000Z'),
    discovered('desktop/docs/theme-spec.md', '2026-07-05T10:00:00.000Z'),
  ],
  '/home/destin/youcoded-dev/wecoded-themes': [
    discovered('README.md', '2026-07-12T10:00:00.000Z'),
    discovered('CONTRIBUTING.md', '2026-06-30T10:00:00.000Z'),
  ],
  '/home/destin/youcoded-dev/wecoded-marketplace': [
    discovered('README.md', '2026-07-15T10:00:00.000Z'),
  ],
};

export function projects(): CentralIndexProject[] {
  return [
    {
      id: '/home/destin/youcoded-dev/youcoded',
      name: 'youcoded',
      path: '/home/destin/youcoded-dev/youcoded',
      lastIndexed: T,
      lastSession: 'wb-1',
      contentTypes: ['artifacts', 'conversations'],
      stats: { artifactCount: 5 },
      // MOCKUP: deliberately long — this is the case that decides truncate-vs-wrap.
      description: 'The desktop and Android app itself — Electron shell, shared React renderer, and the Kotlin runtime that hosts it on a phone.',
    },
    {
      id: '/home/destin/youcoded-dev/wecoded-themes',
      name: 'wecoded-themes',
      path: '/home/destin/youcoded-dev/wecoded-themes',
      lastIndexed: '2026-07-28T14:00:00.000Z',
      lastSession: 'wb-2',
      contentTypes: ['artifacts', 'conversations'],
      stats: { artifactCount: 2 },
      description: 'Community theme registry.',
    },
    {
      // Never indexed, no artifacts — the empty-project state inside an
      // otherwise-populated view, which is where layout usually breaks.
      // MOCKUP: also the NO-description case, so the empty affordance and a
      // described row are visible in the same screenshot.
      id: '/home/destin/youcoded-dev/wecoded-marketplace',
      name: 'wecoded-marketplace',
      path: '/home/destin/youcoded-dev/wecoded-marketplace',
      lastIndexed: '',
      lastSession: null,
      contentTypes: [],
      stats: { artifactCount: 0 },
    },
    {
      // MOCKUP: a STOPPED synced project. Exists so the sync tombstone copy —
      // the longest string the pill has to survive — is reviewable.
      id: '/home/destin/recipes',
      name: 'recipes',
      path: '/home/destin/recipes',
      lastIndexed: '2026-06-02T10:00:00.000Z',
      lastSession: null,
      contentTypes: [],
      stats: { artifactCount: 0 },
      description: 'Grandma’s cards, scanned and typed up.',
    },
  ];
}

/** Counts are computed live by the real handler, so mirror that rather than
 *  hardcoding a number that can disagree with the arrays above. */
export function projectsWithCounts(): CentralIndexProject[] {
  return projects().map((p) => ({
    ...p,
    stats: { ...p.stats, artifactCount: (BY_PROJECT[p.path] ?? []).length },
    fileCount: (DISCOVERED[p.path] ?? []).length + (BY_PROJECT[p.path] ?? []).length,
    conversationCount: p.path.endsWith('youcoded') ? 5 : 1,
  }));
}

/** The landing-page embed's session (scenario=site, cwd ~/Documents). Its own
 *  two files rather than the youcoded repo's twelve: the recorded loop opens
 *  this drawer on camera, and a stranger watching a demo about a spreadsheet
 *  should see the spreadsheet, not somebody's source tree. */
const SITE_FILES: ArtifactRecord[] = [
  {
    id: 'a-q3-sales',
    path: 'Q3-sales.xlsx',
    kind: 'internal',
    absolutePath: null,
    lastModified: T,
    status: 'active',
    versions: [version('site-1', 'read', T)],
    comments: [],
    tags: [],
  },
  {
    id: 'a-sales-chart',
    path: 'Q3-sales.html',
    kind: 'internal',
    absolutePath: null,
    lastModified: T,
    status: 'active',
    versions: [version('site-1', 'create', T)],
    comments: [],
    tags: [],
  },
];

export function sessionArtifacts(sessionId: string): ArtifactRecord[] {
  // Session ids come from fixtures/sessions.ts; wb-1 works in youcoded, wb-2 in
  // wecoded-themes, matching each session's cwd.
  if (sessionId === 'site-1') return SITE_FILES;
  if (sessionId === 'wb-2') return BY_PROJECT['/home/destin/youcoded-dev/wecoded-themes'];
  return BY_PROJECT['/home/destin/youcoded-dev/youcoded'];
}

export function allFiles(projectId: string): ArtifactRecord[] {
  return [...(BY_PROJECT[projectId] ?? []), ...(DISCOVERED[projectId] ?? [])];
}

/** Content served by artifacts.get(). Keyed by artifact id. Long enough to
 *  scroll and to exercise markdown rendering, since a two-line file makes every
 *  reader look fine. */
/** A deliberately viewBox-ONLY SVG (no width/height attributes) served for any
 *  .svg path. That shape is the interesting one for the artifact zoom: such an
 *  SVG reports naturalWidth 300×150 in Chromium whatever its viewBox says, so it
 *  is the case the magnifier's sizing has to survive. The 1px hairlines and 6px
 *  text are there to be magnified — a vector source should stay razor-sharp at
 *  any zoom, unlike the PNG below. */
export const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500">' +
  '<rect width="800" height="500" fill="#101820"/>' +
  '<g stroke="#4ade80" stroke-width="0.5">' +
  Array.from({ length: 40 }, (_, i) => `<line x1="${i * 20}" y1="0" x2="${i * 20}" y2="500"/>`).join('') +
  '</g>' +
  '<circle cx="400" cy="250" r="120" fill="none" stroke="#f472b6" stroke-width="1"/>' +
  '<text x="400" y="250" fill="#e2e8f0" font-size="6" text-anchor="middle">' +
  'vector detail stays sharp at 800%</text>' +
  '<text x="400" y="470" fill="#94a3b8" font-size="18" text-anchor="middle">sample.svg</text>' +
  '</svg>';

export const CONTENT: Record<string, string> = {
  // SVG is the one image format that ALSO takes the text path — it renders
  // through ImageView but stays editable, so rendersFromBytesOnly() exempts it
  // and ActiveArtifactView still fetches its text. Without an entry here the
  // viewer reports "This file is no longer on disk" and never reaches the image.
  'a-sent-diagram': SAMPLE_SVG,
  // Over-cap fixtures: mock-shim slices these and reports a much larger
  // sizeBytes, so the partial-view states are reachable without an 8 MB file.
  'a-big-log': `2026-08-25T14:00:00Z  INFO  request 1000 handled in 0ms\n2026-08-25T14:01:01Z  INFO  request 1001 handled in 3ms\n2026-08-25T14:02:02Z  INFO  request 1002 handled in 6ms\n2026-08-25T14:03:03Z  INFO  request 1003 handled in 9ms\n2026-08-25T14:04:04Z  INFO  request 1004 handled in 12ms\n2026-08-25T14:05:05Z  INFO  request 1005 handled in 15ms\n2026-08-25T14:06:06Z  INFO  request 1006 handled in 18ms\n2026-08-25T14:07:07Z  INFO  request 1007 handled in 21ms\n2026-08-25T14:08:08Z  INFO  request 1008 handled in 24ms\n2026-08-25T14:09:09Z  INFO  request 1009 handled in 27ms\n2026-08-25T14:10:00Z  INFO  request 1010 handled in 30ms\n2026-08-25T14:11:01Z  INFO  request 1011 handled in 33ms\n2026-08-25T14:12:02Z  INFO  request 1012 handled in 36ms\n2026-08-25T14:13:03Z  INFO  request 1013 handled in 39ms\n2026-08-25T14:14:04Z  INFO  request 1014 handled in 42ms\n2026-08-25T14:15:05Z  INFO  request 1015 handled in 45ms\n2026-08-25T14:16:06Z  INFO  request 1016 handled in 48ms\n2026-08-25T14:17:07Z  INFO  request 1017 handled in 51ms\n2026-08-25T14:18:08Z  INFO  request 1018 handled in 54ms\n2026-08-25T14:19:09Z  INFO  request 1019 handled in 57ms\n2026-08-25T14:20:00Z  INFO  request 1020 handled in 60ms\n2026-08-25T14:21:01Z  INFO  request 1021 handled in 63ms\n2026-08-25T14:22:02Z  INFO  request 1022 handled in 66ms\n2026-08-25T14:23:03Z  INFO  request 1023 handled in 69ms\n2026-08-25T14:24:04Z  INFO  request 1024 handled in 72ms\n2026-08-25T14:25:05Z  INFO  request 1025 handled in 75ms\n2026-08-25T14:26:06Z  INFO  request 1026 handled in 78ms\n2026-08-25T14:27:07Z  INFO  request 1027 handled in 81ms\n2026-08-25T14:28:08Z  INFO  request 1028 handled in 84ms\n2026-08-25T14:29:09Z  INFO  request 1029 handled in 87ms\n2026-08-25T14:30:00Z  INFO  request 1030 handled in 90ms\n2026-08-25T14:31:01Z  INFO  request 1031 handled in 93ms\n2026-08-25T14:32:02Z  INFO  request 1032 handled in 96ms\n2026-08-25T14:33:03Z  INFO  request 1033 handled in 99ms\n2026-08-25T14:34:04Z  INFO  request 1034 handled in 102ms\n2026-08-25T14:35:05Z  INFO  request 1035 handled in 105ms\n2026-08-25T14:36:06Z  INFO  request 1036 handled in 108ms\n2026-08-25T14:37:07Z  INFO  request 1037 handled in 111ms\n2026-08-25T14:38:08Z  INFO  request 1038 handled in 114ms\n2026-08-25T14:39:09Z  INFO  request 1039 handled in 117ms`,
  'a-huge-dump': `2026-08-25T14:00:00Z  INFO  request 1000 handled in 0ms\n2026-08-25T14:01:01Z  INFO  request 1001 handled in 3ms\n2026-08-25T14:02:02Z  INFO  request 1002 handled in 6ms\n2026-08-25T14:03:03Z  INFO  request 1003 handled in 9ms\n2026-08-25T14:04:04Z  INFO  request 1004 handled in 12ms\n2026-08-25T14:05:05Z  INFO  request 1005 handled in 15ms\n2026-08-25T14:06:06Z  INFO  request 1006 handled in 18ms\n2026-08-25T14:07:07Z  INFO  request 1007 handled in 21ms\n2026-08-25T14:08:08Z  INFO  request 1008 handled in 24ms\n2026-08-25T14:09:09Z  INFO  request 1009 handled in 27ms\n2026-08-25T14:10:00Z  INFO  request 1010 handled in 30ms\n2026-08-25T14:11:01Z  INFO  request 1011 handled in 33ms\n2026-08-25T14:12:02Z  INFO  request 1012 handled in 36ms\n2026-08-25T14:13:03Z  INFO  request 1013 handled in 39ms\n2026-08-25T14:14:04Z  INFO  request 1014 handled in 42ms\n2026-08-25T14:15:05Z  INFO  request 1015 handled in 45ms\n2026-08-25T14:16:06Z  INFO  request 1016 handled in 48ms\n2026-08-25T14:17:07Z  INFO  request 1017 handled in 51ms\n2026-08-25T14:18:08Z  INFO  request 1018 handled in 54ms\n2026-08-25T14:19:09Z  INFO  request 1019 handled in 57ms\n2026-08-25T14:20:00Z  INFO  request 1020 handled in 60ms\n2026-08-25T14:21:01Z  INFO  request 1021 handled in 63ms\n2026-08-25T14:22:02Z  INFO  request 1022 handled in 66ms\n2026-08-25T14:23:03Z  INFO  request 1023 handled in 69ms\n2026-08-25T14:24:04Z  INFO  request 1024 handled in 72ms\n2026-08-25T14:25:05Z  INFO  request 1025 handled in 75ms\n2026-08-25T14:26:06Z  INFO  request 1026 handled in 78ms\n2026-08-25T14:27:07Z  INFO  request 1027 handled in 81ms\n2026-08-25T14:28:08Z  INFO  request 1028 handled in 84ms\n2026-08-25T14:29:09Z  INFO  request 1029 handled in 87ms\n2026-08-25T14:30:00Z  INFO  request 1030 handled in 90ms\n2026-08-25T14:31:01Z  INFO  request 1031 handled in 93ms\n2026-08-25T14:32:02Z  INFO  request 1032 handled in 96ms\n2026-08-25T14:33:03Z  INFO  request 1033 handled in 99ms\n2026-08-25T14:34:04Z  INFO  request 1034 handled in 102ms\n2026-08-25T14:35:05Z  INFO  request 1035 handled in 105ms\n2026-08-25T14:36:06Z  INFO  request 1036 handled in 108ms\n2026-08-25T14:37:07Z  INFO  request 1037 handled in 111ms\n2026-08-25T14:38:08Z  INFO  request 1038 handled in 114ms\n2026-08-25T14:39:09Z  INFO  request 1039 handled in 117ms`,
  // Doc comments mockup fixture — every seeded comment's quote in
  // state/doc-comments-store.ts is an exact substring of this text.
  'a-onboarding-plan': `# Onboarding Redesign Plan

**Goal:** get a brand-new user from first launch to their first real answer
in under two minutes, without a wall of text explaining the app before they
can use it.

## Background

Today's first-run flow shows five screens before the composer is reachable:
a welcome slide, a permissions primer, a model picker, a theme picker, and a
tips carousel. Session recordings show most people thumb through all five
without reading them, then ask their first question anyway.

## Goals

- Reach a working composer in one screen, not five
- Explain permissions at the moment they matter, not up front
- Let model and theme choices happen later, from Settings, with sensible defaults
- Keep the tone plain — no "unlock your workflow" language

## Non-goals

- Redesigning Settings itself
- Changing the accounts/sign-in flow
- Any change to the Android install flow (tracked separately)

## Proposed flow

1. App opens straight into a chat with the composer focused
2. A single welcome bubble from the assistant explains what to try
3. The first tool permission prompt doubles as the only "how this works" moment
4. A dismissible strip offers the theme picker once, after the first reply

## Screens removed vs kept

| Screen | Today | Proposed |
|---|---|---|
| Welcome slide | Full screen, 3 taps to dismiss | Removed — folded into the first bubble |
| Permissions primer | Full screen | Removed — explained inline at first prompt |
| Model picker | Full screen | Moved to Settings, sensible default picked |
| Theme picker | Full screen | One-time dismissible strip after first reply |
| Tips carousel | Full screen, 4 slides | Removed entirely |

## Open questions

- Does removing the model picker hurt people who came specifically for a local model?
- Should the theme strip be able to come back later from Settings if dismissed?

## Rollout

Ship behind a flag for one release, watch first-session completion rate, then default it on.
`,
  'a-sent-report': `# Scroll performance report

**Verdict:** the re-arm check ran on every scroll event — ~1,400 calls/s while
scrolling. Throttling it to animation frames cut renderer CPU from 38% to 6%.

## Method

- Recorded 20s of continuous scrolling in a 900-message session
- Sampled with the Performance panel at 1ms resolution
- Compared master (\`4cc745ec\`) against the throttled build

## Results

| Build | Scroll CPU | Dropped frames |
|---|---|---|
| master | 38% | 212 |
| throttled | 6% | 3 |
`,
  // The landing-page demo's generated chart, shown and EDITED on camera.
  // Two constraints the body has to satisfy, both learned the hard way:
  //   1. every bar takes its colour from ONE custom property, because the loop
  //      edits that single line and the whole chart must repaint from it;
  //   2. no comments explaining the CSS -- this file is on screen in a product
  //      demo, so it has to read like something the assistant wrote. (The bar
  //      heights are percentages, which need `height:100%` on .col: a flex item
  //      sized by its content has no definite height and every bar came out at
  //      zero. That note belongs here, not in the fixture.)
  'a-sales-chart': `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { --bar: #6E56CF; }
  body { margin: 0; padding: 34px 40px; font-family: system-ui, sans-serif;
         background: #fbfaff; color: #1a1524; }
  h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -.02em; }
  p.sub { margin: 0 0 28px; color: #6b6480; font-size: 14px; }
  .chart { display: flex; align-items: stretch; gap: 26px; height: 300px;
           padding: 0 6px 12px; border-bottom: 1px solid #e4e0ee; }
  .col { flex: 1; height: 100%; display: flex; flex-direction: column;
         justify-content: flex-end; align-items: center; gap: 8px; }
  .bar { width: 100%; border-radius: 8px 8px 0 0; background: var(--bar); }
  .val { font-size: 13px; font-weight: 600; color: #4a4360; }
  .labels { display: flex; gap: 26px; padding: 10px 6px 0; }
  .labels span { flex: 1; text-align: center; font-size: 13px; color: #6b6480; }
</style></head><body>
  <h1>Q3 sales by region</h1>
  <p class="sub">Thousands of dollars &middot; July&ndash;September 2026</p>
  <div class="chart">
    <div class="col"><span class="val">128</span><div class="bar" style="height:64%"></div></div>
    <div class="col"><span class="val">196</span><div class="bar" style="height:98%"></div></div>
    <div class="col"><span class="val">84</span><div class="bar" style="height:42%"></div></div>
    <div class="col"><span class="val">151</span><div class="bar" style="height:76%"></div></div>
    <div class="col"><span class="val">112</span><div class="bar" style="height:56%"></div></div>
  </div>
  <div class="labels"><span>North</span><span>South</span><span>East</span><span>West</span><span>Online</span></div>
</body></html>`,
  'a-sent-mockup': `<!doctype html>
<html><head><style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #f6f4ef; color: #222; }
  header { background: #2f2a4a; color: #fff; padding: 28px 40px; font-size: 28px; }
  main { display: grid; grid-template-columns: 220px 1fr; min-height: 640px; }
  nav { background: #e9e5da; padding: 24px; font-size: 18px; line-height: 2.2; }
  section { padding: 32px 40px; }
  .row { display: flex; justify-content: space-between; padding: 18px 0; border-bottom: 1px solid #d8d3c6; font-size: 20px; }
  .toggle { width: 56px; height: 30px; border-radius: 15px; background: #ff4fa3; }
</style></head><body>
<header>Settings · Appearance</header>
<main>
  <nav>General<br>Appearance<br>Permissions<br>Sync<br>Development</nav>
  <section>
    <div class="row"><span>Theme</span><span>Halftone Dimension</span></div>
    <div class="row"><span>Show timestamps</span><span class="toggle"></span></div>
    <div class="row"><span>Compact tool cards</span><span class="toggle"></span></div>
    <div class="row"><span>Font size</span><span>15px</span></div>
  </section>
</main>
</body></html>`,
  'a-sent-theme-preview': `<!doctype html>
<html><head><style>
  body { margin: 0; min-height: 720px; background: radial-gradient(circle at 20% 20%, #ff4fa3 2px, transparent 3px) 0 0/28px 28px, #1b1530; color: #fff; font-family: system-ui, sans-serif; }
  .bubble { margin: 60px auto; width: 640px; padding: 32px; border-radius: 36px; background: rgba(255,255,255,.08); backdrop-filter: blur(6px); font-size: 22px; line-height: 1.5; }
  .accent { color: #ff4fa3; font-weight: 700; }
</style></head><body>
  <div class="bubble"><span class="accent">Halftone Dimension</span> — glass bubbles, hot-pink accent, 2× radii. This is the theme preview the assistant rendered for review.</div>
  <div class="bubble">Second bubble so the page has enough height to read as a real screen in the thumbnail.</div>
</body></html>`,
  'a-scroll-notes': `# Scroll stick — working notes

The chat view re-arms its stick-to-bottom check on **every** scroll event, so
scrolling up fights the auto-scroll.

## What we know

- \`ChatView.tsx\` calls the re-arm check inline in \`onScroll\`.
- The check reads \`scrollHeight\`, which forces layout on every wheel tick.
- At 200+ timeline entries the jank is visible; below ~40 it is not, which is
  why this only reproduces on long conversations.

## Options considered

| Option | Verdict |
|---|---|
| Throttle the handler | Chosen — smallest change, no behaviour shift |
| IntersectionObserver sentinel | Better long-term, bigger diff |
| Disable auto-scroll entirely | Rejected, regresses the common case |

## Next

Move the check off the hot path and re-measure with the stress fixture.
`,
  'a-contrast-report': `# Contrast audit — crème

Ran \`scripts/audit-theme-contrast.mjs\` against every token pair.

    creme: fg-dim   3.10:1  PASS
    creme: fg-muted 4.62:1  PASS
    creme: link     3.59:1  PASS
    creme: on-accent 7.11:1 PASS

All pairs clear the 3:1 floor for large text. \`fg-dim\` is closest to the line
and should not be darkened further without re-running this.
`,
  'a-pitfalls': `# Pitfalls

Read-only in this session — no edits were made.

- IPC parity: preload, remote-shim and SessionService must agree.
- Chat reducer: \`USER_PROMPT\` is optimistic; the transcript clears \`pending\`.
`,
  'README.md': `# YouCoded

Cross-platform AI assistant app. Desktop (Electron) and Android (Kotlin) share
one React renderer.

## Getting started

    bash setup.sh
    cd youcoded/desktop && npm ci && npm test
`,
  'a-chatview': `import React, { useRef, useCallback } from 'react';

// Chat timeline. Owns its own scroll container so the terminal pane can own
// its scroll independently.
export function ChatView({ sessionId }) {
  const ref = useRef(null);
  const stick = useRef(true);

  // Re-arm stick-to-bottom only when the user lands at the bottom. Throttled:
  // reading scrollHeight forces layout, and this used to run on every event.
  const onScroll = useCallback(throttle(() => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  }, 100), []);

  return <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto" />;
}
`,
  'a-old-plan': `# Old approach (superseded)

Kept for reference. We first tried disabling auto-scroll entirely, which fixed
the jank and broke the common case: new messages no longer came into view.

Superseded by the throttled re-arm in scroll-stick-notes.md.
`,
  'a-external-notes': `# Scratch

Lives outside the project root, so it is tracked as an *external* artifact and
carries an absolute path.

- check whether the re-arm threshold should be 32px or 48px
- ask Destin which feels right on the touchpad
`,
  'a-halftone-manifest': `{
  "name": "Halftone Dimension",
  "slug": "halftone-dimension",
  "source": "community",
  "colors": { "accent": "#FF2E88", "canvas": "#0B0B14" },
  "radii": { "lg": "18px" }
}
`,
  'docs/build-and-release.md': `# Build and release

Desktop and Android build from one tag.

    cd youcoded/desktop && npm ci && npm test && npm run build

Release builds run in CI; do not cut one by hand.
`,
  'docs/android-runtime.md': `# Android runtime

The WebView loads the same React bundle as desktop. The vendored terminal
module owns the PTY and pushes raw bytes over a WebSocket event.
`,
  'desktop/docs/theme-spec.md': `# Theme spec

Themes are semantic CSS custom properties toggled by a data-theme attribute on
the html element. Status colors stay hardcoded; only surface, text and border
tokens are themed.
`,
  'CONTRIBUTING.md': `# Contributing

Themes are submitted as a manifest plus assets. Run the contrast audit before
opening a PR — the gate rejects anything under 3:1.
`,
};

/** Project View's Context tab. Shape from shared/project-context-types.ts.
 *  Only the youcoded project carries context files — a project with none is
 *  the state that shows the tab's empty copy, and that is worth being able to
 *  see next to a populated one. */
export function contextGroups(projectPath: string) {
  if (!projectPath.endsWith('/youcoded')) return [];
  return [
    {
      scope: 'project' as const,
      files: [
        {
          id: `project:${projectPath}/CLAUDE.md`,
          scope: 'project' as const,
          kind: 'claude-md' as const,
          label: 'CLAUDE.md',
          absolutePath: `${projectPath}/CLAUDE.md`,
          timing: 'always' as const,
          editable: true,
          blastRadius: 'project' as const,
          description: 'Repo guidance — desktop + Android layout, IPC parity rules.',
          size: '4.1 KB',
        },
        {
          id: `project:${projectPath}/.claude/rules/react-renderer.md`,
          scope: 'project' as const,
          kind: 'rule' as const,
          label: 'react-renderer',
          absolutePath: `${projectPath}/.claude/rules/react-renderer.md`,
          timing: 'conditional' as const,
          glob: 'desktop/src/renderer/**',
          editable: true,
          blastRadius: 'project' as const,
          description: 'Primitives, overlays, and the UI iteration tooling.',
          size: '6.8 KB',
        },
      ],
    },
    {
      scope: 'global' as const,
      files: [
        {
          id: 'global:/home/destin/.claude/CLAUDE.md',
          scope: 'global' as const,
          kind: 'claude-md' as const,
          label: 'CLAUDE.md',
          absolutePath: '/home/destin/.claude/CLAUDE.md',
          timing: 'always-everywhere' as const,
          editable: true,
          blastRadius: 'global' as const,
          description: 'Personal instructions applied in every project.',
          size: '0.4 KB',
        },
      ],
    },
  ];
}


/** Draw a 1600×1000 test pattern and return it as base64 PNG.
 *
 *  WHY generate rather than paste a literal: the magnifier is suppressed on any
 *  source smaller than the 180px lens, so the 96×64 SAMPLE_PNG below cannot
 *  review it at all — and a real 1600×1000 photo pasted as base64 would add tens
 *  of kilobytes of unreadable noise to this file. The pattern carries 7px text
 *  and 1px rules on purpose: those are the details a loupe exists to reveal, and
 *  they are also what visibly degrades at 400%, which is the honest thing to
 *  show. Browser-only (the workbench is a browser tab); returns null elsewhere. */
export function makeDetailPngBase64(): string | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 1000;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const bg = ctx.createLinearGradient(0, 0, 1600, 1000);
  bg.addColorStop(0, '#0f172a');
  bg.addColorStop(1, '#1e293b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1600, 1000);

  ctx.strokeStyle = 'rgba(148,163,184,0.35)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= 1600; x += 40) {
    ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, 1000); ctx.stroke();
  }
  for (let y = 0; y <= 1000; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(1600, y + 0.5); ctx.stroke();
  }

  // Fine text across the WHOLE frame, not one corner: the magnifier is reviewed
  // by hovering wherever the rig happens to point, and a lens landing on empty
  // background proves nothing about whether it reveals detail.
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '7px monospace';
  for (let row = 0; row < 62; row++) {
    const line = `${String(row).padStart(2, '0')}  p99 latency ${(12 + row * 0.37).toFixed(2)}ms`
      + ' — the quick brown fox jumps over the lazy dog 0123456789 — legible only under the lens';
    // Three columns: one line of 7px monospace is ~520px wide and the frame is
    // 1600px, so a single column would leave two thirds of it empty.
    for (const x of [24, 560, 1096]) ctx.fillText(line, x, 116 + row * 14);
  }

  ctx.fillStyle = '#38bdf8';
  ctx.font = 'bold 48px sans-serif';
  ctx.fillText('latency-chart.png', 24, 70);

  return canvas.toDataURL('image/png').split(',')[1] ?? null;
}

/** Build a small, valid two-page PDF and return it as base64.
 *
 *  WHY generated rather than a real file: the workbench needs a PDF to review
 *  the viewer's zoom at all, and the only PDFs on this machine are Destin's
 *  personal documents — which must not become a repo fixture. This one is
 *  ASCII-only and about 1 KB.
 *
 *  The pages carry 6pt text on purpose. That is the whole point of zooming a
 *  PDF: at the default scale it is a grey smear, and a PDF must get SHARPER
 *  when enlarged (re-rendered by pdf.js) rather than merely bigger. */
export function makeSamplePdfBase64(): string | null {
  if (typeof btoa === 'undefined') return null;

  const page = (n: number) => {
    const lines: string[] = ['BT /F1 22 Tf 54 720 Td (Scroll performance report) Tj ET'];
    lines.push(`BT /F1 11 Tf 54 694 Td (page ${n} of 2 - the small print below is the zoom target) Tj ET`);
    for (let i = 0; i < 38; i++) {
      // 6pt lines: illegible at 100%, readable once pdf.js re-renders bigger.
      lines.push(
        `BT /F1 6 Tf 54 ${664 - i * 15} Td `
        + `(${String(i).padStart(2, '0')}  p99 ${(12 + i * 0.37).toFixed(2)}ms  `
        + 'the quick brown fox jumps over the lazy dog 0123456789 - legible only when enlarged) Tj ET',
      );
    }
    return lines.join('\n');
  };

  // Object bodies in order; object N is at index N-1.
  const bodies: string[] = [];
  bodies.push('<< /Type /Catalog /Pages 2 0 R >>');
  bodies.push('<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>');
  const pageObj = (contents: number) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R `
    + '/Resources << /Font << /F1 7 0 R >> >> >>';
  const stream = (body: string) => `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  bodies.push(pageObj(4));
  bodies.push(stream(page(1)));
  bodies.push(pageObj(6));
  bodies.push(stream(page(2)));
  bodies.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  // Assemble, recording each object's byte offset for the xref table. The
  // content is ASCII, so string length IS byte length here.
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = pdf.length;
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return btoa(pdf);
}

/** A 96×64 PNG (gradient + a dot) served by the mock artifacts.readBinary for
 *  ANY image path, so image thumbnails in the workbench show a picture instead
 *  of the letter glyph. Generated 2026-08-25; content is irrelevant. */
export const SAMPLE_PNG_BASE64 = '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';

// ---------------------------------------------------------------------------
// Promo (scenario=site&student=1): a STUDENT's projects. Project View opens on
// the focused conversation's folder, else the first project in the list — and
// the only populated project above is the YouCoded repo itself (CLAUDE.md,
// developer rules), which is what the project-view beat filmed before this. The
// student's session cwds (fixtures/sessions.ts studentSessions) do not name a
// project, so Econ 201 sits FIRST and is what the Projects button opens on.
// Everything here is in the student's voice: a viewer of the promo sees a
// course folder, not somebody's source tree.
export const STUDENT_ECON = '/home/you/School/Econ 201';
const STUDENT_T = '2026-09-02T19:40:00.000Z';

function tracked(id: string, path: string, sessionId: string, type: 'create' | 'edit' | 'read', ts = STUDENT_T): ArtifactRecord {
  return { id, path, kind: 'internal', absolutePath: null, lastModified: ts, status: 'active',
           versions: [version(sessionId, type, ts)], comments: [], tags: [] };
}

/** Files per student project. Econ 201 is the one on camera: the syllabus,
 *  two weeks of lecture notes, a problem set, the brief the assistant wrote,
 *  and Q3-sales.xlsx — the spreadsheet the files beat sorts and totals (a
 *  club-treasurer sheet living in the course folder is fine for a 3-second
 *  shot; the point is that the same file is there on every device). */
const STUDENT_FILES: Record<string, ArtifactRecord[]> = {
  [STUDENT_ECON]: [
    tracked('a-econ-brief', 'midterm brief.md', 'wb-past-0', 'create'),
    tracked('a-q3-sales', 'Q3-sales.xlsx', 'wb-past-0', 'read', '2026-09-01T15:10:00.000Z'),
    discovered('syllabus.md', '2026-08-20T10:00:00.000Z'),
    discovered('lecture notes/week 5 — elasticity.md', '2026-08-28T10:00:00.000Z'),
    discovered('lecture notes/week 6 — tax incidence.md', '2026-09-01T10:00:00.000Z'),
    discovered('problem set 4.md', '2026-08-30T10:00:00.000Z'),
  ],
  '/home/you/School/Bio 110': [
    tracked('a-bio-outline', 'lab report outline.md', 'wb-past-2', 'create', '2026-08-31T10:00:00.000Z'),
    discovered('lab 3 data.csv', '2026-08-29T10:00:00.000Z'),
  ],
  '/home/you/Robotics Club': [
    tracked('a-club-newsletter', 'newsletter — September.md', 'site-3', 'create', '2026-09-01T10:00:00.000Z'),
  ],
  '/home/you/Job hunt': [
    tracked('a-cover-letter', 'cover letter — internship.md', 'site-5', 'create', '2026-08-27T10:00:00.000Z'),
    discovered('resume.md', '2026-08-25T10:00:00.000Z'),
  ],
};

export function studentProjects(): CentralIndexProject[] {
  const row = (path: string, name: string, description: string, lastSession: string | null, lastIndexed = STUDENT_T): CentralIndexProject => ({
    id: path, name, path, lastIndexed, lastSession,
    contentTypes: ['artifacts', 'conversations'],
    stats: { artifactCount: (STUDENT_FILES[path] ?? []).filter((a) => !a.discovered).length },
    description,
  });
  return [
    row(STUDENT_ECON, 'Econ 201', 'Microeconomics, fall term — notes, problem sets and the midterm brief.', 'wb-past-0'),
    row('/home/you/School/Bio 110', 'Bio 110', 'Intro biology — labs and the report outline.', 'wb-past-2', '2026-08-31T10:00:00.000Z'),
    row('/home/you/Robotics Club', 'Robotics Club', 'Newsletter drafts and the club budget.', 'site-3', '2026-09-01T10:00:00.000Z'),
    row('/home/you/Job hunt', 'Job hunt', 'Cover letters and the internship list.', 'site-5', '2026-08-27T10:00:00.000Z'),
    // No "Documents" project on purpose: the focused site session's cwd IS
    // /home/you/Documents, and Project View re-homes to the focused
    // conversation's project when one matches — with it listed, the Projects
    // button opened on Documents instead of Econ 201 (probed 2026-09-03).
  ];
}

/** Counts mirror the real handler: files from the arrays above, conversations
 *  from whatever the caller counts (the shim passes its own listConversations). */
export function studentProjectsWithCounts(conversationCount: (path: string) => number): CentralIndexProject[] {
  return studentProjects().map((p) => ({
    ...p,
    fileCount: (STUDENT_FILES[p.path] ?? []).length,
    conversationCount: conversationCount(p.path),
  }));
}

export function studentAllFiles(projectId: string): ArtifactRecord[] {
  return STUDENT_FILES[projectId] ?? [];
}

/** The Session Files drawer of a student session. Every student session
 *  shows the Econ 201 session's files: the phone beat resumes "econ midterm
 *  brief" into a session id minted at resume time, and the drawer must list
 *  Q3-sales.xlsx there — the same file the laptop's files beat edited. */
export function studentSessionFiles(): ArtifactRecord[] {
  return STUDENT_FILES[STUDENT_ECON].filter((a) => !a.discovered);
}

/** Project View's Context tab for the student. Plain words only — the tab is
 *  on camera for 2.5 s and "CLAUDE.md" / "react-renderer" read as developer
 *  furniture to a viewer. The global note is the one the storyboard quotes. */
export function studentContextGroups(projectPath: string) {
  if (projectPath !== STUDENT_ECON) return [];
  return [
    {
      scope: 'project' as const,
      files: [
        {
          id: `project:${projectPath}/notes for the assistant.md`,
          scope: 'project' as const,
          kind: 'claude-md' as const,
          label: 'Econ 201',
          absolutePath: `${projectPath}/notes for the assistant.md`,
          timing: 'always' as const,
          editable: true,
          blastRadius: 'project' as const,
          description: 'Use the syllabus chapter numbers. Show the formula before the numbers.',
          size: '0.3 KB',
        },
      ],
    },
    {
      scope: 'global' as const,
      files: [
        {
          id: 'global:/home/you/about me.md',
          scope: 'global' as const,
          kind: 'claude-md' as const,
          label: 'About me',
          absolutePath: '/home/you/about me.md',
          timing: 'always-everywhere' as const,
          editable: true,
          blastRadius: 'global' as const,
          description: 'Second-year student. Keep explanations short.',
          size: '0.1 KB',
        },
      ],
    },
  ];
}
