// Port offsets let a dev instance coexist with the user's installed/built app.
// Set YOUCODED_PORT_OFFSET (e.g. 50) to shift every port this module exposes.
// Renderer code can import these safely — the process.env lookup is guarded so
// the browser sandbox (no process global) sees offset 0 and built-app defaults.
const env = typeof process !== 'undefined' && process.env ? process.env : ({} as Record<string, string | undefined>);
const raw = Number(env.YOUCODED_PORT_OFFSET ?? 0);

const PORT_OFFSET = Number.isFinite(raw) ? raw : 0;
export const VITE_DEV_PORT = 5173 + PORT_OFFSET;
export const REMOTE_SERVER_DEFAULT_PORT = 9900 + PORT_OFFSET;
// llama-server (native local engine, Plan B). 9920 built / 9970 dev — clear of
// the remote server (9900/9950). (9961 was the Android releaseTest bridge, a build type removed 2026-11-10; the port is now unused.)
export const ENGINE_PORT = 9920 + PORT_OFFSET;
