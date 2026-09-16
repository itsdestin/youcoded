const SECURE_BACKENDS: Record<string, string> = {
  kwallet: 'kwallet', kwallet5: 'kwallet5', kwallet6: 'kwallet6', gnome_libsecret: 'gnome-libsecret',
};

/** Only non-secret startup metadata travels in argv/env. Explicit backend
 * selection preserves the parent's choice in an otherwise empty profile. */
export function keychainLaunchOptions(options: {
  packaged: boolean; appPath: string; name: string; backend: string; scratch: string; env: NodeJS.ProcessEnv;
}): { args: string[]; env: NodeJS.ProcessEnv } {
  const backend = SECURE_BACKENDS[options.backend];
  if (!backend) throw new Error('A secure storage backend is not available. Unlock your system keychain and try again.');
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
