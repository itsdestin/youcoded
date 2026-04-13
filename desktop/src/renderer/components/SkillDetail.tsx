import React, { useState, useEffect } from 'react';
import { useSkills } from '../state/skill-context';
import { useScrollFade } from '../hooks/useScrollFade';
import { useMarketplaceStats } from '../state/marketplace-stats-context';
import type { SkillDetailView } from '../../shared/types';
import ConfigForm from './ConfigForm';
import StarRating from './marketplace/StarRating';
import RatingSubmitModal from './marketplace/RatingSubmitModal';
import ReviewList from './marketplace/ReviewList';

interface Props {
  skillId: string;
  onBack: () => void;
}

const typeBadgeStyles: Record<string, string> = {
  prompt: 'bg-[#f0ad4e]/15 text-[#f0ad4e] border border-[#f0ad4e]/25',
  plugin: 'bg-inset/50 text-fg-dim border border-edge/25',
};

export default function SkillDetail({ skillId, onBack }: Props) {
  const { getDetail, install, uninstall, setFavorite, getShareLink, installed, favorites } = useSkills();
  // Task 9 (scope-expanded): pull live install count + rating from /stats for this skill.
  // Replaces the static detail.rating / detail.installs fields which are zeroed out
  // after Task 6 removed static stats.json from the skill provider.
  const { plugins } = useMarketplaceStats();
  const liveStats = plugins[skillId];
  const [detail, setDetail] = useState<SkillDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const bodyRef = useScrollFade<HTMLDivElement>();
  // Task 10: rating modal + review list state
  const [ratingModalOpen, setRatingModalOpen] = useState(false);
  // Bumped on every successful submission to trigger a ReviewList re-fetch
  const [reviewRefreshKey, setReviewRefreshKey] = useState(0);

  const isInstalled = installed.some(s => s.id === skillId);
  const isFavorite = favorites.includes(skillId);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getDetail(skillId)
      .then(d => { setDetail(d); setLoading(false); })
      .catch(err => { setError(err.message || 'Failed to load skill details'); setLoading(false); });
  }, [skillId, getDetail]);

  const handleInstall = async () => {
    setInstalling(true);
    try {
      await install(skillId);
    } catch (err: any) {
      setError(err.message || 'Install failed');
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = async () => {
    setInstalling(true);
    try {
      await uninstall(skillId);
    } catch (err: any) {
      setError(err.message || 'Uninstall failed');
    } finally {
      setInstalling(false);
    }
  };

  const handleFavorite = async () => {
    try {
      await setFavorite(skillId, !isFavorite);
    } catch {}
  };

  const handleShare = async () => {
    try {
      const link = await getShareLink(skillId);
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(link);
      }
    } catch {}
  };

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="overlay-header flex items-center px-4 py-3 border-b border-edge">
          <button onClick={onBack} className="text-fg-muted hover:text-fg mr-3 text-lg">&larr;</button>
          <h2 className="text-sm font-bold text-fg">Skill Details</h2>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-fg-muted text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="flex flex-col h-full">
        <div className="overlay-header flex items-center px-4 py-3 border-b border-edge">
          <button onClick={onBack} className="text-fg-muted hover:text-fg mr-3 text-lg">&larr;</button>
          <h2 className="text-sm font-bold text-fg">Skill Details</h2>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-red-400 text-sm">{error || 'Skill not found'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="overlay-header flex items-center px-4 py-3 border-b border-edge">
        <button onClick={onBack} className="text-fg-muted hover:text-fg mr-3 text-lg">&larr;</button>
        <h2 className="text-sm font-bold text-fg">Skill Details</h2>
      </div>

      <div ref={bodyRef} className="scroll-fade flex-1 px-4 py-4">
        {/* Name and author */}
        <div className="text-center mb-3">
          <h3 className="text-lg font-semibold text-fg">{detail.displayName}</h3>
          {detail.author && (
            <p className="text-xs text-fg-muted mt-0.5">by {detail.author}</p>
          )}
          {/* Task 9: live star rating from /stats API — renders null when no reviews */}
          {/* Task 10: "Rate this plugin" button beside the aggregate rating */}
          <div className="mt-1 flex items-center justify-center gap-2">
            <StarRating
              value={liveStats?.rating ?? detail.rating ?? 0}
              count={liveStats?.review_count ?? detail.ratingCount ?? 0}
              size="lg"
            />
            <button
              onClick={() => setRatingModalOpen(true)}
              aria-label="Rate this plugin"
              className="text-[10px] text-fg-muted hover:text-accent border border-edge-dim hover:border-accent/40 rounded-full px-2 py-0.5 transition-colors"
            >
              Rate
            </button>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 justify-center mb-4">
          {isInstalled ? (
            <button
              onClick={handleUninstall}
              disabled={installing}
              className="px-4 py-1.5 text-sm font-medium rounded-lg border border-edge text-fg-muted hover:text-fg hover:border-edge-dim transition-colors disabled:opacity-50"
            >
              {installing ? 'Removing...' : 'Uninstall'}
            </button>
          ) : (
            <button
              onClick={handleInstall}
              disabled={installing}
              className="px-4 py-1.5 text-sm font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-50"
            >
              {installing ? 'Installing...' : 'Install'}
            </button>
          )}
          <button
            onClick={handleFavorite}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
              isFavorite
                ? 'border-[#f0ad4e]/40 text-[#f0ad4e] bg-[#f0ad4e]/10'
                : 'border-edge text-fg-muted hover:text-fg'
            }`}
          >
            {isFavorite ? '\u2605' : '\u2606'}
          </button>
          <button
            onClick={handleShare}
            className="px-3 py-1.5 text-sm rounded-lg border border-edge text-fg-muted hover:text-fg transition-colors"
          >
            Share
          </button>
        </div>

        {/* Stats row */}
        <div className="flex items-center justify-center gap-3 mb-4 text-xs text-fg-muted">
          <span className={`font-medium px-1.5 py-0.5 rounded-sm ${typeBadgeStyles[detail.type] || typeBadgeStyles.plugin}`}>
            {detail.type === 'prompt' ? 'Prompt' : 'Plugin'}
          </span>
          {/* Task 9: use live install count from /stats API; fall back to static field */}
          {(() => {
            const installs = liveStats?.installs ?? detail.installs;
            if (installs == null) return null;
            return <span>{installs >= 1000 ? `${(installs / 1000).toFixed(1)}k` : installs} installs</span>;
          })()}
          {detail.category && (
            <span className="capitalize">{detail.category}</span>
          )}
        </div>

        {/* Description */}
        <div className="mb-4">
          <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-1">Description</h4>
          <p className="text-sm text-fg leading-relaxed whitespace-pre-wrap">
            {detail.fullDescription || detail.description}
          </p>
        </div>

        {/* Tags */}
        {detail.tags && detail.tags.length > 0 && (
          <div className="mb-4">
            <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-1">Tags</h4>
            <div className="flex flex-wrap gap-1">
              {detail.tags.map(tag => (
                <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-sm bg-inset text-fg-muted border border-edge-dim">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Phase 3c: config form — only rendered when the entry has a
            configSchema AND is currently installed. Anthropic plugins using
            their own native config.json won't have configSchema. */}
        {isInstalled && detail.configSchema && detail.configSchema.fields.length > 0 && (
          <ConfigForm id={detail.id} schema={detail.configSchema} />
        )}

        {/* Metadata */}
        <div className="border-t border-edge-dim pt-3">
          <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">Details</h4>
          <div className="space-y-1.5 text-xs">
            {detail.version && (
              <div className="flex justify-between">
                <span className="text-fg-muted">Version</span>
                <span className="text-fg">{detail.version}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-fg-muted">Source</span>
              <span className="text-fg capitalize">{detail.source}</span>
            </div>
            {detail.updatedAt && (
              <div className="flex justify-between">
                <span className="text-fg-muted">Updated</span>
                <span className="text-fg">{new Date(detail.updatedAt).toLocaleDateString()}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-fg-muted">Visibility</span>
              <span className="text-fg capitalize">{detail.visibility}</span>
            </div>
            {detail.authorGithub && (
              <div className="flex justify-between">
                <span className="text-fg-muted">GitHub</span>
                <span className="text-fg">{detail.authorGithub}</span>
              </div>
            )}
          </div>
        </div>

        {/* Task 10: Reviews section — below metadata */}
        <div className="border-t border-edge-dim pt-3 mt-1">
          <ReviewList pluginId={detail.id} refreshKey={reviewRefreshKey} />
        </div>
      </div>

      {/* Task 10: Rating submit modal — mounted at the SkillDetail root so it's above the scroll container */}
      <RatingSubmitModal
        pluginId={detail.id}
        open={ratingModalOpen}
        onClose={() => setRatingModalOpen(false)}
        onSubmitted={() => {
          // Bump the review list key to trigger a re-fetch showing the new review
          setReviewRefreshKey(k => k + 1);
        }}
      />
    </div>
  );
}
