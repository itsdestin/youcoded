import { passiveRead } from './cloud-files/path-access';
import path from 'path';
import { normalizeRepoUrl, RepoUrlInfo } from './project/repo-url';

export interface RepoInfo extends Partial<RepoUrlInfo> { hasRepo: boolean; remoteUrl?: string }

// WHY: read .git/config directly (no git spawn) and reuse the pure normalizer.
// Returns hasRepo:false when there is no .git, no origin remote, or the remote
// is not a GitHub URL we can build a webUrl for.
export async function getRepoInfo(projectPath: string): Promise<RepoInfo> {
  try {
    // WHY: opening Project is not consent to download repository metadata.
    const bytes = await passiveRead(path.join(projectPath, '.git', 'config'));
    if (!bytes) return { hasRepo: false };
    const cfg = bytes.toString('utf8');
    // Find [remote "origin"] ... url = <value>
    const block = /\[remote "origin"\][^[]*/s.exec(cfg)?.[0] ?? '';
    // WHY: anchor to line start so this matches `url =` only, not `pushurl =`
    // (url is a substring of pushurl — an unanchored match reports the wrong repo
    // for fork-and-push-elsewhere configs).
    const url = /(?:^|\n)\s*url\s*=\s*(.+)/.exec(block)?.[1]?.trim();
    if (!url) return { hasRepo: false };
    const info = normalizeRepoUrl(url);
    if (!info) return { hasRepo: true, remoteUrl: url };
    return { hasRepo: true, remoteUrl: url, ...info };
  } catch {
    return { hasRepo: false };
  }
}
