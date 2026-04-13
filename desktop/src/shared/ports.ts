// Port offsets let a dev instance coexist with the user's installed/built app.
// Set DESTINCODE_PORT_OFFSET (e.g. 50) to shift every port this module exposes.
// Renderer code can import these safely — the process.env lookup is guarded so
// the browser sandbox (no process global) sees offset 0 and built-app defaults.
const env = typeof process !== 'undefined' && process.env ? process.env : ({} as Record<string, string | undefined>);
const raw = Number(env.DESTINCODE_PORT_OFFSET ?? 0);

export const PORT_OFFSET = Number.isFinite(raw) ? raw : 0;
export const VITE_DEV_PORT = 5173 + PORT_OFFSET;
export const REMOTE_SERVER_DEFAULT_PORT = 9900 + PORT_OFFSET;
