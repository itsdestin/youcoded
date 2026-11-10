import { CROSS_PROJECT_SLUG, type StoredProject } from '../../../../shared/permission-types';

// Fixed timestamps, not Date.now(): a seed that moves with the clock makes
// "granted 3 days ago" non-reproducible between design reviews (same reason
// scenarios.ts pins T0).
const T0 = 1_753_800_000_000;
const at = (daysAgo: number) => new Date(T0 - daysAgo * 86_400_000).toISOString();

/** Two projects, deliberately mixed. Row shapes that MUST stay represented:
 *  a tool-wide grant (no pattern), an MCP grant, and a legacy entry with no
 *  recorded cwd — a design that only works on tidy data looks fine without them. */
export function permissions(): StoredProject[] {
  return [
    {
      // The one non-folder bucket (D2): "Always allow" on the user's OWN
      // file-defined specialist applies in every project, so the store files it
      // under CROSS_PROJECT_SLUG with no cwd. Settings must render it FIRST as
      // "All projects" — keep it here so the card is on every review sheet.
      slug: CROSS_PROJECT_SLUG,
      rules: [
        { tool: 'Task', pattern: 'read-write:file:docs-writer@3f9a1c77be02', action: 'allow', match: 'exact', grantedAt: at(4) },
      ],
    },
    {
      slug: '-home-destin-youcoded-dev-youcoded',
      cwd: '/home/destin/youcoded-dev/youcoded',
      rules: [
        { tool: 'Bash', pattern: 'git push origin master', action: 'allow', grantedAt: at(2) },
        // Older wide grants (no grantedAt = saved before the narrowing): these now cover less.
        { tool: 'Bash', pattern: 'curl*', action: 'allow', match: 'glob' },
        { tool: 'Bash', pattern: 'npm install*', action: 'allow', match: 'glob', grantedAt: at(30) },
        { tool: 'Bash', pattern: 'npm run*', action: 'allow', match: 'glob', grantedAt: at(30) },
        { tool: 'Edit', pattern: 'desktop/src/renderer/App.tsx', action: 'allow', grantedAt: at(9) },
        // Tool-wide: no pattern. Must render as visibly broader than the rest.
        { tool: 'Write', action: 'allow', grantedAt: at(1) },
        { tool: 'mcp__github__create_issue', action: 'allow', grantedAt: at(14) },
      ],
    },
    {
      // No `cwd`: written before the management UI existed. The path is NOT
      // recoverable from the slug — the UI must say so rather than guess.
      slug: '-home-destin-notes',
      rules: [{ tool: 'Bash', pattern: 'rm -rf build', action: 'allow' }],
    },
  ];
}

/** Many rules, long subjects, and a worktree that shares a basename with its
 *  parent repo — the case that catches a heading using basename alone. */
export function stressPermissions(): StoredProject[] {
  const long = 'cd packages/renderer && npm run build -- --mode production --sourcemap --outDir ../../dist/renderer';
  return [
    ...permissions(),
    {
      slug: '-home-destin-youcoded-dev-worktrees-youcoded',
      cwd: '/home/destin/youcoded-dev/worktrees/youcoded',
      rules: Array.from({ length: 40 }, (_, i) => ({
        tool: i % 4 === 0 ? 'Bash' : 'Edit',
        pattern: i % 4 === 0 ? `${long} # ${i}` : `src/very/deeply/nested/path/to/module-${i}.ts`,
        action: 'allow' as const,
        ...(i % 3 === 0 ? { grantedAt: at(i) } : {}),
      })),
    },
  ];
}
