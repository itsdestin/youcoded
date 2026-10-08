import React, { useEffect, useState } from 'react';
import { versionLine } from '../../app-version';
import { plainMessage } from '../../utils/ipc-error';
import { Button, Callout, CARD_LEVEL_1, Dialog, FoldRow, LoadingState, Pill, SectionLabel, SegmentedTabs, SettingRow, Textarea, TextInput, Toggle } from '../ui';
import type { PillTone } from '../ui/Pill';
import { useEscClose } from '../../hooks/use-esc-close';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
import { useNetworkOnline } from '../../hooks/useNetworkOnline';

// WHY a phase rather than a boolean: the flow stopped at draft -> review, so
// sending, sent and opened-in-GitHub had no surface at all. A failure is NOT a
// phase — it renders on the review step with the draft intact, which is what
// "your details stay in the draft and you can retry" actually requires.
type Phase = 'draft' | 'review' | 'sending' | 'sent' | 'opened' | 'handing-over' | 'handed-over';

// Carried over from the screen this replaces. The old flow's second action was
// "Let Claude Try to Fix It": set the workspace up, open a session, hand it the
// description. The approved design has no such action, so removing it would have
// deleted a working feature no deck asked to remove — it is kept, in the app's own
// words, and goes to Destin on the acceptance deck to keep, cut or redesign.
const HANDOVER_PROMPT = (kind: string, description: string, errorDetails: string) =>
  kind === 'bug'
    ? `I just filed (or am about to file) a bug against YouCoded. Here's what I described: «${description}». `
      // WHY (submit-ticket-2): the error used to reach the assistant only through the
      // description, pre-filled with "This happened in …". That pre-fill is gone (ST-13),
      // so the error details travel here instead, when the user left them ticked.
      + (errorDetails ? `The error details: «${errorDetails}». ` : '')
      + `Investigate the codebase in this workspace and propose a fix. Read \`docs/PITFALLS.md\` first, `
      + `and check both desktop and Android touchpoints if the bug could affect either.`
    : `I want to add a new feature to YouCoded. Here's what I'm asking for: «${description}». `
      + `Read \`docs/PITFALLS.md\`, then use the brainstorming skill to design it before writing code. `
      + `Both desktop and Android share the React UI — keep that in mind.`;

/**
 * What opened this report, when something failed (audit E-01). The old popup took
 * only open/close, so the failure being reported was gone the moment the user
 * clicked Report and they had to describe it from memory.
 *
 * `diagnose` is the "Diagnose with the assistant" entry: same screen, but it opens on the
 * review step with the AI disclosure already expanded, because that action promises
 * to hand the error to Claude. Without it, moving the AI call behind a disclosure
 * would have quietly turned Diagnose into a button that opens a blank form
 * (design review F11).
 */
export type ReportContext = { error?: string; surface?: string; diagnose?: boolean };

export function ReportDesign({ open, onClose, context }: { open: boolean; onClose: () => void; context?: ReportContext }) {
  useEscClose(open, onClose);
  // WHY: closing or going back must not discard a draft. Persistence beyond this mounted
  // component and real originating context remain unbuilt.
  const [kind, setKind] = useState('bug');
  const [phase, setPhase] = useState<Phase>(context?.diagnose ? 'review' : 'draft');
  const [title, setTitle] = useState('');
  // WHY never pre-filled (Destin, submit-ticket-1#ST-13: "it shouldn't fill text in the
  // description, but the error details checkbox should explain itself when it applies"):
  // where it happened and the error travel as the "The error you saw" choice instead.
  const [description, setDescription] = useState('');
  const [includeContext, setIncludeContext] = useState(true);
  const [logs, setLogs] = useState(false);
  const [logsBusy, setLogsBusy] = useState(false);
  const [logText, setLogText] = useState('');
  const [attachments, setAttachments] = useState(false);
  const [aiInfo, setAiInfo] = useState(!!context?.diagnose);
  const [error, setError] = useState('');
  // WHY which action failed is kept (submit-ticket-1): a failed hand-over used to be
  // headed "Your ticket wasn't sent" — about a ticket nobody had tried to send — and its
  // Retry SENT the ticket. Each failure now says what failed and retries that.
  const [errorFrom, setErrorFrom] = useState<'send' | 'handover'>('send');
  const [url, setUrl] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState('');
  const review = phase === 'review';
  const narrow = useNarrowViewport();
  // Read only to word a failed send: "no network" is said only when the computer itself
  // reports none (useNetworkOnline's rule) — never guessed from the error text.
  const online = useNetworkOnline();

  // WHY an effect and not only useState's first value (found shooting the practice states,
  // 2026-10-06): every caller keeps this popup MOUNTED and opens it by handing it a context,
  // so the initial values above ran at mount — before any error existed, and Diagnose
  // opened a blank draft instead of the review step it promises.
  useEffect(() => {
    if (context?.diagnose) { setPhase('review'); setAiInfo(true); }
  }, [context]);

  // The error details: only when this ticket was opened from an error (submit-ticket-1#ST-13 —
  // opened from Settings there is no error, so there is nothing to offer). Bug tickets only,
  // as before.
  const isBug = kind === 'bug';
  const errorDetails = [context?.surface && `This happened in ${context.surface}.`, context?.error].filter(Boolean).join('\n');
  const hasErrorDetails = isBug && !!errorDetails;
  const errorOn = hasErrorDetails && includeContext;

  // Reading them is what ticking the box means. It happens when they tick it, so the
  // text is on screen for review before the review step — never collected silently.
  const chooseLogs = async (on: boolean) => {
    setLogs(on);
    if (!on || logText) return;
    setLogsBusy(true);
    try {
      setLogText(await window.claude.dev.logTail(200));
    } catch (e: unknown) {
      setLogText('');
      setAiNote('');
      setError(plainMessage(e, 'The recent logs could not be read, so none are attached.'));
    } finally {
      setLogsBusy(false);
    }
  };

  const improve = async () => {
    setAiBusy(true);
    setAiNote('');
    try {
      const r = await window.claude.dev.summarizeIssue({
        kind, description,
        log: kind === 'bug' && logs ? logText : undefined,
      });
      if (r.assisted) {
        // Its words replace yours only when it actually produced some.
        if (r.title) setTitle(r.title);
        if (r.summary) setDescription(r.summary);
        setAiNote('Rewritten. Read it before you send it — the wording is the assistant’s, the ticket is yours.');
      } else {
        setAiNote(r.unavailable || 'Nothing rewrote it, so your wording is unchanged.');
      }
    } catch (e: unknown) {
      setAiNote(plainMessage(e, 'The assistant could not be reached, so your wording is unchanged.'));
    } finally {
      setAiBusy(false);
    }
  };

  const handOver = async () => {
    setError('');
    setPhase('handing-over');
    try {
      // The MANAGED setup, not the legacy fixed-folder installer the old screen
      // used: that one pulled into ~/youcoded-dev if it recognised it, which R9
      // forbids. Already set up? Reuse it rather than cloning a second copy.
      const status = await window.claude.dev.setupStatus();
      const ready = status.state === 'ready' && status.path
        ? { ok: true as const, path: status.path }
        : await window.claude.dev.setupWorkspace();
      if (!ready.ok) { setErrorFrom('handover'); setError(ready.error); setPhase('review'); return; }
      await window.claude.dev.openSessionIn({ cwd: ready.path, initialInput: HANDOVER_PROMPT(kind, description, errorOn ? errorDetails : '') });
      setPhase('handed-over');
    } catch (e: unknown) {
      setErrorFrom('handover');
      setError(plainMessage(e, 'A working copy could not be opened, so nothing was started.'));
      setPhase('review');
    }
  };

  const send = async () => {
    setError('');
    setErrorFrom('send');
    setTruncated(false);
    setPhase('sending');
    try {
      // WHY assembled here rather than typed into the box: the user's draft stays
      // their words, and what is attached is exactly what they reviewed under Error
      // details — nothing more, and nothing if they unticked it (R11).
      // WHY no version here any more (submit-ticket-1#ST-Q1, Destin: "we should always send
      // version. the box should just be for error details"): the main process stamps every
      // ticket with its Environment line (version and system) whatever is ticked, and the
      // review step now lists that line. Repeating it here only duplicated it.
      const evidence = errorOn ? `${description}\n\n---\n**Error details:**\n${errorDetails}` : description;
      const r = await window.claude.dev.submitIssue({
        kind, title, description: evidence,
        log: kind === 'bug' && logs ? logText : undefined,
        label: kind === 'bug' ? 'bug' : 'enhancement',
        // GitHub uploads a file the moment it is attached, so an attachment ticket
        // is finished in the browser and must not be created here first (R13/R14).
        browserOnly: attachments,
      });
      if (r.ok) { setUrl(r.url); setPhase('sent'); return; }
      if ('needsBrowser' in r) {
        // Not a failure: nobody is signed in, or this is the attachment route.
        setTruncated(r.truncated);
        setUrl(r.fallbackUrl);
        // WHY openExternal and not window.open: React runs under file:// on Android
        // and through the shim on remote, where window.open silently does nothing.
        // WHY it is AWAITED (UX review U1): it used to be `void`, so the screen said
        // "your ticket is open in your browser" without ever knowing whether a
        // browser opened — word for word the same sentence when every operation was
        // failing. A tester ran it with everything refusing and got the success
        // message. Now a refusal is a failure, with the draft still there.
        await window.claude.shell.openExternal(r.fallbackUrl);
        setPhase('opened');
        return;
      }
      // WHY: back to the review step, not to a dead end — every field the user
      // typed is still in state, so retrying costs nothing (audit E-02).
      setError(r.error);
      setPhase('review');
    } catch (e: unknown) {
      // WHY plainMessage (audit E-14/E-15): over remote access the bridge rejects
      // with `remote-unsupported: dev:submit-issue`, a channel name that means
      // nothing to anyone. This turns it into "Developer tools isn't available via
      // remote access yet." and strips Electron's wrapper on desktop. The helper
      // already existed and was adopted at four call sites out of the whole app.
      setError(plainMessage(e, 'Your ticket could not be sent.'));
      setPhase('review');
    }
  };


  const missing = !title.trim() || !description.trim();
  const sendLabel = attachments ? 'Continue in GitHub' : 'Submit public ticket';
  const backToDraft = () => { setError(''); setPhase('draft'); };
  const [openPiece, setOpenPiece] = useState<string | null>(null);
  const toggle = (id: string) => (on: boolean) => setOpenPiece(on ? id : null);

  // Two actions in a WIDE popup sit side by side, filled on the right; at phone width they
  // stack, filled on top (guide "Buttons"; approved here as submit-ticket-1#ST-4).
  const pair = (secondary: React.ReactNode, primary: React.ReactNode) => narrow
    ? <div className="flex flex-col gap-2">{primary}{secondary}</div>
    : <div data-parts-agree="ticket buttons" className="flex items-center justify-end gap-2">{secondary}{primary}</div>;
  const wide = narrow ? 'w-full py-2.5' : '';

  // ── One "include" choice ───────────────────────────────────────────────────
  // WHY a plain hint under every title, and no (i) (Destin, submit-ticket-1#ST-1 "the checkbox
  // ux is still odd", #ST-13 "should explain itself"; replaces signed R18). WHY a switch
  // (submit-ticket-2#ST2-C1 "switches"): the guide's setting row — title and hint left, the
  // app's switch at the right, vertically centred.
  const tick = (o: { title: string; hint: string; label: string; checked: boolean; onChange: (v: boolean) => void }) =>
    <SettingRow key={o.label} variant="item" title={o.title} description={o.hint}
      control={<Toggle aria-label={o.label} checked={o.checked} onChange={o.onChange} />} />;

  // WHY the files notice stays (R14): GitHub uploads a file the moment it is attached.
  const filesNotice = <Callout>GitHub uploads a file as soon as you attach it — before you submit the issue — so check and crop it first. You attach files yourself in your browser; nothing is uploaded from here.</Callout>;

  // ── Draft ────────────────────────────────────────────────────────────────
  const ticketCard = <section>
    <SectionLabel className="mb-2">Your ticket</SectionLabel>
    <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
      <SegmentedTabs aria-label="Report type" variant="contained" value={kind} onChange={setKind} tabs={[{ id: 'bug', label: 'Bug' }, { id: 'feature', label: 'Feature' }]} />
      <div className="space-y-2">
        <label htmlFor="report-title" className="block text-xs text-fg-2">Title</label>
        <TextInput id="report-title" className="w-full" value={title} onChange={e => setTitle(e.target.value)} placeholder="A short summary" />
        <label htmlFor="report-description" className="block text-xs text-fg-2">Description</label>
        <Textarea id="report-description" className="w-full h-28" value={description} onChange={e => setDescription(e.target.value)} placeholder={isBug ? 'What happened? What did you expect? What steps caused it?' : 'What would you like to do, and how would it help?'} />
      </div>
      {/* The public line and the reason the button is grey, at the card's foot (ST-1 round 1). */}
      <p className="text-2xs text-fg-2">Tickets are public on GitHub, where anyone can read them.{missing && ' Add a title and a description to carry on.'}</p>
    </div>
  </section>;

  const includeCard = <section>
    <SectionLabel className="mb-2">Include with ticket</SectionLabel>
    <div className={`${CARD_LEVEL_1} p-3 space-y-2`}>
      {hasErrorDetails && tick({
        title: 'The error you saw', label: 'Include error details', checked: includeContext, onChange: setIncludeContext,
        hint: context?.error ? `Adds where it happened (${context.surface ?? 'this screen'}) and the error message.` : `Adds where it happened (${context?.surface}).`,
      })}
      {isBug && tick({
        title: 'Recent logs', label: 'Include recent logs', checked: logs, onChange: chooseLogs,
        hint: 'The app’s last 200 lines of activity. You can read them, and remove anything private, before sending.',
      })}
      {tick({
        title: 'Screenshots or files', label: 'Finish with attachments in GitHub', checked: attachments, onChange: setAttachments,
        hint: 'You finish the ticket in your browser and attach them there.',
      })}
      {attachments && filesNotice}
    </div>
  </section>;

  // ── Review ───────────────────────────────────────────────────────────────
  // The ticket as it will read (approved, submit-ticket-1#ST-2). The same card carries the
  // outcome afterwards: a status pill beside the kind and one line at its foot (ST2-3) —
  // the "middle" between round 1's bare text and round 1's separate result card.
  const summaryCard = (status?: { tone: PillTone; text: string }, foot?: React.ReactNode) => <section>
    <SectionLabel className="mb-2">Your ticket</SectionLabel>
    <div className={`${CARD_LEVEL_1} p-3 space-y-1.5`}>
      <div data-centres-agree="ticket title" className="flex items-center gap-2 min-w-0 flex-wrap">
        <span className="text-sm font-medium text-fg min-w-0 break-words">{title.trim() || 'No title yet'}</span>
        <Pill tone="info">{isBug ? 'Bug' : 'Feature'}</Pill>
        {status && <Pill tone={status.tone}>{status.text}</Pill>}
      </div>
      <p className="text-xs text-fg-2 whitespace-pre-wrap break-words">{description.trim() || 'No description yet.'}</p>
      <div className="text-2xs text-fg-muted pt-1 space-y-1">{foot ?? <p>This ticket will be public on GitHub.</p>}</div>
    </div>
  </section>;

  const logLines = logText ? logText.split('\n').filter(Boolean).length : 0;
  // Folded rows, picked on submit-ticket-1#ST-C1 ("folded"). Each opens INSIDE its own box
  // (the shared FoldRow, which opens inside its box since Destin's ST-3).
  const sentWithIt = <section>
    <SectionLabel className="mb-2">Sent with it</SectionLabel>
    <div className={`${CARD_LEVEL_1} p-3 space-y-2`}>
      {/* WHY always listed (submit-ticket-1#ST-Q1, "show"): every ticket carries the app
          version and system, whatever is ticked, so the review says so. The main process
          writes that line with the system's release number too (dev-tools.ts). */}
      <SettingRow variant="item" title="App version and system" description={`${versionLine()} — always sent, so maintainers know what you’re running`} />
      {errorOn && <FoldRow title="The error you saw" description={context?.surface ? `From ${context.surface}` : 'The error message'} open={openPiece === 'error'} onToggle={toggle('error')}>
        <p className="text-xs text-fg-2 font-mono whitespace-pre-wrap break-all">{errorDetails}</p>
      </FoldRow>}
      {isBug && logs && <FoldRow title="Recent logs" description={logsBusy ? 'Reading recent logs…' : logLines ? `${logLines} lines — open to read or remove anything private` : 'No recent log lines were found.'} open={openPiece === 'logs'} onToggle={toggle('logs')}>
        {/* WHY filled by logTail (code review C5): the box once collected nothing at all. */}
        <Textarea id="report-logs" aria-label="Logs to review" className="w-full h-24" value={logText} onChange={e => setLogText(e.target.value)} placeholder={logsBusy ? 'Reading recent logs…' : 'No recent log lines were found.'} />
      </FoldRow>}
      {attachments && filesNotice}
    </div>
  </section>;

  // AI help: still only on the review step, folded (R17). WHY its rows sit INSIDE the folded
  // card (Destin, submit-ticket-1#ST-3: "an expandable card should always contain expanded
  // content within itself, not open a new separate card below").
  // WHY the plain words for the hand-over (ST-7, ST-11: "what does that even mean", "unclear"):
  // "a working copy" meant nothing to him; it is YouCoded's code, downloaded to this computer.
  const aiHelp = <FoldRow title="Optional AI help" open={aiInfo} onToggle={setAiInfo}>
    <div className="space-y-2">
      <p className="text-xs text-fg-2">Only this ticket and what you chose to include go to your assistant. Nothing is sent automatically; it uses your plan.</p>
      {/* WHY a note when nothing rewrote it (design review F17): never a silent no-op. */}
      {aiNote && <p className="text-xs text-fg-2">{aiNote}</p>}
      <SettingRow variant="item" title="Improve the wording" description="Rewrites your title and description. You read it before sending."
        control={<Button size="sm" variant="secondary" aria-label="Improve wording with the assistant" disabled={aiBusy} onClick={improve}>{aiBusy ? 'Rewriting…' : 'Rewrite'}</Button>} />
      <SettingRow variant="item" title={isBug ? 'Let your assistant try to fix it' : 'Let your assistant try to build it'}
        description="Downloads YouCoded’s code to this computer and starts a new conversation that works on it. Uses a lot of your plan."
        control={<Button size="sm" variant="secondary" aria-label={isBug ? 'Let your assistant try to fix it' : 'Let your assistant try to build it'} disabled={!description.trim()} onClick={handOver}>Start</Button>} />
    </div>
  </FoldRow>;

  // A failed action REPLACES the buttons it came from (approved, submit-ticket-1#ST-5/ST-6).
  const failure = error && <Callout tone={online || errorFrom === 'handover' ? 'danger' : 'warning'} actionsPlacement="below"
    actions={<>
      <Button size="sm" variant="secondary" onClick={backToDraft}>Back to draft</Button>
      <Button size="sm" onClick={errorFrom === 'send' ? send : handOver}>Try again</Button>
    </>}>
    {errorFrom === 'handover'
      ? <>YouCoded’s code couldn’t be downloaded, so your assistant didn’t start. {error} Your ticket hasn’t been sent.</>
      : online
        ? <>Your ticket wasn’t sent. {error} Your draft is still here.</>
        : <>This computer isn’t connected to a network, so your ticket wasn’t sent. Your draft is still here.</>}
  </Callout>;

  const sendButtons = failure || pair(
    <Button variant="secondary" className={wide} onClick={backToDraft}>Back to draft</Button>,
    <Button className={wide} disabled={missing} onClick={send}>{sendLabel}</Button>,
  );

  // A wait sits where the buttons were, in the approved card (submit-ticket-1#ST-10).
  const waiting = (what: React.ReactNode, hint?: string) => <div className={`${CARD_LEVEL_1} p-3 space-y-1`}>
    {what}
    {hint && <p className="text-xs text-fg-2">{hint}</p>}
  </div>;
  const openTicket = () => void window.claude.shell.openExternal(url);

  return <Dialog screen="settings/development/bug-report" open={open} onClose={onClose} size="document" title="Submit a ticket">
    <div className="space-y-4">{/* WHY no p-4: the Dialog body already pads 16px (doubled margins, 2026-09-28) */}

      {phase === 'draft' && <>
        {ticketCard}
        {includeCard}
        {/* A lone main action is full width (R20; guide "One button"). */}
        <Button className="w-full py-2.5" disabled={missing} onClick={() => setPhase('review')}>Review ticket</Button>
      </>}

      {review && <>
        {summaryCard()}
        {sentWithIt}
        {aiHelp}
        {sendButtons}
      </>}

      {/* WHY only a box under the label (Destin, submit-ticket-2#ST2-10: "bare sending your
          ticket box under your ticket header, gets replaced with the submission summary when
          done"): the ticket card and a second sending card read as two things at once. */}
      {phase === 'sending' && <section>
        <SectionLabel className="mb-2">Your ticket</SectionLabel>
        {waiting(<LoadingState verb="Sending" what="your ticket" variant="inline" />)}
      </section>}

      {phase === 'sent' && <>
        {summaryCard({ tone: 'ok', text: 'Submitted' },
          <p>Submitted to GitHub, where anyone can read it. Maintainers decide what happens next.</p>)}
        {/* WHY a button and not the raw address (UX review U16). */}
        {pair(<Button variant="secondary" className={wide} onClick={onClose}>Done</Button>,
          <Button className={wide} onClick={openTicket}>Open my ticket</Button>)}
      </>}

      {phase === 'opened' && <>
        {summaryCard({ tone: 'info', text: 'Finish in GitHub' }, <>
          {/* WHY: the approved attachment route — nothing is submitted here (R13). */}
          <p>It’s open in your browser with everything you wrote. Attach your screenshots or files there, then submit it.</p>
          {/* WHY (audit E-07): the prefilled link has a length limit; say when it cut. */}
          {truncated && <p>It was too long for a browser link, so part of the details was left out. Paste anything missing before you submit.</p>}
        </>)}
        {/* WHY the way back in (UX review U1). */}
        {pair(<Button variant="secondary" className={wide} onClick={onClose}>Done</Button>,
          // "Open in browser": Destin's words (submit-ticket-2#ST2-6 "Open in Browser"), in
          // the app's sentence case (decisions "Sentence case everywhere").
          <Button className={wide} onClick={openTicket}>Open in browser</Button>)}
      </>}

      {phase === 'handing-over' && <>
        {summaryCard({ tone: 'neutral', text: 'Not sent' })}
        {waiting(<LoadingState verb="Downloading" what="YouCoded’s code for your assistant" variant="inline" />,
          'This can take a few minutes the first time. Your ticket hasn’t been sent.')}
      </>}

      {phase === 'handed-over' && <>
        {summaryCard({ tone: 'neutral', text: 'Not sent' },
          <p>Your assistant is working on a fix in a new conversation. Nothing was sent to GitHub — you can still send this ticket.</p>)}
        {/* WHY a pair, with Submit (submit-ticket-2): every other outcome ends in the same two
            buttons at the right; and the ticket is still unsent here, so sending it is the
            obvious next step — it used to mean closing, reopening and starting over. */}
        {pair(<Button variant="secondary" className={wide} onClick={onClose}>Done</Button>,
          <Button className={wide} disabled={missing} onClick={send}>{sendLabel}</Button>)}
      </>}

    </div>
  </Dialog>;
}
