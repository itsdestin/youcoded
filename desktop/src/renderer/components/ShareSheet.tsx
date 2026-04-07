import React, { useState, useEffect, useMemo } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useSkills } from '../state/skill-context';

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

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

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
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative bg-panel border border-edge-dim rounded-xl p-5 max-w-sm w-full mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
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
              <span className="text-xs text-fg-muted animate-pulse">Generating...</span>
            </div>
          ) : linkError ? (
            <div className="w-40 h-40 rounded-lg bg-well border border-edge-dim flex items-center justify-center p-3">
              <span className="text-xs text-red-400 text-center">{linkError}</span>
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
              <span className="flex-1 text-[11px] text-fg-muted truncate select-all">{shareLink}</span>
              <button
                onClick={handleCopy}
                className="shrink-0 text-[11px] font-medium px-2 py-1 rounded-sm bg-accent text-on-accent hover:brightness-110 transition-colors"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {/* Publish section */}
        <div className="border-t border-edge-dim pt-4">
          {prUrl ? (
            <div className="text-center">
              <p className="text-xs text-[#4CAF50] font-medium mb-1">Published successfully!</p>
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
              <button
                onClick={handlePublish}
                disabled={publishing}
                className="w-full text-xs font-medium py-2.5 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-50"
              >
                {publishing ? 'Publishing...' : 'Publish to Marketplace'}
              </button>
              {publishError && (
                <p className="text-xs text-red-400 text-center mt-2">{publishError}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
