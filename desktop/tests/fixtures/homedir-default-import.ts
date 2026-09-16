// Probe fixture for home-sandbox-import-style.test.ts. The import STYLE is the
// whole point of this file — do not "tidy" it to match the namespace one.
import os from 'os';

export const homedirViaDefaultImport = (): string => os.homedir();
