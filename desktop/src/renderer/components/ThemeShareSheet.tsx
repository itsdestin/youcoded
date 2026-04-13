import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../state/theme-context';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import type { PublishState } from '../../shared/theme-marketplace-types';

interface ThemeShareSheetProps {
  themeSlug: string;
  onClose: () => void;
}

export default function ThemeShareSheet({ themeSlug, onClose }: ThemeShareSheetProps) {
  const { allThemes } = useTheme();
  const theme = allThemes.find(t => t.slug === themeSlug);

  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  // null = still resolving (shows neutral placeholder). Set on mount via IPC.
  const [publishState, setPublishState] = useState<PublishState | null>(null);

  // Generate preview on mount
  useEffect(() => {
    const claude = (window as any).claude;
    if (!claude?.theme?.marketplace?.generatePreview) {
      setPreviewLoading(false);
      return;
    }
    claude.theme.marketplace.generatePreview(themeSlug)
      .then((path: string | null) => {
        setPreviewPath(path);
        setPreviewLoading(false);
      })
      .catch(() => setPreviewLoading(false));
  }, [themeSlug]);

  // Resolve publish state on mount — drives the publish button appearance.
  // Null means "still resolving" (shows a neutral placeholder).
  useEffect(() => {
    let cancelled = false;
    const claude = (window as any).claude;
    claude?.theme?.marketplace?.resolvePublishState?.(themeSlug)
      .then((state: PublishState | null) => {
        if (!cancelled && state) setPublishState(state);
      })
      .catch(() => {
        if (!cancelled) setPublishState({ kind: 'unknown', reason: 'IPC failed' });
      });
    return () => { cancelled = true; };
  }, [themeSlug]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handlePublish = useCallback(async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      const claude = (window as any).claude;
      const result = await claude?.theme?.marketplace?.publish(themeSlug);
      if (result?.prUrl && result?.prNumber) {
        // Optimistic flip — don't wait for re-resolve
        setPublishState({ kind: 'in-review', prNumber: result.prNumber, prUrl: result.prUrl });
      } else {
        setPublishError('Publish completed but no PR info returned. Check GitHub.');
      }
    } catch (err: any) {
      setPublishError(err?.message || 'Failed to publish');
    } finally {
      setPublishing(false);
    }
  }, [themeSlug]);

  if (!theme) return null;

  return (
    // Overlay layer L2 — theme-driven via Scrim/OverlayPanel.
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 p-5 max-w-md w-[calc(100%-2rem)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-fg">
            Publish: {theme.name}
          </h3>
          <button onClick={onClose} className="text-fg-muted hover:text-fg text-lg leading-none">
            &times;
          </button>
        </div>

        {/* Preview image */}
        <div className="rounded-lg overflow-hidden border border-edge-dim mb-4">
          {previewLoading ? (
            <div className="w-full h-40 bg-well flex items-center justify-center">
              <span className="text-xs text-fg-muted animate-pulse">Generating preview...</span>
            </div>
          ) : previewPath ? (
            <img
              src={`file://${previewPath.replace(/\\/g, '/')}`}
              alt={`${theme.name} preview`}
              className="w-full h-auto"
            />
          ) : (
            /* Fallback: color swatch card */
            <div>
              <div style={{ height: 6, background: `linear-gradient(90deg, ${theme.tokens.canvas}, ${theme.tokens.accent})` }} />
              <div className="px-3 py-2.5" style={{ background: theme.tokens.canvas }}>
                <p className="text-xs font-medium" style={{ color: theme.tokens.fg }}>{theme.name}</p>
                <p className="text-[10px] mt-0.5" style={{ color: theme.tokens['fg-muted'] }}>
                  {theme.dark ? 'Dark' : 'Light'} theme
                  {theme.effects?.particles && theme.effects.particles !== 'none' ? ` \u00b7 ${theme.effects.particles} particles` : ''}
                  {theme.font?.family ? ` \u00b7 ${theme.font.family.split(',')[0].replace(/'/g, '')}` : ''}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Info */}
        <p className="text-[11px] text-fg-muted mb-4 leading-relaxed">
          This will create a pull request to the{' '}
          <span className="text-fg-2 font-medium">destinclaude-themes</span>{' '}
          repository on GitHub. Your theme will be reviewed and, if approved, added to the marketplace for all users.
          {previewPath && ' A preview image will be included in the submission.'}
        </p>

        <p className="text-[10px] text-fg-faint mb-4">
          Requires the <span className="font-mono">gh</span> CLI to be installed and authenticated.
        </p>

        {/* Publish section — state-driven */}
        <div className="border-t border-edge-dim pt-4">
          {renderPublishButton({
            state: publishState,
            publishing,
            previewLoading,
            onPublish: handlePublish,
          })}
          {publishError && (
            <p className="text-xs text-red-400 text-center mt-2">{publishError}</p>
          )}
        </div>
      </OverlayPanel>
    </>
  );
}

function renderPublishButton(args: {
  state: PublishState | null;
  publishing: boolean;
  previewLoading: boolean;
  onPublish: () => void;
}): React.ReactNode {
  const { state, publishing, previewLoading, onPublish } = args;

  // Pre-resolution — state still loading. No spinner to avoid flicker on the
  // common fast path (<200ms).
  if (!state) {
    return (
      <div className="w-full py-2.5 text-xs rounded-lg border border-edge-dim text-fg-faint text-center">
        Checking publish status…
      </div>
    );
  }

  const openExternal = (url: string) => {
    (window as any).claude?.shell?.openExternal?.(url);
  };

  if (state.kind === 'in-review') {
    return (
      <a
        href={state.prUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => { e.preventDefault(); openExternal(state.prUrl); }}
        className="block w-full py-2.5 text-xs font-medium rounded-lg border border-edge text-fg-muted text-center cursor-pointer hover:text-fg hover:border-edge-bright transition-colors"
        title="Your submission is awaiting review. You'll see ✓ Published here once it's merged."
      >
        Pull request open · #{state.prNumber} ↗
      </a>
    );
  }

  if (state.kind === 'published-current') {
    return (
      <a
        href={state.marketplaceUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => { e.preventDefault(); openExternal(state.marketplaceUrl); }}
        className="block w-full py-2.5 text-xs font-medium rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-500 text-center hover:bg-emerald-500/20 transition-colors"
      >
        ✓ Published ↗
      </a>
    );
  }

  if (state.kind === 'published-drift') {
    return (
      <>
        <button
          onClick={onPublish}
          disabled={publishing || previewLoading}
          className="w-full py-2.5 text-xs font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-50"
        >
          {publishing ? 'Publishing update…' : 'Publish update'}
        </button>
        <p className="text-[10px] text-fg-faint text-center mt-1.5">
          Local changes not yet published
        </p>
      </>
    );
  }

  if (state.kind === 'unknown') {
    return (
      <>
        <button
          onClick={onPublish}
          disabled={publishing || previewLoading}
          className="w-full py-2.5 text-xs font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-50"
          title={`Couldn't verify publish status — proceed at your own risk (${state.reason})`}
        >
          {publishing ? 'Publishing…' : previewLoading ? 'Generating preview…' : '⚠ Publish to Marketplace'}
        </button>
        <p className="text-[10px] text-fg-faint text-center mt-1.5">
          Could not verify status: {state.reason}
        </p>
      </>
    );
  }

  // draft — the default happy path.
  return (
    <button
      onClick={onPublish}
      disabled={publishing || previewLoading}
      className="w-full py-2.5 text-xs font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-50"
    >
      {publishing ? 'Publishing…' : previewLoading ? 'Generating preview…' : 'Publish to Marketplace'}
    </button>
  );
}
