// One call that applies every per-window security rule to an app window, so main.ts (which has a line budget) stays small.
//   - which permissions a page may ask for         (permission-policy.ts)
//   - Office editor frames stay on their own origin (office/office-frame-guard.ts)
//   - HTML preview / Pages frames cannot navigate themselves away (preview-frame-guard.ts)
import path from 'path';
import { sealOfficeFrames } from './office/office-frame-guard';
import { installPermissionPolicy } from './permission-policy';
import { sealPreviewFrames } from './preview-frame-guard';

export { safeOpenExternal } from './safe-open';

/** `log` is the app logger (level, tag, message). Safe to call for every window: the permission policy is per-session and idempotent. */
export function secureAppWindow(
  win: { webContents: Parameters<typeof sealPreviewFrames>[0] & Parameters<typeof sealOfficeFrames>[0] & { session: Parameters<typeof installPermissionPolicy>[0] } },
  opts: { devServerUrl: string; mainDir: string; log: (level: 'WARN', tag: string, msg: string) => void },
): void {
  const contents = win.webContents;
  installPermissionPolicy(contents.session, {
    indexHtmlPath: path.join(opts.mainDir, '../renderer/index.html'),
    devServerUrl: opts.devServerUrl,
    log: (m) => opts.log('WARN', 'Permissions', m),
  });
  sealOfficeFrames(contents);
  sealPreviewFrames(contents, opts.devServerUrl);
}
