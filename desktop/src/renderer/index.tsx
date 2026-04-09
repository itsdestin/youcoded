import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import App from './App';

// Apply theme before React mounts to prevent FOUC (flash of unstyled content)
const storedTheme = localStorage.getItem('destincode-theme') || 'midnight';
document.documentElement.setAttribute('data-theme', storedTheme);

// macOS traffic lights need left padding on the header bar.
// In fullscreen the traffic lights disappear, so we remove the inset.
if (navigator.platform === 'MacIntel' || navigator.platform === 'MacPPC') {
  document.body.classList.add('mac-titlebar-inset');
  const claude = (window as any).claude;
  if (claude?.window?.onFullscreenChanged) {
    claude.window.onFullscreenChanged((isFullscreen: boolean) => {
      if (isFullscreen) {
        document.body.classList.remove('mac-titlebar-inset');
      } else {
        document.body.classList.add('mac-titlebar-inset');
      }
    });
  }
}

/** Minimal login screen for remote browser access. */
function LoginScreen({ onLogin }: { onLogin: (password: string) => Promise<void>; }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await onLogin(password);
    } catch (err: any) {
      setError(
        err.message === 'no-password-configured'
          ? 'Remote access is not configured. Set a password in the desktop app.'
          : 'Invalid password'
      );
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center h-full bg-panel text-fg">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 w-72">
        <h1 className="text-xl font-bold text-center mb-2">DestinCode Remote</h1>
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="px-3 py-2 rounded-sm bg-inset border border-edge text-sm focus:outline-none focus:border-fg-muted"
          autoFocus
          disabled={loading}
        />
        <button type="submit" disabled={loading} className="px-3 py-2 rounded-sm bg-blue-600 hover:bg-blue-500 text-sm font-medium disabled:opacity-50">
          {loading ? 'Connecting...' : 'Connect'}
        </button>
        {error && (
          <p className="text-red-400 text-xs text-center">{error}</p>
        )}
      </form>
    </div>
  );
}

/**
 * Wrapper that owns all connection logic. LoginScreen is pure-presentational.
 * This eliminates the race condition where LoginScreen and Root both
 * independently manage connection state.
 */
// Capture before any shim can modify window.claude
const isElectron = !!(window as any).claude;
// Android WebView loads from file:// — always auto-connects, never needs a password screen
const isAndroid = location.protocol === 'file:';

// Set default platform for Electron path (browser/remote path sets it via remote-shim auth:ok)
if (isElectron && !(window as any).__PLATFORM__) {
  (window as any).__PLATFORM__ = 'electron';
}

function Root() {
  const [connected, setConnected] = useState(isElectron);
  const [hasConnectedOnce, setHasConnectedOnce] = useState(isElectron);
  const [shimReady, setShimReady] = useState(isElectron);

  // In browser mode: install shim once, attempt token auto-login, listen for state changes
  useEffect(() => {
    if (isElectron) return;
    import('./remote-shim').then(({ installShim, connect, onConnectionStateChange }) => {
      installShim();
      setShimReady(true);

      onConnectionStateChange((state) => {
        const isConnected = state === 'connected';
        setConnected(isConnected);
        if (isConnected) setHasConnectedOnce(true);
      });

      // Android WebView: auto-connect (LocalBridgeServer accepts without password)
      if (location.protocol === 'file:') {
        connect('android-local', false).catch((err) => {
          console.error('Android auto-connect failed:', err);
        });
        return;
      }

      // Auto-login with stored token
      const storedToken = localStorage.getItem('destincode-remote-token');
      if (storedToken) {
        connect(storedToken, true).catch(() => {
          localStorage.removeItem('destincode-remote-token');
        });
      }
    });
  }, [isElectron]);

  const handleLogin = useCallback(async (password: string) => {
    const { connect } = await import('./remote-shim');
    await connect(password);
  }, []);

  // Once connected, keep showing App even during transient disconnections
  if (isElectron || connected || hasConnectedOnce) {
    return <App />;
  }

  if (!shimReady) {
    return <div className="flex items-center justify-center h-full bg-panel text-fg text-sm">Loading...</div>;
  }

  // Android always auto-connects to local bridge — never show the password screen.
  // shimReady guarantees window.claude is populated before App renders.
  if (isAndroid) {
    return <App />;
  }

  return <LoginScreen onLogin={handleLogin} />;
}

createRoot(document.getElementById('root')!).render(<Root />);
