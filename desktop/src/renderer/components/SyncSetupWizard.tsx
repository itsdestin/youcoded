/**
 * SyncSetupWizard.tsx — Guided backend setup for non-technical users.
 *
 * Walks through prerequisite detection, tool installation, OAuth sign-in,
 * and configuration for Google Drive, GitHub, or iCloud. Renders as a
 * sub-view inside the SyncPopup modal (same view-swap pattern as SettingsExplainer).
 *
 * No technical jargon — "rclone" is called "cloud sync tool", "gh" is
 * "GitHub tools", etc. The user just clicks buttons and signs in via browser.
 */

import { useState, useEffect, useCallback } from 'react';
import { Button, CloseButton, FieldError, TextInput, Toggle, Radio, RadioGroup, Callout } from './ui';
import { isAndroid as checkIsAndroid } from '../platform';
import { useEscClose } from '../hooks/use-esc-close';
import { useScrollFade } from '../hooks/useScrollFade';
import { plainMessage } from '../utils/ipc-error';

// Detect desktop OS so prereq warnings can show install steps specific to the
// user's machine (iCloud setup on Windows differs from macOS, gh install varies, etc.)
type DesktopOS = 'mac' | 'windows' | 'linux' | 'other';
function detectDesktopOS(): DesktopOS {
  const ua = (navigator.userAgent || '').toLowerCase();
  const platform = (navigator.platform || '').toLowerCase();
  if (platform.includes('mac') || ua.includes('mac os')) return 'mac';
  if (platform.includes('win') || ua.includes('windows')) return 'windows';
  if (platform.includes('linux') || ua.includes('linux')) return 'linux';
  return 'other';
}

// --- Types ---

type BackendType = 'drive' | 'github' | 'icloud';
type WizardStep = 'type' | 'prereqs' | 'auth' | 'configure' | 'done';

interface PrereqStatus {
  rcloneInstalled: boolean;
  gdriveConfigured: boolean;
  gdriveRemoteName: string | null;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  ghUsername: string | null;
  icloudPath: string | null;
}

// --- Constants ---

const BACKEND_LABELS: Record<BackendType, string> = {
  drive: 'Google Drive',
  github: 'GitHub',
  icloud: 'iCloud',
};

const BACKEND_STYLE: Record<BackendType, { icon: string; tint: string }> = {
  drive: { icon: '\u2601', tint: 'bg-blue-500/10 text-blue-400' },
  github: { icon: '\u2302', tint: 'bg-purple-500/10 text-purple-400' },
  icloud: { icon: '\u2B21', tint: 'bg-sky-500/10 text-sky-400' },
};

// --- Reused status icon (same pattern as FirstRunView.tsx) ---

function StatusIcon({ status }: { status: 'checking' | 'ready' | 'missing' | 'installing' | 'error' }) {
  switch (status) {
    case 'ready':
      return <span className="text-green-400">{'\u2713'}</span>;
    case 'checking':
    case 'installing':
      return <span className="text-blue-400 inline-block animate-spin">{'\u25F0'}</span>;
    case 'error':
    case 'missing':
      return <span className="text-red-400">{'\u2717'}</span>;
  }
}

// --- Sub-view header (reused from SyncPanel) ---

function WizardHeader({ title, onBack, onClose }: { title: string; onBack?: () => void; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
      <div className="flex items-center gap-2">
        {onBack && (
          <button onClick={onBack} className="text-fg-muted hover:text-fg-2 w-6 h-6 flex items-center justify-center rounded hover:bg-inset">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}
        <h2 className="text-sm font-bold text-fg">{title}</h2>
      </div>
      <CloseButton onClick={onClose} label="Close setup wizard" />
    </div>
  );
}

// --- Main wizard component ---

/**
 * What became of the new destination's first backup, as the done step reports it.
 *
 * WHY four outcomes (error inventory 2026-09-10, false message 2): the done step used to
 * say "Your first backup is syncing now" whatever happened — after a failed backup, and
 * even with auto-backup off, when nothing was uploaded at all. Each outcome below is a
 * different true sentence, so each is a different value.
 *   finished — the backend confirmed the upload.
 *   failed   — the backend answered that it did not finish; `error` is its own words.
 *   unknown  — no answer came back (e.g. a remote timeout); it may or may not have run.
 *   paused   — auto-backup is off for this destination, so no upload was attempted.
 */
export type FirstBackup =
  | { kind: 'finished' }
  | { kind: 'failed'; error: string }
  | { kind: 'unknown' }
  | { kind: 'paused' };

interface SyncSetupWizardProps {
  /** Pre-selected backend type from the type picker (skips step 1) */
  initialType?: BackendType;
  /** Existing backend instances — used for "N already connected" hint and duplicate-destination warning */
  existingBackends: Array<{ type: BackendType; config: Record<string, string> }>;
  /**
   * Called when setup completes — passes the assembled backend instance.
   * REJECT when the destination could not be saved: rejection is the only thing that
   * keeps the wizard open on its error box. Resolve with the first backup's outcome.
   */
  onComplete: (instance: {
    type: BackendType;
    label: string;
    syncEnabled: boolean;
    config: Record<string, string>;
  }) => Promise<FirstBackup>;
  onClose: () => void;
  /**
   * When set, skip the provider picker and land directly on the reconnect
   * step for this backend. Used when invoked from a push-failure warning's
   * "Fix it" button so the user doesn't have to re-pick Google Drive.
   */
  preselectedBackendId?: string;
  /** Must be set when preselectedBackendId is set; determines which auth flow to jump to. */
  preselectedBackendType?: 'drive' | 'github' | 'icloud';
}

// Normalize a GitHub repo URL for duplicate comparison (strip trailing slash and .git)
function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
}

export default function SyncSetupWizard({ initialType, existingBackends, onComplete, onClose, preselectedBackendId, preselectedBackendType }: SyncSetupWizardProps) {
  // Always mounted when open (parent conditionally renders this component) — so open=true is correct here.
  useEscClose(true, onClose);
  // If a specific backend needs reconnecting, jump straight to auth for that type.
  // iCloud has no auth step (no OAuth flow), so land at 'prereqs' for it instead.
  // Falls back to the initialType behavior (skip type-picker → prereqs) if set,
  // or the default 'type' picker if neither preselect nor initialType is provided.
  const [step, setStep] = useState<WizardStep>(() => {
    if (preselectedBackendId && preselectedBackendType) {
      return preselectedBackendType === 'icloud' ? 'prereqs' : 'auth';
    }
    return initialType ? 'prereqs' : 'type';
  });
  const [backendType, setBackendType] = useState<BackendType | null>(
    preselectedBackendType ?? initialType ?? null
  );
  // WHY: `prereqs` state removed — the PrereqCheckStep's onAllReady callback
  // destructures the fields it needs (remoteName, ghUsername, icloudPath)
  // directly; the outer prereqs object was stored but never read. Found in
  // the 2026-08-06 unused-code sweep.
  const [error, setError] = useState<string | null>(null);
  // Set just before the done step renders; null until then.
  const [firstBackup, setFirstBackup] = useState<FirstBackup | null>(null);

  // Config fields — pre-populate label when jumping straight to auth/reconnect
  // so the Configure step has a sensible default even though selectType() was skipped.
  const [label, setLabel] = useState(
    preselectedBackendType ? `My ${BACKEND_LABELS[preselectedBackendType]}` : ''
  );
  const [driveFolder, setDriveFolder] = useState('Claude');
  const [remoteName, setRemoteName] = useState<string | null>(null);
  const [ghUsername, setGhUsername] = useState<string | null>(null);
  const [repoMode, setRepoMode] = useState<'create' | 'existing'>('create');
  const [repoName, setRepoName] = useState('claude-sync');
  const [repoUrl, setRepoUrl] = useState('');
  const [icloudPath, setIcloudPath] = useState<string | null>(null);
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  // Separate refs per step — only one scroll region mounts at a time,
  // and useScrollFade's observer needs to bind to that mounted element.
  // PrereqCheckStep is a separate component and owns its own scroll ref.
  const typeStepRef = useScrollFade<HTMLDivElement>();
  const configureStepRef = useScrollFade<HTMLDivElement>();

  const claude = (window as any).claude;

  // When backend type is selected, start prereq check
  const selectType = useCallback((type: BackendType) => {
    setBackendType(type);
    setLabel(`My ${BACKEND_LABELS[type]}`);
    setStep('prereqs');
  }, []);

  // --- Step: Type Picker ---
  if (step === 'type') {
    const types: { type: BackendType; desc: string }[] = [
      { type: 'drive', desc: 'Stores your data in a Google Drive folder. Works on any device.' },
      { type: 'github', desc: 'Stores your data in a private GitHub repository. Includes full version history.' },
      // iCloud only where an iCloud Drive client exists: macOS, and
      // iCloud-for-Windows on Windows. Linux has no iCloud client at all and
      // Android has no iCloud Drive support — offering it there gave users a
      // dead option that silently failed prereq detection.
      ...(!checkIsAndroid() && detectDesktopOS() !== 'linux'
        ? [{ type: 'icloud' as BackendType, desc: 'Stores your data in iCloud Drive. Best for Mac and iPhone users.' }]
        : []),
    ];

    return (
      <div className="flex flex-col h-full">
        <WizardHeader title="Add a Backup Destination" onClose={onClose} />
        <div ref={typeStepRef} className="scroll-fade flex-1">
          <div className="px-4 py-4 space-y-3">
          {types.map(({ type, desc }) => {
            const existing = existingBackends.filter(b => b.type === type).length;
            // Only Drive supports multiple accounts — rclone gives each its own remote.
            // GitHub shares a single global `gh auth` identity, and iCloud uses a single
            // auto-detected path, so both are limited to one backend each.
            const supportsMultiple = type === 'drive';
            const disabled = existing > 0 && !supportsMultiple;
            return (
              <button
                key={type}
                onClick={() => !disabled && selectType(type)}
                disabled={disabled}
                className={`w-full rounded-lg border border-edge-dim p-4 flex items-center gap-3 text-left transition-colors ${
                  disabled
                    ? 'bg-inset/10 opacity-50 cursor-not-allowed'
                    : 'bg-inset/30 hover:bg-inset/50 cursor-pointer'
                }`}
              >
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg shrink-0 ${BACKEND_STYLE[type].tint}`}>
                  {BACKEND_STYLE[type].icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-fg font-medium">{BACKEND_LABELS[type]}</div>
                  <div className="text-3xs text-fg-muted mt-0.5">{desc}</div>
                  {existing > 0 && (
                    <div className="text-4xs text-fg-muted mt-1">
                      {disabled
                        ? `Already connected — ${BACKEND_LABELS[type]} only supports one backup`
                        : `(${existing} already connected)`}
                    </div>
                  )}
                </div>
                {!disabled && (
                  <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                )}
              </button>
            );
          })}
          </div>
        </div>
      </div>
    );
  }

  // --- Step: Prerequisite Check ---
  if (step === 'prereqs' && backendType) {
    return (
      <PrereqCheckStep
        backendType={backendType}
        onAllReady={(prereqStatus) => {
          setRemoteName(prereqStatus.gdriveRemoteName);
          setGhUsername(prereqStatus.ghUsername);
          setIcloudPath(prereqStatus.icloudPath);
          // For Drive, if there's already a Drive backend connected we force the
          // auth step to run again — that triggers authGdrive() which auto-picks
          // a fresh remote name (gdrive2, gdrive3, ...) and opens the browser so
          // the user can sign into a DIFFERENT Google account (e.g., work vs school).
          const hasExistingDrive = existingBackends.some(b => b.type === 'drive');
          if (backendType === 'drive' && (!prereqStatus.gdriveConfigured || hasExistingDrive)) {
            setStep('auth');
          } else if (backendType === 'github' && !prereqStatus.ghAuthenticated) {
            setStep('auth');
          } else {
            // Everything ready — skip auth, go to configure
            setStep('configure');
          }
        }}
        onBack={() => setStep('type')}
        onClose={onClose}
      />
    );
  }

  // --- Step: OAuth / Sign-In ---
  if (step === 'auth' && backendType) {
    // Reconnect mode: preselectedBackendId is set when the user arrived via
    // a push-failure warning's "Fix it" button. Copy must steer them to
    // sign in with the SAME Google account — not a different one, and not
    // the "add another account" flow.
    const isReconnect = !!preselectedBackendId;
    const isAdditionalDrive = !isReconnect
      && backendType === 'drive'
      && existingBackends.some(b => b.type === 'drive');
    return (
      <AuthStep
        backendType={backendType}
        isAdditionalDrive={isAdditionalDrive}
        isReconnect={isReconnect}
        onSuccess={(authResult) => {
          if (backendType === 'drive') {
            setRemoteName(authResult.remoteName || 'gdrive');
          }
          if (backendType === 'github') {
            setGhUsername(authResult.username || null);
          }
          setStep('configure');
        }}
        onBack={() => setStep('prereqs')}
        onClose={onClose}
      />
    );
  }

  // --- Step: Configure ---
  if (step === 'configure' && backendType) {
    const handleStartBackup = async () => {
      setSaving(true);
      setError(null);

      try {
        let finalRepoUrl = repoUrl;

        // If GitHub + create mode, create the repo first
        if (backendType === 'github' && repoMode === 'create') {
          const result = await claude.sync.setup.createRepo(repoName);
          if (!result.success) {
            setError(result.error || 'Failed to create repository');
            setSaving(false);
            return;
          }
          finalRepoUrl = result.repoUrl;
        }

        // Assemble the backend config
        const config: Record<string, string> = {};
        if (backendType === 'drive') {
          config.DRIVE_ROOT = driveFolder;
          config.rcloneRemote = remoteName || 'gdrive';
        } else if (backendType === 'github') {
          config.PERSONAL_SYNC_REPO = finalRepoUrl || repoUrl;
        } else if (backendType === 'icloud') {
          config.ICLOUD_PATH = icloudPath || '';
        }

        const first = await onComplete({ type: backendType, label, syncEnabled, config });

        // Restore-from-backup was removed in Plan 2c (2026-07-14) — the dated
        // Drive/iCloud snapshot reshape orphaned the flat-path readers, so
        // there is no "we found existing data → restore vs start fresh" gate
        // anymore. New backends always start fresh; a redesigned restore will
        // land later around the local-models/accounts/platform work.
        setFirstBackup(first);
        setStep('done');
      } catch (e: unknown) {
        // WHY plainMessage: a rejected save arrives as "Error invoking remote method
        // 'sync:add-backend': Error: <reason>" — forty characters of machinery in front
        // of the one part a person can act on.
        setError(plainMessage(e));
      }
      setSaving(false);
    };

    return (
      <div className="flex flex-col h-full">
        <WizardHeader
          title={`Set Up ${BACKEND_LABELS[backendType]}`}
          onBack={() => setStep(backendType === 'icloud' ? 'prereqs' : 'auth')}
          onClose={onClose}
        />
        <div ref={configureStepRef} className="scroll-fade flex-1">
          <div className="px-4 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-3xs text-fg-muted mb-1">Give this backup a name</label>
            {/* Migrated to the shared TextInput (spec change 20): the hand-rolled
                bg-inset/rounded-md/focus recipe is now the one FIELD surface, so
                every text box in the app focuses and rounds the same way. The
                visible label above isn't wired to this input with htmlFor, so
                aria-label gives screen readers the same name sighted users see. */}
            <TextInput
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={`My ${BACKEND_LABELS[backendType]}`}
              aria-label="Give this backup a name"
              className="w-full"
              autoFocus
            />
            <div className="text-3xs text-fg-muted mt-0.5">This is just for you — to tell your backups apart.</div>
          </div>

          {/* Drive: folder name */}
          {backendType === 'drive' && (
            <div>
              <label className="block text-3xs text-fg-muted mb-1">Folder in Google Drive</label>
              {/* Shared FIELD surface (spec change 20). aria-label mirrors the
                  visible label, which isn't linked via htmlFor. */}
              <TextInput
                value={driveFolder}
                onChange={(e) => setDriveFolder(e.target.value)}
                placeholder="Claude"
                aria-label="Folder in Google Drive"
                className="w-full"
              />
              <div className="text-3xs text-fg-muted mt-0.5">
                We'll create a folder called "{driveFolder || 'Claude'}" in your Drive if it doesn't exist.
              </div>
            </div>
          )}

          {/* GitHub: create or existing. Change 39: native radios → the Radio
              primitive in a RadioGroup. Each option's body holds its own
              TextInput, so selecting is a row click and the group only
              arrow-navigates when a Radio is focused (guarded in RadioGroup). */}
          {backendType === 'github' && (
            <RadioGroup
              options={['create', 'existing']}
              value={repoMode}
              onChange={(m) => setRepoMode(m as 'create' | 'existing')}
              aria-label="Repository mode"
              className="space-y-3"
            >
              {/* Create new repo option */}
              <div className="flex items-start gap-2 cursor-pointer" onClick={() => setRepoMode('create')}>
                <Radio
                  checked={repoMode === 'create'}
                  onChange={() => setRepoMode('create')}
                  tabIndex={repoMode === 'create' ? 0 : -1}
                  aria-label="Create a new private repository"
                  className="mt-0.5"
                />
                <div>
                  <div className="text-xs text-fg font-medium">Create a new private repository</div>
                  {repoMode === 'create' && (
                    <div className="mt-1.5">
                      {/* Shared FIELD surface (spec change 20). This input sits inside
                          the radio's <label>, so without an explicit aria-label a screen
                          reader would announce the radio's whole sentence as its name. */}
                      <TextInput
                        value={repoName}
                        onChange={(e) => setRepoName(e.target.value)}
                        placeholder="claude-sync"
                        aria-label="New repository name"
                        className="w-full"
                      />
                      {ghUsername && (
                        <div className="text-3xs text-fg-muted mt-0.5">
                          This will be created as {ghUsername}/{repoName || 'claude-sync'}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Use existing repo option */}
              <div className="flex items-start gap-2 cursor-pointer" onClick={() => setRepoMode('existing')}>
                <Radio
                  checked={repoMode === 'existing'}
                  onChange={() => setRepoMode('existing')}
                  tabIndex={repoMode === 'existing' ? 0 : -1}
                  aria-label="Use an existing repository"
                  className="mt-0.5"
                />
                <div>
                  <div className="text-xs text-fg font-medium">Use an existing repository</div>
                  {repoMode === 'existing' && (
                    <div className="mt-1.5">
                      {/* Shared FIELD surface (spec change 20). Same nested-label
                          reason as above for the explicit aria-label. */}
                      <TextInput
                        value={repoUrl}
                        onChange={(e) => setRepoUrl(e.target.value)}
                        placeholder="https://github.com/you/repo"
                        aria-label="Existing repository URL"
                        className="w-full"
                      />
                      <div className="text-3xs text-fg-muted mt-0.5">Paste the full URL of your private repository.</div>
                    </div>
                  )}
                </div>
              </div>
            </RadioGroup>
          )}

          {/* iCloud: show detected path */}
          {backendType === 'icloud' && icloudPath && (
            <div className="px-3 py-2.5 rounded-lg bg-inset/50 text-2xs text-fg-dim">
              Your data will be stored in iCloud Drive at:<br />
              <span className="text-fg font-mono text-3xs">{icloudPath}</span>
            </div>
          )}

          {/* Auto-sync toggle */}
          <div className="pt-1">
            <label className="flex items-center gap-2 cursor-pointer">
              {/* Migrated to the shared Toggle (spec changes 15/16). Was a hand-rolled
                  32x16 switch with a hardcoded green-600 on-state and no aria at all;
                  the primitive is the one 36x20 geometry, paints the on-state in the
                  user's theme accent, and carries role="switch" + aria-checked. The
                  aria-label repeats the sentence beside it — the wrapping <label>
                  can't name a <button>, so without it the switch is unnamed. */}
              <Toggle
                checked={syncEnabled}
                onChange={setSyncEnabled}
                aria-label="Back up automatically after changes"
              />
              <span className="text-xs text-fg">Back up automatically after changes</span>
            </label>
            <div className="text-3xs text-fg-muted mt-0.5 ml-10">
              Turn off to only sync when you choose to.
            </div>
          </div>

          {/* Error message */}
          {error && (
            <Callout tone="danger">{error}</Callout>
          )}

          {/* Duplicate destination heads-up — informational only.
              The sync engine uses a global lock and backend-safe write strategies
              (rclone --update for Drive, atomic fs.cpSync for iCloud, per-instance
              clone dirs for GitHub), so two backends pointing to the same location
              don't actually corrupt data. We still show a neutral note so users
              who add one by accident notice, but we don't color it as a warning. */}
          {(() => {
            const dupes = existingBackends.filter(b => b.type === backendType);
            let isDup = false;
            if (backendType === 'drive') {
              // Two Drive backends are only truly duplicates when BOTH the rclone
              // remote (→ Google account) AND the folder match. Different remotes
              // mean different accounts (e.g., work vs school) even with same folder.
              const thisRemote = (remoteName || 'gdrive').toLowerCase();
              isDup = dupes.some(b =>
                (b.config.rcloneRemote || '').toLowerCase() === thisRemote &&
                (b.config.DRIVE_ROOT || '').toLowerCase() === driveFolder.trim().toLowerCase()
              );
            } else if (backendType === 'github') {
              const target = repoMode === 'existing' ? repoUrl : (ghUsername ? `https://github.com/${ghUsername}/${repoName}` : '');
              if (target.trim()) {
                const norm = normalizeRepoUrl(target);
                isDup = dupes.some(b => normalizeRepoUrl(b.config.PERSONAL_SYNC_REPO || '') === norm);
              }
            } else if (backendType === 'icloud' && icloudPath) {
              isDup = dupes.some(b => (b.config.ICLOUD_PATH || '') === icloudPath);
            }
            return isDup ? (
              <div className="px-3 py-2 rounded-lg bg-inset/50 text-2xs text-fg-dim">
                Heads up: you already have a backup pointing to this exact destination (same account and folder). Adding another is safe, but it'll just duplicate what the existing one does. If you meant a different account, cancel and sign into that account first.
              </div>
            ) : null;
          })()}

          {/* Start Backup button */}
          {/* Was a hardcoded bg-blue-600 family (spec change 55 — the last survivors of a
              blue that ignored the user's theme). `primary` paints it in the theme accent.
              The three-way saving/empty/ready className is gone: both the saving and the
              empty-label states are just `disabled` now (spec decision 72), and the spinner
              goes with the shared busy state later rather than being re-hardcoded here. */}
          <Button
            size="lg"
            onClick={handleStartBackup}
            disabled={!label.trim() || saving || (backendType === 'github' && repoMode === 'existing' && !repoUrl.trim())}
            className="w-full"
          >
            {/* Spinner uses currentColor so it tracks the variant's label color on
                every theme — the old one hardcoded blue-300, which change 55 kills.
                It stays because setting up a backup takes several seconds: a
                disabled button with changed text and no motion reads as hung. */}
            {saving && (
              <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
            )}
            {saving ? 'Setting up...' : 'Start Backup'}
          </Button>
          </div>
        </div>
      </div>
    );
  }

  // --- Step: Done ---
  if (step === 'done') {
    return (
      <div className="flex flex-col h-full">
        <WizardHeader title="Setup Complete" onClose={onClose} />
        <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 text-center">
          {/* Animated checkmark */}
          <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mb-4">
            <span className="text-green-400 text-3xl">{'\u2713'}</span>
          </div>
          <div className="text-fg font-medium text-sm mb-2">Backup added</div>
          {/* WHY one sentence per outcome (error inventory 2026-09-10, false message 2):
              this said "Your first backup is syncing now. Backups happen automatically
              every 15 minutes." for every outcome. By the time this step renders, the first
              backup has already finished or failed (onComplete awaits it), auto-backup may
              be off so nothing ran, and the 15-minute timer was deleted — the service now
              checks hourly while the app is open (sync-service.ts SNAPSHOT_POLL_INTERVAL_MS).
              The check mark stays for every outcome: the destination WAS added. */}
          {firstBackup?.kind === 'finished' && (
            <div className="text-fg-muted text-2xs mb-6 max-w-xs">
              Your first backup finished. YouCoded keeps backing up automatically while it's open.
              You can manage this anytime from the Sync panel.
            </div>
          )}
          {firstBackup?.kind === 'paused' && (
            <div className="text-fg-muted text-2xs mb-6 max-w-xs">
              Automatic backup is off for this destination, so nothing has been uploaded yet.
              Use Upload now in its menu in the Sync panel whenever you want a copy.
            </div>
          )}
          {firstBackup?.kind === 'failed' && (
            <Callout
              tone="warning"
              title={
                /* An empty reason means the upload never ran — another backup held the lock —
                   so "didn't finish" would claim it started (code review 2026-09-11, F7). */
                firstBackup.error ? "Your first backup didn't finish." : "Your first backup hasn't run yet."
              }
              className="mb-6 max-w-xs text-left"
            >
              {firstBackup.error && <div className="mb-1">{firstBackup.error}</div>}
              YouCoded will try again automatically, or you can use Upload now in the Sync panel.
            </Callout>
          )}
          {/* null cannot normally reach here (it is set just before this step); if it
              does, "could not confirm" is the only sentence that is certainly true. */}
          {(firstBackup === null || firstBackup.kind === 'unknown') && (
            <Callout tone="warning" className="mb-6 max-w-xs text-left">
              YouCoded couldn't confirm your first backup finished. The Sync panel shows where it stands.
            </Callout>
          )}
          <Button onClick={onClose} className="px-6 py-2">
            Done
          </Button>
        </div>
      </div>
    );
  }

  // Fallback
  return null;
}

// --- Prerequisite Check Step ---

function PrereqCheckStep({
  backendType,
  onAllReady,
  onBack,
  onClose,
}: {
  backendType: BackendType;
  onAllReady: (prereqs: PrereqStatus) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [prereqs, setPrereqs] = useState<PrereqStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const claude = (window as any).claude;
  const bodyRef = useScrollFade<HTMLDivElement>();

  // Run prereq check on mount
  const runCheck = useCallback(async () => {
    setChecking(true);
    setInstallError(null);
    try {
      const result = await claude.sync.setup.checkPrereqs(backendType);
      setPrereqs(result);

      // If all prereqs met, auto-advance
      if (backendType === 'drive' && result.rcloneInstalled) {
        onAllReady(result);
      } else if (backendType === 'github' && result.ghInstalled) {
        onAllReady(result);
      } else if (backendType === 'icloud') {
        if (result.icloudPath) {
          onAllReady(result);
        }
        // If iCloud not found, stay on this step to show the message
      }
    } catch {}
    setChecking(false);
  }, [backendType, claude, onAllReady]);

  useEffect(() => { runCheck(); }, [runCheck]);

  // Install handler
  const handleInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await claude.sync.setup.installRclone();
      if (result.success) {
        // Re-check prereqs after install
        await runCheck();
      } else {
        setInstallError(result.error || 'Installation failed');
      }
    } catch (e: any) {
      setInstallError(e.message || 'Installation failed');
    }
    setInstalling(false);
  };

  // Derive what to show
  const needsRclone = backendType === 'drive' && prereqs && !prereqs.rcloneInstalled;
  const needsGh = backendType === 'github' && prereqs && !prereqs.ghInstalled;
  const icloudMissing = backendType === 'icloud' && prereqs && !prereqs.icloudPath;

  return (
    <div className="flex flex-col h-full">
      <WizardHeader title="Checking Setup" onBack={onBack} onClose={onClose} />
      <div ref={bodyRef} className="scroll-fade flex-1">
        <div className="px-4 py-4 space-y-4">

        {/* Checklist */}
        {backendType === 'drive' && (
          <div className="space-y-3">
            <PrereqRow label="Cloud sync tool" status={checking ? 'checking' : prereqs?.rcloneInstalled ? 'ready' : 'missing'} />
            <PrereqRow label="Google account connected" status={checking ? 'checking' : prereqs?.gdriveConfigured ? 'ready' : 'missing'} />
          </div>
        )}
        {backendType === 'github' && (
          <div className="space-y-3">
            <PrereqRow label="GitHub tools" status={checking ? 'checking' : prereqs?.ghInstalled ? 'ready' : 'missing'} />
            <PrereqRow label="Signed in to GitHub" status={checking ? 'checking' : prereqs?.ghAuthenticated ? 'ready' : 'missing'} />
          </div>
        )}
        {backendType === 'icloud' && (
          <div className="space-y-3">
            <PrereqRow label="iCloud Drive found" status={checking ? 'checking' : prereqs?.icloudPath ? 'ready' : 'missing'} />
          </div>
        )}

        {/* Action: install rclone */}
        {needsRclone && !checking && (
          <div className="pt-2 space-y-2">
            <div className="text-2xs text-fg-dim">
              YouCoded needs a small helper tool to connect to Google Drive.
            </div>
            {/* Another hardcoded blue survivor (spec change 55) — now the theme accent.
                The faded busy FILL collapses to plain `disabled` (spec decision 72),
                but the spinner stays: this install advertises "about a minute" right
                below it, and a minute of a motionless disabled button reads as hung.
                currentColor so it tracks the label on every theme. */}
            <Button size="lg" onClick={handleInstall} disabled={installing}>
              {installing && (
                <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
              )}
              {installing ? 'Installing...' : 'Install Now'}
            </Button>
            <div className="text-3xs text-fg-muted">This usually takes about a minute.</div>
          </div>
        )}

        {/* Action: install gh (similar pattern) */}
        {needsGh && !checking && (
          <GhInstallHelp onRecheck={runCheck} />
        )}

        {/* iCloud not found — platform-specific guidance since setup differs per OS */}
        {icloudMissing && !checking && (
          <IcloudMissingHelp onRecheck={runCheck} />
        )}

        {/* Install error */}
        {installError && (
          // The "Install manually" link stays INSIDE the callout, which does not
          // make this a K5 status strip: K5 is for a laid-out action that
          // resolves the state, and this is an inline link inside the sentence
          // that explains it. A dot-message-button row would read worse here.
          <Callout tone="danger">
            {installError}
            <div className="mt-1">
              <button className="text-accent underline" onClick={() => claude.openExternal('https://rclone.org/install/')}>
                Install manually
              </button>
            </div>
          </Callout>
        )}
        </div>
      </div>
    </div>
  );
}

// --- Platform-specific prereq help blocks ---
// Split out so each OS gets the right install path (Windows users often don't
// realize iCloud needs a separate app, Linux doesn't support it at all, etc.)

function IcloudMissingHelp({ onRecheck }: { onRecheck: () => void }) {
  const claude = (window as any).claude;
  const os: DesktopOS = checkIsAndroid() ? 'other' : detectDesktopOS();
  return (
    <div className="pt-2 space-y-2">
      <div className="text-2xs text-fg-dim">
        iCloud Drive wasn't found on this computer.
      </div>
      {os === 'mac' && (
        <div className="text-3xs text-fg-muted space-y-1">
          <div>On macOS, enable it in <span className="text-fg-dim">System Settings &gt; Apple ID &gt; iCloud &gt; iCloud Drive</span>.</div>
          <div>Make sure iCloud Drive is turned on and has finished its first sync, then check again.</div>
        </div>
      )}
      {os === 'windows' && (
        <div className="text-3xs text-fg-muted space-y-1">
          <div>On Windows, iCloud isn't built in — you need to install <span className="text-fg-dim">iCloud for Windows</span> from the Microsoft Store or Apple's website.</div>
          <div className="flex flex-wrap gap-2 pt-1">
            <button className="text-accent underline" onClick={() => claude.openExternal('https://apps.microsoft.com/detail/9PKTQ5699M62')}>
              Microsoft Store
            </button>
            <span className="text-fg-muted">or</span>
            <button className="text-accent underline" onClick={() => claude.openExternal('https://www.apple.com/icloud/setup/pc.html')}>
              apple.com/icloud
            </button>
          </div>
          <div>After installing, sign in with your Apple ID and enable iCloud Drive. Then come back and tap "Check Again".</div>
        </div>
      )}
      {os === 'linux' && (
        <div className="text-3xs text-fg-muted space-y-1">
          <div>iCloud Drive isn't officially supported on Linux — Apple doesn't provide a client.</div>
          <div>Use <span className="text-fg-dim">Google Drive</span> or <span className="text-fg-dim">GitHub</span> for backup on this computer instead.</div>
        </div>
      )}
      {os === 'other' && (
        <div className="text-3xs text-fg-muted">
          Couldn't detect your operating system. iCloud Drive works best on macOS and Windows. If you're on Linux, try Google Drive or GitHub instead.
        </div>
      )}
      {os !== 'linux' && (
        /* Filled-grey (bg-inset) becomes the outline `secondary` — spec decision 60. */
        <Button variant="secondary" onClick={onRecheck}>
          Check Again
        </Button>
      )}
    </div>
  );
}

function GhInstallHelp({ onRecheck }: { onRecheck: () => void }) {
  const claude = (window as any).claude;
  const os: DesktopOS = checkIsAndroid() ? 'other' : detectDesktopOS();
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  // The app installs gh itself (user-local, no sudo/Homebrew) — the manual
  // per-OS instructions below are the FALLBACK, shown only once an automated
  // attempt has actually failed. Leading with a terminal command is what this
  // whole flow exists to avoid: a stock macOS has no gh and no brew, so the
  // old instructions-first version dead-ended non-developers (2026-07-20).
  const handleInstallGh = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      // Reuses the Connect-GitHub modal's install path (`github:install-gh`)
      // rather than a sync-specific one — same binary, same installer, and it
      // already rides all four IPC parity surfaces.
      const result = await claude.github.installGh();
      if (result.ok) {
        await onRecheck();
      } else if (result.restartRequired) {
        // Windows: gh is on disk but this process's PATH predates it. Restart
        // is the deterministic fix (same contract as installClaude).
        setInstallError(
          result.error ||
            "GitHub CLI was installed, but this app can't see it yet. Quit and reopen YouCoded, then tap Check Again.",
        );
      } else {
        setInstallError(result.error || 'Installation failed');
      }
    } catch (e: any) {
      setInstallError(e?.message || 'Installation failed');
    }
    setInstalling(false);
  };

  // Android has no desktop prerequisite installer to call — keep it on the
  // manual path rather than offering a button that cannot work.
  const canAutoInstall = !checkIsAndroid();

  return (
    <div className="pt-2 space-y-2">
      <div className="text-2xs text-fg-dim">
        YouCoded needs GitHub's command-line tool (gh) to connect your account.
      </div>

      {canAutoInstall && !installError && (
        <div className="space-y-2">
          {/* Spinner matches the rclone install button: this advertises "about a
              minute" right below it, and a motionless disabled button reads as hung. */}
          <Button size="lg" onClick={handleInstallGh} disabled={installing}>
            {installing && (
              <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
            )}
            {installing ? 'Installing...' : 'Install Now'}
          </Button>
          <div className="text-3xs text-fg-muted">This usually takes about a minute.</div>
        </div>
      )}

      {installError && (
        <FieldError as="div">
          Couldn't install it automatically: {installError}
        </FieldError>
      )}

      {/* Manual instructions: only after an automated attempt failed (or on a
          platform where we can't run one). */}
      {(installError || !canAutoInstall) && os === 'mac' && (
        <div className="text-3xs text-fg-muted space-y-1">
          <div>On macOS, the easiest way is Homebrew. In Terminal, run:</div>
          <div className="font-mono text-fg-dim bg-inset/50 px-2 py-1 rounded">brew install gh</div>
          <div>No Homebrew? Download the installer from <button className="text-accent underline" onClick={() => claude.openExternal('https://cli.github.com')}>cli.github.com</button>.</div>
        </div>
      )}
      {(installError || !canAutoInstall) && os === 'windows' && (
        <div className="text-3xs text-fg-muted space-y-1">
          <div>On Windows, download the installer from <button className="text-accent underline" onClick={() => claude.openExternal('https://cli.github.com')}>cli.github.com</button>.</div>
          <div>Or, if you use winget, open PowerShell and run:</div>
          <div className="font-mono text-fg-dim bg-inset/50 px-2 py-1 rounded">winget install GitHub.cli</div>
        </div>
      )}
      {(installError || !canAutoInstall) && os === 'linux' && (
        <div className="text-3xs text-fg-muted space-y-1">
          <div>On Linux, install with your package manager:</div>
          <div className="font-mono text-fg-dim bg-inset/50 px-2 py-1 rounded">sudo apt install gh  # Debian/Ubuntu</div>
          <div className="font-mono text-fg-dim bg-inset/50 px-2 py-1 rounded">sudo dnf install gh  # Fedora</div>
          <div>Full instructions: <button className="text-accent underline" onClick={() => claude.openExternal('https://github.com/cli/cli/blob/trunk/docs/install_linux.md')}>install guide</button>.</div>
        </div>
      )}
      {(installError || !canAutoInstall) && os === 'other' && (
        <div className="text-3xs text-fg-muted">
          Install from <button className="text-accent underline" onClick={() => claude.openExternal('https://cli.github.com')}>cli.github.com</button>, then come back and tap "Check Again".
        </div>
      )}
      {(installError || !canAutoInstall) && (
        <div className="text-3xs text-fg-muted">After installing, come back and tap "Check Again".</div>
      )}
      {/* Filled-grey (bg-inset) becomes the outline `secondary` — spec decision 60. */}
      <Button variant="secondary" onClick={onRecheck}>
        Check Again
      </Button>
    </div>
  );
}

// --- Prereq checklist row ---

function PrereqRow({ label, status }: { label: string; status: 'checking' | 'ready' | 'missing' }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-inset/30">
      <StatusIcon status={status} />
      <span className="text-xs text-fg">{label}</span>
      <span className="text-3xs text-fg-muted ml-auto">
        {status === 'checking' ? 'checking...' : status === 'ready' ? 'ready' : 'needed'}
      </span>
    </div>
  );
}

// --- Auth Step ---

function AuthStep({
  backendType,
  isAdditionalDrive = false,
  isReconnect = false,
  onSuccess,
  onBack,
  onClose,
}: {
  backendType: BackendType;
  isAdditionalDrive?: boolean;
  // True when the user arrived via a push-failure warning's "Fix it" button.
  // In that case we want them to sign in with the SAME account they used
  // before (we don't yet store the email — that's a follow-up) rather than
  // seeing the "connect another account" copy intended for a second Drive.
  isReconnect?: boolean;
  onSuccess: (result: { remoteName?: string; username?: string }) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claude = (window as any).claude;

  const handleAuth = async () => {
    setWaiting(true);
    setError(null);

    try {
      if (backendType === 'drive') {
        const result = await claude.sync.setup.authGdrive();
        if (result.success) {
          onSuccess({ remoteName: result.remoteName });
        } else {
          setError(result.error || 'Sign-in failed');
        }
      } else if (backendType === 'github') {
        const result = await claude.sync.setup.authGithub();
        if (result.success) {
          onSuccess({ username: result.username });
        } else {
          setError(result.error || 'Sign-in failed');
        }
      }
    } catch (e: any) {
      setError(e.message || 'Something went wrong');
    }
    setWaiting(false);
  };

  const title = backendType === 'drive'
    ? (isReconnect ? 'Reconnect Google Drive'
       : isAdditionalDrive ? 'Connect another Google account'
       : 'Connect your Google account')
    : (isReconnect ? 'Reconnect to GitHub' : 'Sign in to GitHub');
  const buttonLabel = backendType === 'drive'
    ? (isReconnect ? 'Reconnect to Google' : 'Connect to Google')
    : (isReconnect ? 'Reconnect to GitHub' : 'Sign in to GitHub');

  return (
    <div className="flex flex-col h-full">
      <WizardHeader title={title} onBack={onBack} onClose={onClose} />
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-8 text-center">
        {/* Icon */}
        <div className={`w-16 h-16 rounded-full flex items-center justify-center text-2xl mb-4 ${BACKEND_STYLE[backendType].tint}`}>
          {BACKEND_STYLE[backendType].icon}
        </div>

        {!waiting ? (
          <>
            <div className="text-fg-dim text-2xs mb-6 max-w-xs space-y-2">
              <div>A browser window will open for you to sign in. After you sign in, come back here — it'll update automatically.</div>
              {isReconnect && backendType === 'drive' && (
                <div className="text-amber-400 text-3xs pt-1">
                  Important: sign in with the <strong>same Google account</strong> you originally connected. Picking a different account would start a new backup instead of restoring the existing one.
                </div>
              )}
              {isAdditionalDrive && (
                <div className="text-amber-400 text-3xs pt-1">
                  Tip: make sure you pick the <strong>other</strong> Google account (e.g., work vs. personal vs. school) in the browser — not the same one you already connected. You may need to sign out of Google in your browser first, or use an incognito window.
                </div>
              )}
            </div>
            {/* Last of the hardcoded bg-blue-600 buttons (spec change 55) — the sign-in
                CTA now uses the theme accent like every other primary action. */}
            <Button size="lg" onClick={handleAuth}>
              {buttonLabel}
            </Button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-blue-400 text-2xs mb-4">
              <span className="w-4 h-4 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
              Waiting for sign-in...
            </div>
            <div className="text-fg-muted text-3xs max-w-xs">
              Complete the sign-in in your browser, then come back here. This page will update automatically.
            </div>
          </>
        )}

        {/* Error + retry */}
        {error && (
          <div className="mt-4 space-y-2 text-center">
            <div className="text-2xs text-fg-dim">
              Looks like the sign-in didn't complete. No worries — try again when you're ready.
            </div>
            {/* Filled-grey (bg-inset) becomes the outline `secondary` — spec decision 60. */}
            <Button variant="secondary" onClick={handleAuth}>
              Try Again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
