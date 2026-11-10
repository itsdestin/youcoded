const SECURE_BACKENDS: Record<string, string> = {
  kwallet: 'kwallet', kwallet5: 'kwallet5', kwallet6: 'kwallet6', gnome_libsecret: 'gnome-libsecret',
};

/** No usable secure storage on this computer: a known, explainable reason, so the message reaches the person
 *  as-is. WHY its own type (2026-11-02, release walk-through): this used to be a plain Error, which
 *  KeychainClient replaced with "The keychain helper could not start or receive the request" — telling
 *  someone on a desktop with no keyring to retry something that can never work. */
export class NoSecureStorageError extends Error {
  constructor() {
    super('No secure password storage was found on this computer, so the key can\'t be saved safely. '
      + 'YouCoded keeps keys in GNOME Keyring or KDE Wallet: install or start one, then try again.');
    this.name = 'NoSecureStorageError';
  }
}

/** Only non-secret startup metadata travels in argv/env. Explicit backend
 * selection preserves the parent's choice in an otherwise empty profile. */
export function keychainLaunchOptions(options: {
  packaged: boolean; appPath: string; name: string; backend: string; scratch: string; env: NodeJS.ProcessEnv;
}): { args: string[]; env: NodeJS.ProcessEnv } {
  const backend = SECURE_BACKENDS[options.backend];
  if (!backend) throw new NoSecureStorageError();
  const env = { ...options.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  // WHY: helper mode must be selected BEFORE normal app imports and side effects.
  env.YOUCODED_KEYCHAIN_HELPER = '1';
  env.YOUCODED_KEYCHAIN_NAME = options.name;
  env.YOUCODED_KEYCHAIN_SCRATCH = options.scratch;
  return {
    args: [...(options.packaged ? [] : [options.appPath]), `--password-store=${backend}`, `--user-data-dir=${options.scratch}`],
    env,
  };
}
