import React, { useEffect, useState } from 'react';
import { versionLine } from '../../app-version';
import { plainMessage } from '../../utils/ipc-error';
import { AnchorTip, Button, Callout, CARD_LEVEL_1, Checkbox, Dialog, FoldRow, LoadingState, Pill, SectionLabel, SegmentedTabs, SettingRow, Textarea, TextInput } from '../ui';
import { useEscClose } from '../../hooks/use-esc-close';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
import { useNetworkOnline } from '../../hooks/useNetworkOnline';
import { workbenchTicketReview } from '../../ticket-practice';

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
const HANDOVER_PROMPT = (kind: string, description: string) =>
  kind === 'bug'
    ? `I just filed (or am about to file) a bug against YouCoded. Here's what I described: «${description}». `
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
  const [description, setDescription] = useState(
    // Seeded, not locked: it is the user's ticket, so the surface is a starting
    // point they can rewrite. The error itself is shown separately, under Error
    // details, where they can review it before it is sent (R11).
    context?.surface ? `This happened in ${context.surface}.\n\n` : '',
  );
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
  const design = workbenchTicketReview();
  const narrow = useNarrowViewport();
  // Read only to word a failed send: "no network" is said only when the computer itself
  // reports none (useNetworkOnline's rule) — never guessed from the error text.
  const online = useNetworkOnline();

  // WHY an effect and not only useState's first value (found shooting the practice states,
  // 2026-10-06): every caller keeps this popup MOUNTED and opens it by handing it a context,
  // so the initial values above ran at mount — before any error existed. "This happened in
  // Office." never reached a real user, and Diagnose opened a blank draft instead of the
  // review step it promises. Each new context now applies once; typed words are never
  // replaced (the seed only fills an empty description).
  useEffect(() => {
    if (!context) return;
    if (context.surface) setDescription(d => (d.trim() ? d : `This happened in ${context.surface}.\n\n`));
    if (context.diagnose) { setPhase('review'); setAiInfo(true); }
  }, [context]);

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
      await window.claude.dev.openSessionIn({ cwd: ready.path, initialInput: HANDOVER_PROMPT(kind, description) });
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
      const evidence = kind === 'bug' && includeContext
        ? `${description}\n\n---\n${versionLine()}${context?.error ? `\n${context.error}` : ''}`
        : description;
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

  const isBug = kind === 'bug';
  const missing = !title.trim() || !description.trim();
  const onePage = design === 'onepage';
  const sendLabel = attachments ? 'Continue in GitHub' : 'Submit public ticket';
  const backToDraft = () => { setError(''); setPhase('draft'); };

  // ── The pieces that go with the ticket, each with its content ─────────────────
  // WHY one list feeds all three drafts: what is sent must read the same whichever way
  // it is laid out — the drafts differ only in how much of it is open at once.
  const versionPiece = isBug && includeContext ? {
    id: 'version', title: 'Error details and version',
    summary: versionLine(),
    body: <>
      {/* WHY the real version (R22): this was a hardcoded string once. */}
      <p className="text-xs text-fg-2 font-mono">{versionLine()}</p>
      {/* The originating error, shown before anything is sent — never attached
          to a ticket the user has not seen (R11). */}
      {context?.error && <p className="text-xs text-fg-2 font-mono break-all mt-1">{context.error}</p>}
    </>,
  } : null;
  const logLines = logText ? logText.split('\n').filter(Boolean).length : 0;
  const logsPiece = isBug && logs ? {
    id: 'logs', title: 'Recent logs',
    summary: logsBusy ? 'Reading recent logs…' : logLines ? `${logLines} lines — remove anything private` : 'No recent log lines were found.',
    body: <>
      <p className="text-2xs text-fg-2 mb-2">Remove private details before sharing.</p>
      {/* WHY filled by logTail (code review C5): the box once collected nothing at all. */}
      <Textarea id="report-logs" aria-label="Logs to review" className="w-full h-24" value={logText} onChange={e => setLogText(e.target.value)} placeholder={logsBusy ? 'Reading recent logs…' : 'No recent log lines were found.'} />
    </>,
  } : null;
  // WHY the files piece says where they go (UX review U4, R13/R14): GitHub uploads a file
  // the moment it is attached, so attaching happens in the browser, after this screen.
  const filesNotice = <Callout>Review and crop files before attaching them. GitHub uploads a file as soon as you attach it — before you submit the issue. You’ll attach approved files yourself in the browser; nothing is uploaded here.</Callout>;
  const pieces = [versionPiece, logsPiece].filter(Boolean) as { id: string; title: string; summary: string; body: React.ReactNode }[];

  // Two actions in a WIDE popup sit side by side, filled on the right; at phone width they
  // stack, filled on top (guide "Buttons"; decisions BP-1, BW-2). This popup is 600px.
  const pair = (secondary: React.ReactNode, primary: React.ReactNode) => narrow
    ? <div className="flex flex-col gap-2">{primary}{secondary}</div>
    : <div data-parts-agree="ticket buttons" className="flex items-center justify-end gap-2">{secondary}{primary}</div>;

  // ── Draft ────────────────────────────────────────────────────────────────
  const ticketCard = <section>
    <SectionLabel className="mb-2">Your ticket</SectionLabel>
    {/* WHY the kind switch leads the card (submit-ticket-1): it decides the placeholder
        and which details can go with it, so it comes before the fields it changes. The
        public-ticket sentence moved from a tiny line ABOVE the switch to the card's foot,
        joined by the reason the button is inactive (U13) — one grey line, inside the card
        it is about, instead of two loose lines (guide "Text that describes a card lives
        inside it"). */}
    <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
      <SegmentedTabs aria-label="Report type" variant="contained" value={kind} onChange={setKind} tabs={[{ id: 'bug', label: 'Bug' }, { id: 'feature', label: 'Feature' }]} />
      <div className="space-y-2">
        <label htmlFor="report-title" className="block text-xs text-fg-2">Title</label>
        <TextInput id="report-title" className="w-full" value={title} onChange={e => setTitle(e.target.value)} placeholder="A short summary" />
        <label htmlFor="report-description" className="block text-xs text-fg-2">Description</label>
        <Textarea id="report-description" className="w-full h-28" value={description} onChange={e => setDescription(e.target.value)} placeholder={isBug ? 'What happened? What did you expect? What steps caused it?' : 'What would you like to do, and how would it help?'} />
      </div>
      <p className="text-2xs text-fg-2">Tickets are public on GitHub, where anyone can read them.{missing && ' Add a title and a description to carry on.'}</p>
    </div>
  </section>;

  // On the one-page draft, what a tick adds opens right under its row (nested look).
  const opened = (piece: typeof versionPiece) => onePage && piece
    ? <div className="px-3">{piece.body}</div> : null;
  const includeCard = <section>
    <SectionLabel className="mb-2">Include with ticket</SectionLabel>
    {/* variant="item": choices, so the list size, like Sound's. The three rows and their (i)
        explanations are signed (R18) and unchanged. */}
    <div className={`${CARD_LEVEL_1} p-3 space-y-2`}>
      {isBug && <>
        <SettingRow variant="item" title="Error details and version" control={<Checkbox aria-label="Include error details and YouCoded version" checked={includeContext} onChange={setIncludeContext} />} accessory={<AnchorTip label="About error details">Only the originating error and app version, not your conversation. You’ll review these before sharing.</AnchorTip>} />
        {opened(versionPiece)}
        <SettingRow variant="item" title="Recent logs" control={<Checkbox aria-label="Include recent logs" checked={logs} onChange={chooseLogs} />} accessory={<AnchorTip label="About recent logs">Logs record app activity and errors. They may contain private information. Review and remove private details before sharing.</AnchorTip>} />
        {opened(logsPiece)}
      </>}
      <SettingRow variant="item" title="Screenshots or files" control={<Checkbox aria-label="Finish with attachments in GitHub" checked={attachments} onChange={setAttachments} />} accessory={<AnchorTip label="About attachments">Ticking this finishes your ticket in your browser, where you attach the files yourself. They cannot be attached here: GitHub uploads a file the moment it is attached, so it has to happen where you can see it.</AnchorTip>} />
      {/* WHY inside the card, under its row (guide: a notice about one thing sits inside
          that thing): it floated between the card and the button before. */}
      {attachments && filesNotice}
    </div>
  </section>;

  // ── Review ───────────────────────────────────────────────────────────────
  // WHY read-only (submit-ticket-1, "what's odd" #6): the review step used to be the draft
  // again — the same two editable boxes under a new label, with the Bug/Feature choice
  // gone — so it was not clear what had changed or what was being reviewed. It now shows
  // the ticket as it will read, and Back to draft is the one way to change it.
  const summaryCard = <section>
    <SectionLabel className="mb-2">Your ticket</SectionLabel>
    <div className={`${CARD_LEVEL_1} p-3 space-y-1.5`}>
      <div data-centres-agree="ticket title" className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium text-fg min-w-0 break-words">{title.trim() || 'No title yet'}</span>
        <Pill tone="info">{isBug ? 'Bug' : 'Feature'}</Pill>
      </div>
      <p className="text-xs text-fg-2 whitespace-pre-wrap break-words">{description.trim() || 'No description yet.'}</p>
      <p className="text-2xs text-fg-muted pt-1">This ticket will be public on GitHub.</p>
    </div>
  </section>;

  const sentWithIt = <section>
    <SectionLabel className="mb-2">Sent with it</SectionLabel>
    <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
      {pieces.length === 0 && !attachments && <p className="text-xs text-fg-2">Nothing else — only your title and description.</p>}
      {design === 'folded'
        ? pieces.map(p => <FoldRow key={p.id} title={p.title} description={p.summary}>{p.body}</FoldRow>)
        : pieces.map(p => <div key={p.id}>
            <p className="text-xs font-medium text-fg mb-1">{p.title}</p>
            {p.body}
          </div>)}
      {attachments && filesNotice}
    </div>
  </section>;

  // AI help: still only on the review step, behind a fold you open (R17). Each action is
  // one row — what it does on the left, its button on the right — instead of two full-width
  // outlined buttons and an 11px caption under the second.
  const aiHelp = <FoldRow title="Optional AI help" open={aiInfo} onToggle={setAiInfo}>
    <div className={`${CARD_LEVEL_1} p-3 space-y-2`}>
      <p className="text-xs text-fg-2">Only this draft and selected details go to your chosen assistant. Review them first. Nothing is sent automatically; provider usage may apply.</p>
      {/* WHY a note when nothing rewrote it (design review F17): never a silent no-op. */}
      {aiNote && <p className="text-xs text-fg-2">{aiNote}</p>}
      <SettingRow variant="item" title="Improve the wording" description="Rewrites your title and description; you read it before sending."
        control={<Button size="sm" variant="secondary" aria-label="Improve wording with the assistant" disabled={aiBusy} onClick={improve}>{aiBusy ? 'Rewriting…' : 'Rewrite'}</Button>} />
      {/* Carried over from the old screen (grader, 2026-09-10): kept behind this fold so the
          footer stays two buttons (R21) and AI help stays here (R17). */}
      <SettingRow variant="item" title={isBug ? 'Let your assistant try to fix it' : 'Let your assistant try to build it'}
        description="Opens a new session in a working copy. Uses a lot of your model allowance — not for smaller plans."
        control={<Button size="sm" variant="secondary" aria-label={isBug ? 'Let your assistant try to fix it' : 'Let your assistant try to build it'} disabled={!description.trim()} onClick={handOver}>Start</Button>} />
    </div>
  </FoldRow>;

  // A failed send REPLACES the buttons it came from (guide "A problem replaces the card it
  // is about"; notices carry their own buttons, at the right). The draft is untouched (R23).
  // WHY no title and no red words (decisions "Error notices: no red titles"): one sentence,
  // the reason the operation gave, never a guessed cause (error-message standards).
  const failure = error && <Callout tone={online ? 'danger' : 'warning'} actionsPlacement="below"
    actions={<>
      <Button size="sm" variant="secondary" onClick={backToDraft}>Back to draft</Button>
      <Button size="sm" onClick={errorFrom === 'send' ? send : handOver}>Try again</Button>
    </>}>
    {errorFrom === 'handover'
      ? <>A working copy couldn’t be set up, so nothing was started. {error} Your ticket was not sent.</>
      : online
        ? <>Your ticket wasn’t sent. {error} Your draft is still here.</>
        : <>This computer isn’t connected to a network, so your ticket wasn’t sent. Your draft is still here.</>}
  </Callout>;

  const sendButtons = failure || pair(
    <Button variant="secondary" className={narrow ? 'w-full py-2.5' : ''} onClick={backToDraft}>Back to draft</Button>,
    <Button className={narrow ? 'w-full py-2.5' : ''} disabled={missing} onClick={send}>{sendLabel}</Button>,
  );

  // One card for an outcome: what happened, what it means, its buttons under it. A single
  // card needs no label (guide "A label comes first" — single-card popups).
  const outcome = (head: string | null, hint: React.ReactNode, buttons?: React.ReactNode) =>
    <div className={`${CARD_LEVEL_1} p-3 space-y-1`}>
      {head && <p className="text-sm text-fg">{head}</p>}
      {hint}
      {buttons && <div className="pt-2">{buttons}</div>}
    </div>;
  // Two outcome buttons share the card's width: side by side (filled right), or stacked
  // (filled on top) at phone width — the guide's "when they must stack … full width".
  const shared = (secondary: React.ReactNode, primary: React.ReactNode) => narrow
    ? <div className="flex flex-col gap-2">{primary}{secondary}</div>
    : <div data-parts-agree="outcome buttons" className="flex gap-2 [&>*]:flex-1">{secondary}{primary}</div>;

  return <Dialog screen="settings/development/bug-report" open={open} onClose={onClose} size="document" title="Submit a ticket">
    <div className="space-y-4">{/* WHY no p-4: the Dialog body already pads 16px (doubled margins, 2026-09-28) */}

      {phase === 'sending' && outcome(null, <LoadingState verb="Sending" what="your ticket" variant="inline" />)}

      {phase === 'handing-over' && outcome(null,
        <>
          <LoadingState verb="Setting up" what="a working copy to try this in" variant="inline" />
          <p className="text-xs text-fg-2">This can take a few minutes the first time. Your ticket is not sent — this is a separate attempt to fix it.</p>
        </>)}

      {phase === 'handed-over' && outcome('Your assistant is on it, in a new session.',
        <p className="text-xs text-fg-2">Nothing was sent to GitHub. If the fix works, you can propose it from that session; if it doesn’t, come back and submit the ticket instead.</p>,
        <Button className="w-full py-2.5" onClick={onClose}>Done</Button>)}

      {phase === 'sent' && outcome('Your ticket is submitted.',
        <p className="text-xs text-fg-2">Anyone can read it, and maintainers decide what happens next.</p>,
        // WHY a button and not the raw address (UX review U16).
        shared(<Button variant="secondary" className="py-2.5" onClick={onClose}>Done</Button>,
          <Button className="py-2.5" onClick={() => void window.claude.shell.openExternal(url)}>Open my ticket</Button>))}

      {phase === 'opened' && outcome('Finish your ticket in GitHub.',
        <>
          {/* WHY: the approved attachment route — nothing is submitted here (R13). */}
          <p className="text-xs text-fg-2">Your ticket is open in your browser with everything you wrote. Attach your screenshots or files there, then submit it.</p>
          {/* WHY (audit E-07): the prefilled link has a length limit; say when it cut. */}
          {truncated && <p className="text-xs text-fg-2">It was too long for a browser link, so part of the details was left out. Paste anything missing from your draft before you submit.</p>}
        </>,
        // WHY the way back in (UX review U1).
        shared(<Button variant="secondary" className="py-2.5" onClick={() => void window.claude.shell.openExternal(url)}>Open it again</Button>,
          <Button className="py-2.5" onClick={onClose}>Done</Button>))}

      {(phase === 'draft' || (review && onePage)) && <>
        {ticketCard}
        {includeCard}
        {onePage ? <>
          {aiHelp}
          {sendButtons}
        </> : (
          // A lone main action is full width (R20; guide "One button").
          <Button className="w-full py-2.5" disabled={missing} onClick={() => setPhase('review')}>Review ticket</Button>
        )}
      </>}

      {review && !onePage && <>
        {summaryCard}
        {sentWithIt}
        {aiHelp}
        {sendButtons}
      </>}

    </div>
  </Dialog>;
}
