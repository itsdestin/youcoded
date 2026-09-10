// Local engine install/status card (Plan B). Lives under the 'local' provider
// row in ProvidersSection; Plan C moves it into the Local Models panel.
// Status language is plain words — never status glyphs (standing UX rule).
// Class idioms (text sizes, accent buttons) mirror ProvidersSection's own rows
// so the card reads as part of the section. As of change 25 the surface IS that
// row surface (bg-inset/50, borderless), not a lookalike.
//
// 2026-09-05 local-engine upgrades (design deck docs/active/design/2026-09-04-
// local-engine-upgrades, round 2). Hierarchy, top to bottom: the card title with
// the state word beside it · ONE fact line (chip · models loaded · last reply
// speed while running; version · backend otherwise) · the row actions. Then two
// SettingRows: "Faster engine" (only when main found a matching chip AND that
// build is one we recommend — 2026-09-06: ROCm no longer is) and "Advanced"
// (expands in place — the right-hand chevron every row has, turned down; never
// a leading "›" text toggle, which Destin rejected in round 1). Advanced holds
// the two speed switches, the context length, the optional engine builds and
// the folder.
import { useEffect, useState } from 'react';
import { AnchorTip, Button, Callout, ErrorState, FieldError, SettingRow, TextInput, Toggle } from './ui';
import { BugReportPopup } from './development/BugReportPopup';
import type { ReportContext } from './development/ReportDesign';
import type { BackendOption, EnginePrereqs, EngineSpeedSettings } from '../../shared/engine-types';
// WHY imported rather than defined here: this card is no longer the only place a
// rejected bridge call reaches the user — the model settings dialog and “Add
// vision” show one too, and each copy is a call site that can forget to strip.
import { plainMessage } from '../utils/ipc-error';

interface EngineStatusView {
  installed: boolean;
  installedVersion: string | null;
  pinnedVersion: string;
  backend: string | null;
  state: 'not-installed' | 'stopped' | 'starting' | 'running' | 'error';
  errorMessage?: string;
  cacheDir: string;
  contextSize: number;   // Plan C: the context-length knob binds to this
  // Optional: an older main omits them and the card simply shows less.
  deviceName?: string | null;
  loadedModelsBytes?: number;
  // Either rate may be missing on its own — see ReplyTimings in engine-types.
  lastReply?: { promptPerSecond?: number; generatePerSecond?: number } | null;
  backendOptions?: BackendOption[];
  speed?: EngineSpeedSettings;
  /** A saved engine setting has not reached the engine yet (design §B). */
  configApplyPending?: boolean;
  /** …and a reply really is what it is waiting for, rather than an idle moment
   *  a poll interval away. */
  configApplyWaitingForReply?: boolean;
  /** The real failure text if applying a saved setting went wrong. */
  configApplyError?: string | null;
  /** False when the running engine started WITHOUT its per-model settings file.
   *  `undefined` = the question does not apply (not running / older main). */
  modelSettingsInForce?: boolean;
  /** Why, in the OS's or the engine's own words. Null = no legible reason. */
  modelSettingsError?: string | null;
}

type Progress =
  | { kind: 'download'; receivedBytes: number; totalBytes: number | null }
  | { kind: 'verify' } | { kind: 'unpack' }
  | { kind: 'done' } | { kind: 'error'; message: string };

// Bytes → whole MB for the download progress line.
const mb = (n: number) => `${Math.round(n / 1048576)} MB`;
// Bytes → GB with one decimal, for "8.9 GB loaded".
const gb = (n: number) => `${(n / 1073741824).toFixed(1)} GB`;

// Plain names for the engine builds. The backend id is what main stores; the
// user reads the chip family it targets.
const BACKEND_WORDS: Record<string, string> = {
  vulkan: 'Vulkan',
  cpu: 'processor only',
  metal: 'Metal',
  cuda: 'CUDA (NVIDIA)',
  rocm: 'ROCm (AMD)',
};
const CHIP_WORDS: Record<string, string> = { cuda: 'NVIDIA', rocm: 'AMD', metal: 'Apple' };

// Builds we offer but do NOT recommend: they live under Advanced instead of in
// the card body, and their row describes a trade rather than a win.
//
// WHY ROCm is here and CUDA is not: CUDA's advantage is not in question, but
// ROCm was measured (2026-09-05, engine b10665, AMD Strix Halo / Radeon 8060S,
// two models) reading prompts ~20% faster and WRITING replies 24–46% slower
// than the Vulkan build it would replace. Writing is the half a user watches
// happen, so pushing ROCm at everyone with an AMD chip made most of them
// slower. It stays available — findable, not sold. Numbers and method:
// docs/engine-dependencies.md → "ROCm vs Vulkan, measured".
const OPTIONAL_BACKENDS = new Set<string>(['rocm']);

export default function EngineCard({ showDetails = false }: { showDetails?: boolean }) {
  const [status, setStatus] = useState<EngineStatusView | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Fetch once, then keep live via the two push subscriptions. `alive` guards
    // the async status() resolve against an unmount before it lands.
    let alive = true;
    void window.claude.engine.status().then((s: any) => { if (alive) setStatus(s); });
    const offP = window.claude.engine.onInstallProgress((p: any) => setProgress(p));
    const offS = window.claude.engine.onStatusChanged((s: any) => setStatus(s));
    return () => { alive = false; offP(); offS(); };
  }, []);

  // Context-length knob draft (Plan C, showDetails). Re-syncs whenever the
  // engine's configured contextSize changes (initial load, push, or a commit).
  const [ctxDraft, setCtxDraft] = useState<number | null>(null);
  useEffect(() => { if (status) setCtxDraft(status.contextSize); }, [status?.contextSize]);

  // Advanced — collapsed by default (Q-2 note: non-developers first).
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // The faster-engine option that needs system software first (Linux ROCm):
  // whether its set-up box is open, and what main says is missing.
  const [setupOpen, setSetupOpen] = useState(false);
  const [prereqs, setPrereqs] = useState<EnginePrereqs | null>(null);
  const [copied, setCopied] = useState(false);
  // Its own error, NOT the card-wide `error`: that one renders in the card body,
  // a couple of hundred pixels above the Run-in-terminal button, which lives
  // inside an expanded Callout. A message the user has to scroll to find is a
  // message they do not read.
  const [terminalError, setTerminalError] = useState<string | null>(null);
  // Opened by both actions of the no-cause error shape below — the same wiring
  // every other <ErrorState mode="general"> in the app uses.
  // WHY the context object doubles as the open flag: two pieces of state that must
  // agree (is it open / what is it about) drift; one cannot.
  const [reportContext, setReportContext] = useState<ReportContext | null>(null);

  // Shared runner for install/restart/setContext/setBackend: sets busy,
  // surfaces any thrown error, and clears the transient progress line when the
  // action settles.
  const run = async (fn: () => Promise<any>) => {
    setBusy(true); setError(null);
    try { setStatus(await fn()); }
    catch (e: any) { setError(plainMessage(e)); }
    finally { setBusy(false); setProgress(null); }
  };

  // "Run in terminal": open a plain-shell session with the install command
  // already typed onto its prompt. The app does not press Enter — the user
  // reads the command and runs it themselves, in their own terminal, where the
  // password an installer asks for is typed.
  //
  // Nothing selects the session here: main forwards session:created to this
  // window and App.tsx's handler focuses a newly created session and closes
  // Settings, which is the same path every other new session takes.
  const openTerminalWithCommand = async (command: string) => {
    // busy also disables the button — without it a double-click opens two
    // terminals, and the second one steals focus from the first.
    setBusy(true); setTerminalError(null);
    try { await window.claude.engine.runInTerminal(command); }
    // The real reason, not a guess — the terminal failing to open is the only
    // thing the user can act on here (Copy is right beside this button).
    // Electron wraps every rejected invoke as "Error invoking remote method
    // 'engine:run-in-terminal': Error: <the real message>", which is machinery,
    // not something a non-developer can act on. Strip it down to the sentence.
    catch (e: any) { setTerminalError(plainMessage(e)); }
    finally { setBusy(false); }
  };

  // Commit the context-length knob. Reverts an invalid value (< 1024 or NaN)
  // and no-ops when unchanged, so a blur/Enter can't needlessly disturb the
  // engine. NOTE (2026-09-05): setContext no longer RESTARTS anything — the
  // context length lives in the engine's preset file now, and main rewrites it
  // and asks the router to re-read it, once no reply is streaming. The engine
  // keeps serving throughout.
  const commitContext = async () => {
    if (ctxDraft == null || !status) return;
    const n = Math.floor(ctxDraft);
    if (!Number.isFinite(n) || n < 1024) { setCtxDraft(status.contextSize); return; }
    if (n === status.contextSize) return;
    await run(() => window.claude.engine.setContext(n));
  };

  // The faster-engine row (S-1). main offers an option ONLY after it has found
  // the matching chip AND, where the build needs system software, that software
  // — so a 'ready' switch is expected to succeed. The device check after install
  // is the safety net, not the normal path (round-1 P-3: the refusal "reads as
  // broken", so it is no longer a featured state; a failure lands in `error`).
  const chooseBackend = async (opt: BackendOption) => {
    if (opt.state === 'needs-prereqs') {
      const next = !setupOpen;
      setSetupOpen(next);
      if (next) {
        setPrereqs(null);
        try { setPrereqs(await window.claude.engine.prereqs(opt.backend)); }
        catch (e: any) { setError(plainMessage(e)); }
      }
      return;
    }
    await run(() => window.claude.models.setBackend(opt.backend));
  };

  // "Check again" after the user ran the install: re-read what is missing and,
  // when nothing is, go straight on to the switch.
  const recheck = async (backend: string) => {
    try {
      const p = await window.claude.engine.prereqs(backend);
      setPrereqs(p);
      if (p.satisfied) { setSetupOpen(false); await run(() => window.claude.models.setBackend(backend)); }
    } catch (e: any) { setError(plainMessage(e)); }
  };

  const copyCommand = async (cmd: string) => {
    try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard blocked — the command is still on screen to select */ }
  };

  if (!status) return null;

  // A pin bump does NOT upgrade anyone on its own: EngineAcquisition.installed()
  // falls back to whatever complete install it finds, so an existing b-number
  // keeps serving forever and the Install button below is hidden once ANY engine
  // is present. Without this row a newer engine — the only way to run a model
  // built on a newer architecture — is unreachable from the UI (found 2026-08-27,
  // when b9992 could not read qwen4exp and b10665 could).
  const updateAvailable = status.installed
    && status.installedVersion !== null
    && status.installedVersion !== status.pinnedVersion;

  // Plain-words state, one word or two, beside the title (no glyphs).
  const stateWord =
    status.state === 'not-installed' ? 'Not installed'
    : status.state === 'running' ? 'Running'
    : status.state === 'starting' ? 'Starting…'
    : 'Stopped';

  // ONE fact line (S-4). Running: chip · models loaded · last reply speed.
  // Otherwise: version · backend, so the user still knows what is on disk.
  const facts: string[] = [];
  if (status.state === 'running') {
    // Three answers, not two (see EngineManager.status): a name is the chip,
    // `null` means the engine looked and found none, and `undefined` means we
    // have not asked yet. Saying "Processor only" while still checking asserts
    // something we do not know — and it lands exactly on a fresh install, whose
    // device list has not been read yet.
    if (status.deviceName !== undefined) facts.push(status.deviceName ?? 'Processor only');
    if (typeof status.loadedModelsBytes === 'number') {
      facts.push(status.loadedModelsBytes > 0 ? `${gb(status.loadedModelsBytes)} loaded` : 'nothing loaded');
    }
    // Show whichever halves were measured. A prompt served entirely from the
    // cache has no reading speed to report, and printing "0 read per second"
    // beside a real write speed would be a wrong fact about the machine —
    // dropping the whole line over it would lose a true one.
    if (status.lastReply) {
      const rates: string[] = [];
      if (typeof status.lastReply.promptPerSecond === 'number') rates.push(`${Math.round(status.lastReply.promptPerSecond)} read`);
      if (typeof status.lastReply.generatePerSecond === 'number') rates.push(`${Math.round(status.lastReply.generatePerSecond)} write`);
      if (rates.length > 0) facts.push(`last reply ${rates.join(' / ')} per second`);
    }
  } else if (status.installed) {
    facts.push(`Engine ${status.installedVersion}`, BACKEND_WORDS[status.backend ?? ''] ?? status.backend ?? '');
    if (status.state === 'stopped') facts.push('starts on first message');
  }
  const factLine = status.state === 'error'
    ? (status.errorMessage ?? 'Stopped after repeated crashes')
    : facts.filter(Boolean).join(' · ');

  const options = (status.backendOptions ?? []).filter((o) => o.backend !== status.backend);
  // Two shelves, not one list. A recommended build (CUDA) keeps its place in the
  // card body; an optional one (ROCm) is rendered inside Advanced, which is shut
  // by default — see OPTIONAL_BACKENDS for why that distinction exists.
  const recommendedOptions = options.filter((o) => !OPTIONAL_BACKENDS.has(o.backend));
  const optionalOptions = options.filter((o) => OPTIONAL_BACKENDS.has(o.backend));
  // WHY there is no `?? { speculative: true, compressCache: true }` here any
  // more: that was a THIRD copy of a default already written down twice (main's
  // DEFAULT_ENGINE_SPEED and the spawn config), and every producer of this
  // status — Electron's handler, the remote server, and the workbench fake —
  // always sends `speed`. A copy that cannot be reached can only drift, and a
  // drifted copy would draw both switches ON while the engine ran with one OFF.
  // If a status ever arrives without it, the switches are hidden rather than
  // guessed: showing a switch we cannot read is a claim about the user's
  // machine we have no basis for.
  const speed = status.speed;

  /** One "another engine build" row. Extracted into a function so the
   *  recommended builds can render in the card body and the optional ones
   *  inside Advanced from the SAME markup — two hand-kept copies of a row with
   *  a set-up box inside it would drift apart. */
  const backendOptionRow = (opt: BackendOption) => {
    const optional = OPTIONAL_BACKENDS.has(opt.backend);
    const build = BACKEND_WORDS[opt.backend] ?? opt.backend;
    const current = BACKEND_WORDS[status.backend ?? ''] ?? 'the current engine';
    return (
      <div key={opt.backend} className="space-y-1.5">
        <SettingRow
          variant="item"
          title={optional
            ? `Optional engine for your ${CHIP_WORDS[opt.backend] ?? opt.backend} chip`
            : `Faster engine for your ${CHIP_WORDS[opt.backend] ?? opt.backend} chip`}
          description={[
            // A recommended build is described as the win it is; an optional one
            // is described as the trade it measured as (see OPTIONAL_BACKENDS).
            // Deliberately no numbers: they came off one machine, and a figure
            // on screen reads as a promise about the reader's.
            optional
              ? (opt.state === 'needs-prereqs'
                  ? `Not recommended. ${build} needs AMD's software installed first, and it writes replies more slowly than ${current}.`
                  : `Not recommended. ${build} begins reading a long message sooner, but writes its reply more slowly than ${current}.`)
              : (opt.state === 'needs-prereqs'
                  ? `${build} needs AMD's software installed first.`
                  : `${build} is usually much faster than ${current} on this chip.`),
            optional ? 'Worth trying only if you want to compare the two.' : null,
            // main appends a sentence when it knows something this row cannot:
            // today, that with no model downloaded yet the switch can only be
            // checked as far as the engine starting (§A4).
            opt.note,
          ].filter(Boolean).join(' ')}
          control={(
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void chooseBackend(opt)}
              disabled={busy}
              aria-expanded={opt.state === 'needs-prereqs' ? setupOpen : undefined}
            >
              {opt.state === 'needs-prereqs' ? (setupOpen ? 'Hide' : 'Set up') : 'Switch'}
            </Button>
          )}
        />

        {/* Q-1 pick a: the set-up box. One sentence, the command for THIS
            Linux flavour with Copy inside it, two buttons. The terminal is
            where the password is typed — nothing installs behind your back. */}
        {setupOpen && opt.state === 'needs-prereqs' && (
          <Callout
            tone="info"
            className="text-2xs"
            title={(
              <span className="flex items-center gap-1">
                Install AMD&rsquo;s ROCm software first
                <AnchorTip label="What is ROCm?" title="What is ROCm?" widthClass="w-72">
                  ROCm is AMD&rsquo;s software for running heavy math on its graphics chips.
                  This engine build is made with it, so it has to be on this computer first.
                  It installs with your system&rsquo;s package manager and can be removed
                  the same way.
                </AnchorTip>
              </span>
            )}
          >
            {!prereqs && <p className="text-fg-muted">Checking this computer…</p>}
            {prereqs && !prereqs.satisfied && prereqs.command && (
              <div className="space-y-2">
                <p className="text-fg-muted">
                  Run this in a terminal{prereqs.distro ? ` (${prereqs.distro})` : ''}. It will ask for your password.
                </p>
                <div className="flex items-start gap-1.5 rounded-md bg-well px-2.5 py-2">
                  <pre className="flex-1 min-w-0 text-3xs font-mono whitespace-pre-wrap break-words select-all">{prereqs.command}</pre>
                  <Button size="sm" variant="ghost" onClick={() => void copyCommand(prereqs.command!)} className="shrink-0 -my-1">
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <div className="flex gap-1.5">
                  <Button size="sm" disabled={busy} onClick={() => void openTerminalWithCommand(prereqs.command!)}>
                    Run in terminal
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void recheck(opt.backend)} disabled={busy}>
                    Check again
                  </Button>
                </div>
                {terminalError && <FieldError as="p">{terminalError}</FieldError>}
              </div>
            )}
            {prereqs && !prereqs.satisfied && !prereqs.command && (
              <div className="space-y-2">
                {/* Two very different reasons there is nothing to paste, and
                    they must not read the same. On Ubuntu and Debian we know
                    exactly which system this is — the packages simply come
                    from AMD's own repository, which has to be added first.
                    Telling that user we could not recognise their Linux,
                    one line under the words "Ubuntu 24.04", reads as the
                    app being broken. */}
                <p className="text-fg-muted">
                  {prereqs.reason === 'needs-amd-repo'
                    ? <>On {prereqs.distro ?? 'this system'}, AMD&rsquo;s software comes from AMD&rsquo;s own
                      download site rather than your system&rsquo;s. Their guide has the steps;
                      press Check again when it is installed.</>
                    : <>We could not tell which Linux this is. AMD&rsquo;s guide covers every supported system;
                      press Check again when it is installed.</>}
                </p>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => void window.claude.shell.openExternal(prereqs.docsUrl)}>
                    Open AMD&rsquo;s guide
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void recheck(opt.backend)} disabled={busy}>
                    Check again
                  </Button>
                </div>
              </div>
            )}
            {prereqs?.satisfied && <p>Everything is in place — switching…</p>}
          </Callout>
        )}
      </div>
    );
  };

  return (
    // Change 25: the in-panel row surface — bg-inset/50, borderless. Was
    // `border border-edge-dim bg-well`. Same idiom as ProvidersSection's rows
    // and SettingsRow, which is what the header comment above always intended.
    <div className="mt-2 rounded-lg bg-inset/50 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-fg font-medium">
            Local engine
            <span className="ml-2 text-3xs font-normal text-fg-muted">{stateWord}</span>
          </p>
          {factLine && <p className="text-3xs text-fg-muted" data-testid="engine-fact-line">{factLine}</p>}
        </div>
        {/* Primary row action via the shared primitive — drops the hand-rolled
            accent fill + hover:brightness-110 (invisible on near-black accents). */}
        {status.state === 'not-installed' && (
          <Button
            size="sm"
            className="shrink-0"
            disabled={busy}
            onClick={() => run(() => window.claude.engine.install())}
          >
            {busy ? 'Installing…' : 'Install'}
          </Button>
        )}
        {status.state === 'error' && (
          <Button
            size="sm"
            className="shrink-0"
            disabled={busy}
            onClick={() => run(() => window.claude.engine.restart())}
          >
            Restart engine
          </Button>
        )}
        {/* engine.install() always fetches the PINNED build and verify-boots it
            before it takes over, so the same call is both first install and
            upgrade — nothing new is needed in main. */}
        {updateAvailable && status.state !== 'error' && (
          <Button
            size="sm"
            className="shrink-0"
            disabled={busy}
            onClick={() => run(() => window.claude.engine.install())}
          >
            {busy ? 'Updating…' : 'Update'}
          </Button>
        )}
      </div>
      {busy && progress?.kind === 'download' && (
        <p className="mt-2 text-3xs text-fg-dim">
          Downloading… {mb(progress.receivedBytes)}{progress.totalBytes ? ` of ${mb(progress.totalBytes)}` : ''}
        </p>
      )}
      {busy && (progress?.kind === 'verify' || progress?.kind === 'unpack') && (
        <p className="mt-2 text-3xs text-fg-dim">{progress.kind === 'verify' ? 'Verifying download…' : 'Unpacking…'}</p>
      )}
      {error && <FieldError as="p" className="mt-2">{error}</FieldError>}
      {/* Say WHY the button is there. "A newer engine is available" alone tells a
          non-developer nothing about whether they need it. */}
      {updateAvailable && !busy && (
        <p className="mt-2 text-3xs text-fg-dim">
          A newer engine ({status.pinnedVersion}) is available. Newer engines can run
          newer models — update if a model you downloaded won't load.
        </p>
      )}

      {/* The engine started without the file that holds each model's own
          settings (T7's fallback: a settings file it cannot use produces a
          WORKING engine rather than a dead one). Until this line existed the
          fallback was silent — a user whose per-model context length and extra
          flags were being ignored saw a perfectly normal running engine.
          Strictly `=== false`: `undefined` means nobody has an answer (the
          engine is not running, or an older main never sent one), and that must
          not read as "off". A remote or Android client talking to an older
          desktop is exactly that case, and telling all of those users their
          settings are ignored would be a claim about a run we never saw.

          TWO SHAPES, per docs/error-message-standards.md. When whatever refused
          the file said why — the OS's write error, or the engine's own startup
          sentence — that reason is quoted verbatim and there is nothing to press,
          because the engine writes the file again by itself at its next start.
          When nothing legible came back we do NOT invent a cause: the message
          stays non-committal and carries the standard's two actions instead. */}
      {status.modelSettingsInForce === false && (
        status.modelSettingsError
          ? (
            <Callout tone="warning" className="mt-2" title="Each model&rsquo;s own settings are off right now">
              <p>
                Every model is running on the engine&rsquo;s own settings. It tries again the
                next time the engine starts.
              </p>
              {/* The real words, kept apart from our sentence so it is obvious
                  which half is the machine talking. `break-words` because engine
                  errors carry long unbroken file paths that CSS will not break
                  on its own, and an overflowing path hides the rest. */}
              <p className="mt-1.5 font-mono text-3xs text-fg-dim break-words">{status.modelSettingsError}</p>
            </Callout>
          )
          : (
            <ErrorState
              mode="general"
              className="mt-2"
              title="Each model&rsquo;s own settings are off right now"
              explainer="Every model is running on the engine&rsquo;s own settings, and the engine gave no reason we can show you. It tries again the next time the engine starts. Diagnosing will collect the app&rsquo;s logs so Claude can look at what happened."
              onReportBug={() => setReportContext({ surface: 'Local model settings' })}
              onDiagnose={() => setReportContext({ surface: 'Local model settings', diagnose: true })}
            />
          )
      )}
      <BugReportPopup open={!!reportContext} onClose={() => setReportContext(null)} context={reportContext ?? undefined} />

      {/* Extra controls for the Local Models panel (Plan C). Only shown once the
          engine is installed — nothing to configure before that. */}
      {showDetails && status.installed && (
        <div className="mt-2.5 space-y-1.5">
          {/* S-1: a faster engine, as a row. Present only when main detected the
              matching chip (and its software, where the build needs some).
              Only RECOMMENDED builds render here; the optional ones are further
              down, inside Advanced. */}
          {recommendedOptions.map(backendOptionRow)}

          {/* Advanced (Q-4 pick a): the one expandable-row shape — SettingRow with
              its chevron turned down while open. */}
          <SettingRow
            variant="item"
            title="Advanced"
            description={advancedOpen ? undefined : 'Speed settings, context length, where models are stored'}
            onClick={() => setAdvancedOpen((o) => !o)}
            expanded={advancedOpen}
          />

          {advancedOpen && (
            <div className="space-y-1.5 pl-3" data-testid="engine-advanced">
              {/* Both default ON — the best defaults ship; the switch is for ruling a
                  feature out when a model misbehaves (Destin, Q-4 note). Short hints;
                  the (i) carries the explanation. */}
              {speed && (<>
              <SettingRow
                variant="item"
                title={(
                  <span className="flex items-center gap-1">
                    Speculative decoding
                    <AnchorTip label="About speculative decoding" title="Speculative decoding" widthClass="w-72">
                      The engine guesses several words ahead from text already in the
                      conversation, then checks the guesses in one go. Replies that repeat
                      earlier text — a file being edited, a quote — come back up to six times
                      faster; other replies are unchanged, and the words are exactly what the
                      model would have written anyway.
                    </AnchorTip>
                  </span>
                )}
                description="Faster replies when text repeats."
                control={(
                  <Toggle
                    checked={speed.speculative}
                    disabled={busy}
                    aria-label="Speculative decoding"
                    onChange={(next) => void run(() => window.claude.engine.setConfig({ speed: { speculative: next } }))}
                  />
                )}
              />
              <SettingRow
                variant="item"
                title={(
                  <span className="flex items-center gap-1">
                    Compress context memory
                    <AnchorTip label="About context memory compression" title="Compress context memory" widthClass="w-72">
                      Long conversations are kept in memory while a model works. Storing that
                      memory at 8 bits instead of 16 halves what it takes and speeds up long
                      conversations, with no quality change most people can measure.
                    </AnchorTip>
                  </span>
                )}
                description="Halves the memory long chats use."
                control={(
                  <Toggle
                    checked={speed.compressCache}
                    disabled={busy}
                    aria-label="Compress context memory"
                    onChange={(next) => void run(() => window.claude.engine.setConfig({ speed: { compressCache: next } }))}
                  />
                )}
              />
              </>)}

              {/* Context-length knob. Commits on Enter or blur. Moved under Advanced
                  2026-09-05; a model's own Settings can override it. */}
              <SettingRow
                variant="item"
                title={(
                  <span className="flex items-center gap-1">
                    Context length
                    <AnchorTip label="About context length" title="Context length" widthClass="w-72">
                      How much of a conversation a model holds in mind at once. Longer costs
                      memory: a 9&nbsp;GB model at 128k needs about 16&nbsp;GB more. This is the
                      default for every model; a model&rsquo;s own Settings can override it.
                    </AnchorTip>
                  </span>
                )}
                description="Default for every model."
                control={(
                  <TextInput
                    id="engine-context-size"
                    aria-label="Context length"
                    type="number"
                    size="sm"
                    min={1024}
                    step={1024}
                    value={ctxDraft ?? ''}
                    disabled={busy}
                    onChange={(e) => setCtxDraft(e.target.value === '' ? null : Number(e.target.value))}
                    onBlur={() => void commitContext()}
                    onKeyDown={(e) => { if (e.key === 'Enter') void commitContext(); }}
                    className="w-24"
                  />
                )}
              />

              {/* A setting saved here does NOT reach the engine while a reply is
                  streaming — restarting it mid-answer would kill the reply on
                  screen, so the change is held until the engine is quiet (up to
                  ten minutes). Without this line the user flips a switch and
                  watches nothing happen, with no way to tell whether it saved.

                  TWO SENTENCES, because the flag alone covers two different
                  waits: on an idle machine the change lands a poll interval
                  later with no reply anywhere, and telling that user to wait for
                  a reply would be wrong the majority of the time. */}
              {status.configApplyPending && (
                <p className="text-3xs text-fg-muted" data-testid="engine-apply-pending">
                  {status.configApplyWaitingForReply ? 'Applies after the current reply.' : 'Applying now…'}
                </p>
              )}
              {/* The REAL failure, in main's words. This one has nowhere else to
                  go: the setting was saved and the call already answered "yes"
                  long before applying it went wrong, so without this line the
                  change silently never lands. */}
              {status.configApplyError && <FieldError as="p">{status.configApplyError}</FieldError>}

              {/* The optional engine builds (ROCm). Deliberately down HERE, inside
                  a section that is shut by default, rather than in the card body
                  beside the recommended ones — see OPTIONAL_BACKENDS. */}
              {optionalOptions.map(backendOptionRow)}

              {/* Engine build + folder — read-only facts, one quiet row. */}
              <SettingRow
                variant="item"
                title="Engine build"
                description={status.cacheDir}
                value={`${status.installedVersion ?? '—'} · ${BACKEND_WORDS[status.backend ?? ''] ?? status.backend ?? ''}`}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
