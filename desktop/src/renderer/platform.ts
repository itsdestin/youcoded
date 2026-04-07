export type Platform = 'electron' | 'android' | 'browser'

export function getPlatform(): Platform {
  return (window as any).__PLATFORM__ || 'electron'
}

export function isAndroid(): boolean {
  return getPlatform() === 'android'
}

export function isTouchDevice(): boolean {
  return getPlatform() === 'android' || getPlatform() === 'browser'
}

// ─── Connection mode (local native vs remote desktop) ───────────────────────

export type ConnectionMode = 'local' | 'remote'

let _connectionMode: ConnectionMode = 'local';
let _connectionModeListeners: ((mode: ConnectionMode) => void)[] = [];

export function getConnectionMode(): ConnectionMode {
  return _connectionMode;
}

export function isRemoteMode(): boolean {
  return _connectionMode === 'remote';
}

export function setConnectionMode(mode: ConnectionMode): void {
  if (_connectionMode === mode) return;
  _connectionMode = mode;
  _connectionModeListeners.forEach(cb => cb(mode));
}

export function onConnectionModeChange(cb: (mode: ConnectionMode) => void): () => void {
  _connectionModeListeners.push(cb);
  return () => {
    _connectionModeListeners = _connectionModeListeners.filter(l => l !== cb);
  };
}
