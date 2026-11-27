// register.ts — plugs the built-in shell into the backend. Injected into the iPhone backend bundle ONLY (build-backend.mjs).
//
// WHY here and not in the backend's own start-up file: that file is desktop source, which must never know about
// just-bash. The iPhone build adds this one file in front of it; it hands the shell registry the function that runs a
// command in the app's built-in shell (see setInAppSpawner in shell-registry.ts). Nothing else changes.
import { setInAppSpawner } from '../../../desktop/src/main/harness/shell-registry';
import { getGithubClient } from '../../../desktop/src/main/github-client';
import { createInAppSpawner } from './adapter';

// Set by the bundle's own banner (build-backend.mjs): where a file of the compiled tree lives on this phone.
declare const __ycPath: (rel: string) => string;

setInAppSpawner(createInAppSpawner({
  workerPath: __ycPath('dist/ios-shell/worker.js'),
  // The app's saved GitHub sign-in, if any, read from the app's own store (github-client.ts) without starting a program.
  getTokens: async () => {
    const token = (await getGithubClient()?.getToken())?.token;
    return token ? { 'github.com': token } : {};
  },
  // The same sign-in also says who the person is. GitHub's own no-reply address form keeps their real email private.
  getIdentity: async () => {
    const login = (await getGithubClient()?.status())?.login;
    return login ? { name: login, email: `${login}@users.noreply.github.com` } : undefined;
  },
}));
