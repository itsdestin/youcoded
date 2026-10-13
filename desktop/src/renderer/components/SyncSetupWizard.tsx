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

import { createContext, useContext, useRef, useState, useEffect, useCallback } from 'react';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, CloseButton, ErrorState, FieldError, FieldRow, LoadingState, Pill, SectionLabel, SettingRow, TextInput, Toggle, Radio, RadioGroup, Callout } from './ui';
import { isAndroid as checkIsAndroid, isRemoteMode } from '../platform';

/** Whether a GitHub backup copies anything on the backend this screen talks to. Only the phone
 *  app's own backup service still pushes one; a computer's (or a phone paired to a computer)
 *  removed it. Shared with Backup & sync's rows. */
export function githubBackupWorks(): boolean {
  return checkIsAndroid() && !isRemoteMode();
}
import { useEscClose } from '../hooks/use-esc-close';
import { BackupLogo } from './BackupLogo';
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
type WizardStep = 'type' | 'prereqs' | 'auth' | 'configure';

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

// (The emoji discs and coloured ✓ / ✗ glyphs that lived here went with small-fixes-3: the
// picker is setting rows and each requirement shows a status pill.)

// --- Sub-view header (reused from SyncPanel) ---

/** What a wizard step puts in the popup's own header: its title and, when it has one, its way back.
 *
 *  WHY (small-fixes-3, Destin on the sign-in step: "weird spacing at the top"): every step drew
 *  its own header — a 14px bold title over a full-width line — inside Backup & sync's popup, the one
 *  hand-built header left in Settings. Now each step hands its title and back to the shared popup
 *  (guide "Popups and side panels": the shared title, the tapered line, the ✕; the back arrow is the
 *  popup's own, as Backup & sync's explainer and Edit views already use). */
export type WizardHeaderInfo = { title: string; onBack?: () => void };
export const WizardHeaderContext = createContext<((h: WizardHeaderInfo | null) => void) | null>(null);

function WizardHeader({ title, onBack, onClose }: { title: string; onBack?: () => void; onClose: () => void }) {
  const report = useContext(WizardHeaderContext);
  // The step's back changes identity every render; the popup gets a stable caller, so reporting
  // the header never loops.
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const hasBack = !!onBack;
  useEffect(() => {
    if (!report) return;
    report({ title, onBack: hasBack ? () => backRef.current?.() : undefined });
  }, [report, title, hasBack]);
  useEffect(() => () => { report?.(null); }, [report]);
  if (report) return null;
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
  // The GitHub repo this wizard has already created, so Try again reuses it (see handleStartBackup).
  const createdRepo = useRef<{ name: string; url: string } | null>(null);
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
      // GitHub only where it still backs anything up: the phone app's own backup service
      // (SyncService.kt pushGithub). WHY (small-fixes-2, Destin "yes, proceed"): on a computer the
      // GitHub backup was removed (sync-service.ts, sync-legacy-demolition), so the option made a
      // backup that copied nothing. A computer's GitHub copy is cross-device sync, above.
      ...(githubBackupWorks()
        ? [{ type: 'github' as BackendType, desc: 'Stores your data in a private GitHub repository. Includes full version history.' }]
        : []),
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
        <WizardHeader title="Add a backup" onClose={onClose} />
        <div ref={typeStepRef} className="scroll-fade flex-1">
          <div className="px-4 py-4 space-y-3">
          {/* WHY the round-2 cards again, with logos (small-fixes-3#SF3-1 "this is worse" about
              setting rows; #SF3-6 pick "logos"): each choice is its own first-level card — mark,
              name, one line, the arrow — as Destin had approved before, and the emoji in a coloured
              circle (SF2-8: "i dont like the icon") is the service's own logo, like the sign-in
              choices carry their provider logos (guide "Sign-in and setup screens"). */}
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
                // Card-levels sweep (2026-09-27): LEVEL-1 choice card.
                className={`w-full ${CARD_LEVEL_1} p-4 flex items-center gap-3 text-left transition-colors ${
                  disabled
                    ? 'opacity-50 cursor-not-allowed'
                    : 'hover:bg-inset cursor-pointer'
                }`}
              >
                <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 bg-inset text-fg">
                  <BackupLogo type={type} size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-fg font-medium">{BACKEND_LABELS[type]}</div>
                  <div className="text-3xs text-fg-muted mt-0.5">{desc}</div>
                  {existing > 0 && (
                    <div className="text-3xs text-fg-muted mt-1">
                      {disabled
                        ? `Already connected — ${BACKEND_LABELS[type]} only supports one backup`
                        : `${existing} already connected`}
                    </div>
                  )}
                </div>
                {!disabled && (
                  <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
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

        // If GitHub + create mode, create the repo first.
        // WHY remembered per name (final review F34): when the repo was created but saving the backup
        // then failed, Try again created the same repo again — GitHub refuses a name that exists, and
        // the person saw a raw error for a repo that was already theirs. A repo this wizard already
        // made under this name is reused; changing the name makes a new one.
        if (backendType === 'github' && repoMode === 'create') {
          const made = createdRepo.current?.name === repoName ? createdRepo.current.url : null;
          if (made) {
            finalRepoUrl = made;
          } else {
            const result = await claude.sync.setup.createRepo(repoName);
            if (!result.success) {
              setError(result.error || 'Failed to create repository');
              setSaving(false);
              return;
            }
            finalRepoUrl = result.repoUrl;
            if (result.repoUrl) createdRepo.current = { name: repoName, url: result.repoUrl };
          }
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

        await onComplete({ type: backendType, label, syncEnabled, config });

        // Restore-from-backup was removed in Plan 2c (2026-07-14) — the dated
        // Drive/iCloud snapshot reshape orphaned the flat-path readers, so
        // there is no "we found existing data → restore vs start fresh" gate
        // anymore. New backends always start fresh; a redesigned restore will
        // land later around the local-models/accounts/platform work.
        // No Done page (small-fixes-3#SF3-5): back to Backup & sync, where the new backup's row
        // and, if its first upload didn't finish, the error box under it say how it went.
        onClose();
        return;
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
          title={`Set up ${BACKEND_LABELS[backendType]}`}
          onBack={() => setStep(backendType === 'icloud' ? 'prereqs' : 'auth')}
          onClose={onClose}
        />
        <div ref={configureStepRef} className="scroll-fade flex-1">
          <div className="px-4 py-4 space-y-4">
          {/* WHY one labelled card (small-fixes-3): the fields, the switch and the duplicate note sat
              bare on the popup at their own spacing. The guide: nothing bare on the popup — a group
              is a small label and a card; a text box is a wide control (its title and hint above,
              full width below — FieldRow, Remote access's password); a switch sits beside its
              title and hint (the setting row); a note about the card is a notice inside it. The one
              main button goes under the card, full width (Submit a ticket's "Review ticket"). */}
          <div>
          <SectionLabel className="mb-2">Your backup</SectionLabel>
          <div className={`${CARD_LEVEL_1} p-3 space-y-2`}>
          <FieldRow title="Name" hint="Just for you — to tell your backups apart.">
            <TextInput
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={`My ${BACKEND_LABELS[backendType]}`}
              aria-label="Name"
              className="w-full"
              autoFocus
            />
          </FieldRow>

          {backendType === 'drive' && (
            <FieldRow title="Folder in Google Drive" hint={`Made in your Drive if it isn't there yet: "${driveFolder || 'Claude'}".`}>
              <TextInput
                value={driveFolder}
                onChange={(e) => setDriveFolder(e.target.value)}
                placeholder="Claude"
                aria-label="Folder in Google Drive"
                className="w-full"
              />
            </FieldRow>
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
                      {/* Shared FIELD surface (spec change 20). The box is a sibling of the
                          radio, not inside its label (so clicking into it no longer flips
                          the radio — sync.md, closed 2026-09-16); the explicit aria-label
                          stays so a screen reader names it rather than the radio's sentence. */}
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

          {backendType === 'icloud' && icloudPath && (
            <SettingRow variant="item" title="Stored in iCloud Drive at" description={<span className="font-mono">{icloudPath}</span>} />
          )}

          <SettingRow
            variant="item"
            title="Back up automatically after changes"
            description="Turn off to back up only when you choose to."
            control={<Toggle checked={syncEnabled} onChange={setSyncEnabled} aria-label="Back up automatically after changes" />}
          />

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
              <Callout tone="info">
                You already have a backup pointing to this exact destination (same account and folder). Adding another is safe, but it only repeats what that one does. If you meant a different account, go back and sign in to that one first.
              </Callout>
            ) : null;
          })()}
          </div>
          </div>

          {/* The failed save, said where Start backup was, with Try again inside it (small-fixes-1:
              this box had nothing to press; guide "A failed action replaces the buttons it came
              from", Submit a ticket's failed send). The fields above stay editable, and Try again
              uses what they say now. */}
          {/* Start backup button */}
          {/* Was a hardcoded bg-blue-600 family (spec change 55 — the last survivors of a
              blue that ignored the user's theme). `primary` paints it in the theme accent.
              The three-way saving/empty/ready className is gone: both the saving and the
              empty-label states are just `disabled` now (spec decision 72), and the spinner
              goes with the shared busy state later rather than being re-hardcoded here. */}
          {/* Only while the fields are complete: emptied after a failure, the plain (disabled)
              button comes back, as before. */}
          {error && !saving && label.trim() && !(backendType === 'github' && repoMode === 'existing' && !repoUrl.trim()) ? (
            <ErrorState mode="recoverable" message={error} onRetry={() => void handleStartBackup()} />
          ) : (
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
            {saving ? 'Setting up...' : 'Start backup'}
          </Button>
          )}
          </div>
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
      <WizardHeader title="Checking setup" onBack={onBack} onClose={onClose} />
      <div ref={bodyRef} className="scroll-fade flex-1">
        <div className="px-4 py-4 space-y-4">

        {/* WHY one labelled card of rows (small-fixes-3): each requirement was a card of its own
            with a coloured ✓ / ✗ glyph and lowercase words, and the install sat bare under them.
            The guide: a list of short names is plain rows inside ONE box (decisions "device list",
            L-3); a state is a status pill in its colour, normal words (the Local engine's
            Running / Stopped); a lone button is full width; text about the card lives inside it. */}
        <div>
        <SectionLabel className="mb-2">What this needs</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 space-y-2`}>
        {backendType === 'drive' && (<>
          <PrereqRow label="Cloud sync tool" status={checking ? 'checking' : prereqs?.rcloneInstalled ? 'ready' : 'missing'} />
          <PrereqRow label="Google account connected" status={checking ? 'checking' : prereqs?.gdriveConfigured ? 'ready' : 'missing'} />
        </>)}
        {backendType === 'github' && (<>
          <PrereqRow label="GitHub tools" status={checking ? 'checking' : prereqs?.ghInstalled ? 'ready' : 'missing'} />
          <PrereqRow label="Signed in to GitHub" status={checking ? 'checking' : prereqs?.ghAuthenticated ? 'ready' : 'missing'} />
        </>)}
        {backendType === 'icloud' && (
          <PrereqRow label="iCloud Drive found" status={checking ? 'checking' : prereqs?.icloudPath ? 'ready' : 'missing'} />
        )}

        {/* Action: install rclone */}
        {needsRclone && !checking && (
          <div className="pt-1 space-y-2">
            <p className="text-2xs text-fg-muted">
              YouCoded needs a small helper tool to connect to Google Drive. Installing it usually takes about a minute.
            </p>
            {/* Hidden once the install failed: its notice below carries Try again (small-fixes-1).
                The spinner stays: a minute of a motionless disabled button reads as hung. */}
            {!installError && (
              <Button size="lg" className="w-full" onClick={handleInstall} disabled={installing}>
                {installing && (
                  <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                )}
                {installing ? 'Installing…' : 'Install now'}
              </Button>
            )}
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

        {/* Install error. WHY ErrorState (small-fixes-1): the box offered only an underlined
            "Install manually" link — no way to try the install again, and underlined text is not
            a button (guide "Buttons"). Now the shared error box: Install manually (outlined) and
            Try again (filled) inside it, in place of the Install now button. */}
        {installError && (
          <ErrorState mode="recoverable" message={installError} onRetry={() => void handleInstall()}
            moreActions={[{ label: 'Install manually', onClick: () => claude.openExternal('https://rclone.org/install/') }]} />
        )}
        </div>
        </div>
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
            <button className="text-accent underline link-control" onClick={() => claude.openExternal('https://apps.microsoft.com/detail/9PKTQ5699M62')}>
              Microsoft Store
            </button>
            <span className="text-fg-muted">or</span>
            <button className="text-accent underline link-control" onClick={() => claude.openExternal('https://www.apple.com/icloud/setup/pc.html')}>
              apple.com/icloud
            </button>
          </div>
          <div>After installing, sign in with your Apple ID and enable iCloud Drive. Then come back and tap "Check again".</div>
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
        <Button variant="secondary" className="w-full" onClick={onRecheck}>
          Check again
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
            "GitHub CLI was installed, but this app can't see it yet. Quit and reopen YouCoded, then tap Check again.",
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
          <Button size="lg" className="w-full" onClick={handleInstallGh} disabled={installing}>
            {installing && (
              <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
            )}
            {installing ? 'Installing...' : 'Install now'}
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
          <div className={`font-mono text-fg-dim ${CARD_LEVEL_2} px-2 py-1`}>brew install gh</div>
          <div>No Homebrew? Download the installer from <button className="text-accent underline link-control" onClick={() => claude.openExternal('https://cli.github.com')}>cli.github.com</button>.</div>
        </div>
      )}
      {(installError || !canAutoInstall) && os === 'windows' && (
        <div className="text-3xs text-fg-muted space-y-1">
          <div>On Windows, download the installer from <button className="text-accent underline link-control" onClick={() => claude.openExternal('https://cli.github.com')}>cli.github.com</button>.</div>
          <div>Or, if you use winget, open PowerShell and run:</div>
          <div className={`font-mono text-fg-dim ${CARD_LEVEL_2} px-2 py-1`}>winget install GitHub.cli</div>
        </div>
      )}
      {(installError || !canAutoInstall) && os === 'linux' && (
        <div className="text-3xs text-fg-muted space-y-1">
          <div>On Linux, install with your package manager:</div>
          <div className={`font-mono text-fg-dim ${CARD_LEVEL_2} px-2 py-1`}>sudo apt install gh  # Debian/Ubuntu</div>
          <div className={`font-mono text-fg-dim ${CARD_LEVEL_2} px-2 py-1`}>sudo dnf install gh  # Fedora</div>
          <div>Full instructions: <button className="text-accent underline link-control" onClick={() => claude.openExternal('https://github.com/cli/cli/blob/trunk/docs/install_linux.md')}>install guide</button>.</div>
        </div>
      )}
      {(installError || !canAutoInstall) && os === 'other' && (
        <div className="text-3xs text-fg-muted">
          Install from <button className="text-accent underline link-control" onClick={() => claude.openExternal('https://cli.github.com')}>cli.github.com</button>, then come back and tap "Check again".
        </div>
      )}
      {(installError || !canAutoInstall) && (
        <div className="text-3xs text-fg-muted">After installing, come back and tap "Check again".</div>
      )}
      {/* Filled-grey (bg-inset) becomes the outline `secondary` — spec decision 60. */}
      {/* Full width: a follow-up action under a group (guide "Buttons"). */}
      <Button variant="secondary" className="w-full" onClick={onRecheck}>
        Check again
      </Button>
    </div>
  );
}

// --- Prereq checklist row ---

function PrereqRow({ label, status }: { label: string; status: 'checking' | 'ready' | 'missing' }) {
  return (
    <SettingRow
      variant="item"
      title={label}
      control={status === 'checking' ? <Pill>Checking…</Pill>
        : status === 'ready' ? <Pill tone="ok">Ready</Pill>
        : <Pill tone="warning">Needed</Pill>}
    />
  );
}

// --- Auth Step ---

// Said only when the sign-in gave no reason of its own: nothing about why (never a guess).
const SIGN_IN_NO_REASON = "The sign-in didn't finish.";

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
          setError(result.error || SIGN_IN_NO_REASON);
        }
      } else if (backendType === 'github') {
        const result = await claude.sync.setup.authGithub();
        if (result.success) {
          onSuccess({ username: result.username });
        } else {
          setError(result.error || SIGN_IN_NO_REASON);
        }
      }
    } catch (e: any) {
      setError(plainMessage(e, SIGN_IN_NO_REASON));
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
      {/* WHY rebuilt (small-fixes-3, Destin: "this page sucks. weird spacing at the top, spacing
          between cards is weird, i dont like the icon"): it centred a coloured emoji disc and
          loose lines in the middle of the popup, the tip box at its own spacing. Now it is
          Settings → Account's sign-in card (decisions "Games: signed-out card"): a small label,
          one card, a left-aligned line, any tip as a notice inside the card, and one full-width
          filled button — top-aligned, the guide's 16px between groups. Waiting replaces the
          button with the shared loading line; a failure replaces it with the error box. */}
      <div className="flex-1 px-4 py-4 space-y-4">
        <div>
          <SectionLabel className="mb-2">{backendType === 'drive' ? 'Google account' : 'GitHub account'}</SectionLabel>
          <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
            <p className="text-xs text-fg-2">
              A browser window opens for you to sign in. Come back here afterwards — this page updates by itself.
            </p>
            {isReconnect && backendType === 'drive' && (
              <Callout tone="warning">
                Sign in with the <strong>same Google account</strong> you connected before. A different account would start a new backup instead of continuing this one.
              </Callout>
            )}
            {isAdditionalDrive && (
              <Callout tone="warning">
                Pick the <strong>other</strong> Google account (work, personal or school) in the browser — not the one you already connected. You may need to sign out of Google in your browser first, or use a private window.
              </Callout>
            )}
            {waiting ? (
              <LoadingState variant="inline" verb="Waiting for" what="you to finish signing in, in your browser" />
            ) : error ? (
              /* The sign-in's own reason, or only what is certain (small-fixes-2#SF2-8), with
                 Try again, in the button's place. */
              <ErrorState mode="recoverable" variant="inline" message={error} onRetry={() => void handleAuth()} />
            ) : (
              <Button size="lg" className="w-full" onClick={handleAuth}>
                {buttonLabel}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
