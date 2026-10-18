import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { scanProjectSkills, scanSkills } from './skill-scanner';
import { buildClaudeCodeContext } from './claude-code-context';
import type { DiscoveryJob, DiscoveryReply } from './session-discovery';

// WHY reuse the existing scanner: project precedence, plugin namespaces and
// frontmatter must remain identical while the blocking reads leave main.
export function runDiscoveryJob(job: DiscoveryJob): DiscoveryReply {
  try {
  let value: DiscoveryReply & { ok: true };
  if (job.kind === 'claude-context') {
    value = { ok: true, value: buildClaudeCodeContext(job.cwd, job.modelLabel) };
  } else {
    const seen = new Set<string>();
    const skills = [...scanProjectSkills(job.cwd), ...scanSkills()].filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
    value = { ok: true, value: skills };
  }
  return value;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

if (!isMainThread) parentPort?.postMessage(runDiscoveryJob(workerData as DiscoveryJob));
