import { spawn } from 'node:child_process';
import * as path from 'node:path';

/** WHY: a scrubbed Luna HOME/XDG gives Electron's OS opener an unrelated browser
 * association. Only the OAuth page uses the installed browser's normal profile;
 * client auth, files, guard, and subsequent model execution stay private. */
export async function openLunaAuthBrowser(
  url: string,
  browserHome: string,
  options: { launch?: typeof spawn; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  let target: URL;
  try { target = new URL(url); } catch { throw new Error('Luna sign-in URL is not an HTTPS authorization page.'); }
  if (target.protocol !== 'https:' || target.hostname !== 'auth.openai.com'
    || target.pathname !== '/oauth/authorize' || target.username || target.password) {
    throw new Error('Luna sign-in refuses a non-OpenAI authorization page.');
  }
  if (!browserHome || !path.isAbsolute(browserHome)) throw new Error('Luna browser home is unavailable.');
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), HOME: browserHome };
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
    'TMPDIR', 'LUNA_GUARD_URL', 'YOUCODED_LUNA_EXPERIMENT', 'LUNA_FIXTURE_ROOT']) delete env[key];
  await new Promise<void>((resolve, reject) => {
    // No shell and no raw URL in output: Chrome hands the link to the user's
    // existing browser instance instead of creating another private profile.
    const child = (options.launch ?? spawn)('/usr/bin/google-chrome-stable', [url], {
      cwd: browserHome, env, stdio: 'ignore', detached: true,
    });
    child.once('error', () => reject(new Error('Could not open the isolated ChatGPT sign-in page.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
