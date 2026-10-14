import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../state/theme-context';
import type { PublishState } from '../../shared/theme-marketplace-types';
import { Button, CARD_LEVEL_1, Dialog, FieldError, LoadingState } from './ui';

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
        if (!path) console.warn(`[ThemeShareSheet] Preview generation returned null for slug=${themeSlug} — falling back to swatch`);
        else console.log(`[ThemeShareSheet] Preview ready for slug=${themeSlug} path=${path}`);
        setPreviewPath(path);
        setPreviewLoading(false);
      })
      .catch((err: any) => {
        console.warn(`[ThemeShareSheet] Preview generation threw for slug=${themeSlug}:`, err);
        setPreviewLoading(false);
      });
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

  // Escape is the shared popup's own (it registers one closer; a second here made two).

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
      <Dialog
        open
        onClose={onClose}
        size="panel"
        // WHY the shared popup's title (final-review#ST-21/#PR-7 sweep; guide "Popups": the 16px
        // title, the drawn ✕ — never a × letter — and the tapered line): this drew its own 14px
        // bold heading and a "×" character.
        title={`Publish: ${theme.name}`}
        // Marked once the preview image settles — never mid-spinner (the
        // publish-status placeholder above it is deliberately spinner-free).
        screen={previewLoading ? undefined : 'marketplace/theme-share'}
      >
        {/* Preview image — a picture of the item, so it needs no label (guide "Spacing"). */}
        <div className="rounded-lg overflow-hidden border border-edge-card">
          {previewLoading ? (
            <div className="w-full h-40 bg-well flex items-center justify-center">
              <LoadingState what="the preview" variant="inline" />
            </div>
          ) : previewPath ? (
            <img
              // Windows absolute paths need file:///C:/... (triple slash). The old
              // file://C:/... form renders as a broken-image icon in Chromium's
              // stricter path parsing. Cache-bust by mtime so re-generated previews
              // don't show stale PNG from the browser's image cache.
              src={`file:///${previewPath.replace(/\\/g, '/').replace(/^\/+/, '')}?t=${Date.now()}`}
              alt={`${theme.name} preview`}
              className="w-full h-auto"
              onError={() => {
                // If the PNG fails to load (bad path, corrupt file, missing),
                // clear previewPath so the swatch fallback renders instead of
                // a broken-image icon.
                console.warn(`[ThemeShareSheet] <img> failed to load for slug=${themeSlug} path=${previewPath} — falling back to swatch`);
                setPreviewPath(null);
              }}
            />
          ) : (
            /* Fallback: color swatch card */
            <div>
              <div style={{ height: 6, background: `linear-gradient(90deg, ${theme.tokens.canvas}, ${theme.tokens.accent})` }} />
              <div className="px-3 py-2.5" style={{ background: theme.tokens.canvas }}>
                <p className="text-xs font-medium" style={{ color: theme.tokens.fg }}>{theme.name}</p>
                <p className="text-3xs mt-0.5" style={{ color: theme.tokens['fg-muted'] }}>
                  {theme.dark ? 'Dark' : 'Light'} theme
                  {theme.effects?.particles && theme.effects.particles !== 'none' ? ` \u00b7 ${theme.effects.particles} particles` : ''}
                  {theme.font?.family ? ` \u00b7 ${theme.font.family.split(',')[0].replace(/'/g, '')}` : ''}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* WHY one card for what publishing does (the one popup rule): these two lines sat bare on
            the popup, and a full-width line cut above the button (guide: no line crosses a popup). */}
        <div className={`${CARD_LEVEL_1} p-3 space-y-2`}>
        <p className="text-2xs text-fg-2 leading-relaxed">
          This will create a pull request to the{' '}
          <span className="text-fg-2 font-medium">wecoded-themes</span>{' '}
          repository on GitHub. Your theme will be reviewed and, if approved, added to the marketplace for all users.
          {previewPath && ' A preview image will be included in the submission.'}
        </p>

        <p className="text-3xs text-fg-muted">
          Requires the <span className="font-mono">gh</span> CLI to be installed and authenticated.
        </p>
        </div>

        {/* Publish section — state-driven */}
        <div>
          {renderPublishButton({
            state: publishState,
            publishing,
            previewLoading,
            onPublish: handlePublish,
          })}
          {/* WHY FieldError (guide: no red/coloured body text for messages) */}
          {publishError && (
            <FieldError as="p" className="text-center mt-2">{publishError}</FieldError>
          )}
        </div>
      </Dialog>
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
      <div className="w-full py-2.5 text-xs rounded-lg border border-edge-dim text-fg-muted text-center">
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
        className="block w-full py-2.5 text-xs font-medium rounded-lg bg-green-400/10 border border-green-400/40 text-fg text-center hover:bg-green-400/20 transition-colors"
      >
        ✓ Published ↗
      </a>
    );
  }

  if (state.kind === 'published-drift') {
    return (
      <>
        <Button
          onClick={onPublish}
          disabled={publishing || previewLoading}
          className="w-full py-2.5"
        >
          {publishing ? 'Publishing update…' : 'Publish update'}
        </Button>
        <p className="text-3xs text-fg-muted text-center mt-1.5">
          Local changes not yet published
        </p>
      </>
    );
  }

  if (state.kind === 'unknown') {
    return (
      <>
        <Button
          onClick={onPublish}
          disabled={publishing || previewLoading}
          className="w-full py-2.5"
          title={`Couldn't verify publish status — proceed at your own risk (${state.reason})`}
        >
          {publishing ? 'Publishing…' : previewLoading ? 'Generating preview…' : '⚠ Publish to Marketplace'}
        </Button>
        <p className="text-3xs text-fg-muted text-center mt-1.5">
          Could not verify status: {state.reason}
        </p>
      </>
    );
  }

  // draft — the default happy path.
  return (
    <Button
      onClick={onPublish}
      disabled={publishing || previewLoading}
      className="w-full py-2.5"
    >
      {publishing ? 'Publishing…' : previewLoading ? 'Generating preview…' : 'Publish to Marketplace'}
    </Button>
  );
}
