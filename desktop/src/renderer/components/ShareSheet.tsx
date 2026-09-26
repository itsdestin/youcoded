import { useState, useEffect, useMemo } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useSkills } from '../state/skill-context';
import { useEscClose } from '../hooks/use-esc-close';
import { Button, Dialog, LoadingState } from './ui';

interface ShareSheetProps {
  skillId: string;
  onClose: () => void;
}

export default function ShareSheet({ skillId, onClose }: ShareSheetProps) {
  const { installed, getShareLink, publish } = useSkills();

  const skill = useMemo(() => installed.find((s) => s.id === skillId), [installed, skillId]);

  const [shareLink, setShareLink] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(true);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [publishing, setPublishing] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  // Generate share link on mount
  useEffect(() => {
    setLinkLoading(true);
    setLinkError(null);
    getShareLink(skillId)
      .then((link) => {
        setShareLink(link);
        setLinkLoading(false);
      })
      .catch((err) => {
        setLinkError(err?.message || 'Failed to generate link');
        setLinkLoading(false);
      });
  }, [skillId, getShareLink]);

  useEscClose(true, onClose);

  const handleCopy = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for environments without clipboard API
      const textarea = document.createElement('textarea');
      textarea.value = shareLink;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handlePublish = async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      const result = await publish(skillId);
      setPrUrl(result.prUrl);
    } catch (err: any) {
      setPublishError(err?.message || 'Failed to publish');
    } finally {
      setPublishing(false);
    }
  };

  return (
    // Overlay layer L2 — theme-driven via Scrim/OverlayPanel.
    <>
      <Dialog
        open
        onClose={onClose}
        size="prompt"
        aria-label="Share"
        scrollBody={false}
        className="p-5"
        // Marked once the link fetch settles (success OR error) — never mid-spinner.
        screen={linkLoading ? undefined : 'marketplace/share'}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-fg">
            Share{skill ? `: ${skill.displayName}` : ''}
          </h3>
          <button onClick={onClose} className="text-fg-muted hover:text-fg text-lg leading-none">
            &times;
          </button>
        </div>

        {/* QR Code */}
        <div className="flex justify-center mb-4">
          {linkLoading ? (
            <div className="w-40 h-40 rounded-lg bg-well border border-edge-dim flex items-center justify-center">
              <LoadingState what="the share link" variant="inline" />
            </div>
          ) : linkError ? (
            <div className="w-40 h-40 rounded-lg bg-well border border-edge-dim flex items-center justify-center p-3">
              <span className="text-xs text-destructive-fg text-center">{linkError}</span>
            </div>
          ) : shareLink ? (
            <div className="bg-white p-3 rounded-lg">
              <QRCodeSVG value={shareLink} size={140} level="M" />
            </div>
          ) : null}
        </div>

        {/* Deep link with copy */}
        {shareLink && (
          <div className="mb-4">
            <div className="flex items-center gap-2 bg-well border border-edge-dim rounded-lg px-3 py-2">
              <span className="flex-1 text-2xs text-fg-muted truncate select-all">{shareLink}</span>
              <Button size="sm" onClick={handleCopy} className="shrink-0">
                {copied ? 'Copied!' : 'Copy'}
              </Button>
            </div>
          </div>
        )}

        {/* Publish section */}
        <div className="border-t border-edge-dim pt-4">
          {prUrl ? (
            <div className="text-center">
              {/* Neutral, not green. The state family's rule is that errors are
                  neutral cards rather than red boxes (design rule 6) — success
                  gets the same treatment for the same reason. The word
                  "successfully" carries the meaning, and the accent PR link
                  below already draws the eye. Also retires a raw #4CAF50 that
                  no contrast audit could see, and that was weak on Crème. */}
              <p className="text-xs text-fg font-medium mb-1">Published successfully!</p>
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-accent hover:underline break-all"
              >
                {prUrl}
              </a>
            </div>
          ) : (
            <>
              <Button
                onClick={handlePublish}
                disabled={publishing}
                className="w-full py-2.5"
              >
                {publishing ? 'Publishing...' : 'Publish to Marketplace'}
              </Button>
              {publishError && (
                <p className="text-xs text-destructive-fg text-center mt-2">{publishError}</p>
              )}
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}
