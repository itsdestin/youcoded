// Probe fixture for home-sandbox-import-style.test.ts. The import STYLE is the
// whole point of this file — do not "tidy" it to match the default-import one.
import * as os from 'node:os';

export const homedirViaNamespaceImport = (): string => os.homedir();
