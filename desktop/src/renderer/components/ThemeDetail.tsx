import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { ThemeRegistryEntryWithStatus } from '../../shared/theme-marketplace-types';
import { useTheme } from '../state/theme-context';
import { applyThemeToDom } from '../themes/theme-engine';
import type { ThemeDefinition } from '../themes/theme-types';

interface ThemeDetailProps {
  entry: ThemeRegistryEntryWithStatus;
  onBack: () => void;
  onInstallComplete: () => void;
}

export default function ThemeDetail({ entry, onBack, onInstallComplete }: ThemeDetailProps) {
  const { setTheme, allThemes, activeTheme } = useTheme();
  const [installing, setInstalling] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);
  const [manifest, setManifest] = useState<ThemeDefinition | null>(null);
  const [fetchingManifest, setFetchingManifest] = useState(false);

  // Store the theme to revert to when leaving the try preview
  const revertThemeRef = useRef<ThemeDefinition | null>(null);

  const isInstalled = allThemes.some(t => t.slug === entry.slug) || entry.installed;

  // Fetch full manifest for try-before-install
  useEffect(() => {
    if (!entry.manifestUrl) return;
    setFetchingManifest(true);
    fetch(entry.manifestUrl)
      .then(res => res.ok ? res.json() : null)
      .then((data: ThemeDefinition | null) => {
        setManifest(data);
        setFetchingManifest(false);
      })
      .catch(() => setFetchingManifest(false));
  }, [entry.manifestUrl]);

  // Auto-revert on unmount if currently trying
  useEffect(() => {
    return () => {
      if (revertThemeRef.current) {
        applyThemeToDom(revertThemeRef.current);
        revertThemeRef.current = null;
      }
    };
  }, []);

  const handleTry = useCallback(() => {
    if (!manifest) return;
    if (trying) {
      // Revert
      if (revertThemeRef.current) {
        applyThemeToDom(revertThemeRef.current);
        revertThemeRef.current = null;
      }
      setTrying(false);
    } else {
      // Apply preview (tokens + shapes only — no assets since not downloaded)
      revertThemeRef.current = activeTheme;
      applyThemeToDom(manifest);
      setTrying(true);
    }
  }, [manifest, trying, activeTheme]);

  const handleBack = useCallback(() => {
    // Revert if trying
    if (revertThemeRef.current) {
      applyThemeToDom(revertThemeRef.current);
      revertThemeRef.current = null;
    }
    onBack();
  }, [onBack]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setError(null);
    try {
      const claude = (window as any).claude;
      const result = await claude.theme.marketplace.install(entry.slug);
      if (result.status === 'failed') {
        setError(result.error || 'Installation failed');
      } else {
        // Revert try-preview before completing
        if (revertThemeRef.current) {
          applyThemeToDom(revertThemeRef.current);
          revertThemeRef.current = null;
          setTrying(false);
        }
        onInstallComplete();
      }
    } catch (err: any) {
      setError(err?.message || 'Installation failed');
    } finally {
      setInstalling(false);
    }
  }, [entry.slug, onInstallComplete]);

  const handleUninstall = useCallback(async () => {
    setUninstalling(true);
    setError(null);
    try {
      const claude = (window as any).claude;
      const result = await claude.theme.marketplace.uninstall(entry.slug);
      if (result.status === 'failed') {
        setError(result.error || 'Uninstall failed');
      } else {
        onInstallComplete();
      }
    } catch (err: any) {
      setError(err?.message || 'Uninstall failed');
    } finally {
      setUninstalling(false);
    }
  }, [entry.slug, onInstallComplete]);

  const handleApply = useCallback(() => {
    // Revert try-preview, then set as active
    if (revertThemeRef.current) {
      revertThemeRef.current = null;
      setTrying(false);
    }
    setTheme(entry.slug);
  }, [entry.slug, setTheme]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-edge shrink-0">
        <button onClick={handleBack} className="text-fg-muted hover:text-fg mr-3 text-lg">&larr;</button>
        <h2 className="text-sm font-bold text-fg truncate">{entry.name}</h2>
        {trying && (
          <span className="ml-2 text-[9px] font-medium px-2 py-0.5 rounded-full bg-accent/15 text-accent">
            Previewing
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Preview */}
        <div className="w-full h-48 bg-well overflow-hidden">
          {entry.preview ? (
            <img
              src={entry.preview}
              alt={entry.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div
              className="w-full h-full flex items-center justify-center"
              style={{
                background: entry.dark
                  ? 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)'
                  : 'linear-gradient(135deg, #f5f5f5 0%, #e8e8e8 50%, #ddd 100%)',
              }}
            >
              <span className="text-fg-muted text-xs">No preview available</span>
            </div>
          )}
        </div>

        <div className="p-4 space-y-4">
          {/* Metadata */}
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`text-[10px] font-medium px-2 py-1 rounded-full ${
                entry.source === 'destinclaude'
                  ? 'bg-accent/15 text-accent'
                  : 'bg-fg-faint/20 text-fg-muted'
              }`}
            >
              {entry.source === 'destinclaude' ? 'Official' : 'Community'}
            </span>
            <span
              className="text-[10px] px-2 py-1 rounded-full border border-edge-dim text-fg-muted"
            >
              {entry.dark ? 'Dark' : 'Light'}
            </span>
            {entry.version && (
              <span className="text-[10px] text-fg-faint">v{entry.version}</span>
            )}
          </div>

          {/* Author */}
          <div>
            <span className="text-[10px] text-fg-faint uppercase tracking-wider">Author</span>
            <p className="text-xs text-fg-2 mt-0.5">{entry.author}</p>
          </div>

          {/* Description */}
          {entry.description && (
            <div>
              <span className="text-[10px] text-fg-faint uppercase tracking-wider">Description</span>
              <p className="text-xs text-fg-2 mt-0.5 leading-relaxed">{entry.description}</p>
            </div>
          )}

          {/* Features */}
          {entry.features.length > 0 && (
            <div>
              <span className="text-[10px] text-fg-faint uppercase tracking-wider">Features</span>
              <div className="flex gap-1.5 mt-1.5 flex-wrap">
                {entry.features.map(f => (
                  <span key={f} className="text-[10px] text-fg-muted bg-well px-2 py-1 rounded-sm border border-edge-dim">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Dates */}
          <div className="flex gap-4 text-[10px] text-fg-faint">
            {entry.created && <span>Created: {entry.created}</span>}
            {entry.updated && <span>Updated: {entry.updated}</span>}
          </div>

          {/* Error */}
          {error && (
            <p className="text-xs text-red-400 bg-red-400/10 rounded-lg px-3 py-2">{error}</p>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="px-4 py-3 border-t border-edge shrink-0 space-y-2">
        {/* Preview button — always visible */}
        <button
          onClick={handleTry}
          disabled={!manifest && !fetchingManifest}
          className={`w-full py-2 text-xs font-medium rounded-lg border transition-colors ${
            trying
              ? 'border-accent text-accent bg-accent/10 hover:bg-accent/20'
              : 'border-edge-dim text-fg-2 hover:text-fg hover:border-edge'
          } disabled:opacity-50`}
        >
          {fetchingManifest ? 'Loading preview...' : trying ? 'Revert to Previous Theme' : 'Preview Theme'}
        </button>

        {/* Install / Apply / Uninstall */}
        <div className="flex gap-2">
          {isInstalled ? (
            <>
              <button
                onClick={handleApply}
                className="flex-1 py-2 text-xs font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors"
              >
                Apply Theme
              </button>
              <button
                onClick={handleUninstall}
                disabled={uninstalling}
                className="py-2 px-4 text-xs font-medium rounded-lg border border-edge-dim text-fg-muted hover:text-fg hover:border-edge transition-colors disabled:opacity-50"
              >
                {uninstalling ? 'Removing...' : 'Uninstall'}
              </button>
            </>
          ) : (
            <button
              onClick={handleInstall}
              disabled={installing}
              className="flex-1 py-2 text-xs font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-50"
            >
              {installing ? 'Installing...' : 'Install Theme'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
