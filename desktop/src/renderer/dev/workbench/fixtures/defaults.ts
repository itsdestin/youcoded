// Shape is fixed by the typed contract: useIpc.ts:216 declares
// `defaults.get(): Promise<{ skipPermissions: boolean; model: string; projectFolder: string }>`.
// Not a loose Record — the compiler checks this one.
export interface MockDefaults {
  skipPermissions: boolean;
  model: string;
  projectFolder: string;
  // Assistant settings → General → "Start on" (Q-3a, 2026-09-05). Absent here
  // on purpose: the fixture is an install that only ever set the Claude alias,
  // which is every install today, so the page's fallback path is what renders.
  startModel?: import('../../../components/model/ModelPicker').ModelChoice;
}

export function defaults(): MockDefaults {
  return {
    skipPermissions: false,
    // An ALIAS, which is the only thing this field ever holds: main seeds it
    // 'sonnet' (ipc-handlers DEFAULTS_INITIAL) and Assistant settings writes
    // `choice.alias` into it. It said 'claude-sonnet-4-6' — a raw model id —
    // which contradicted this fixture's own comment below and made every
    // surface reading it render an id where a user would read "Sonnet".
    model: 'sonnet',
    projectFolder: '/home/you/code/youcoded',
  };
}
