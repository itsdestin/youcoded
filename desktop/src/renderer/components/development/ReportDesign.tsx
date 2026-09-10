import { useState } from 'react';
import { versionLine } from '../../app-version';
import { plainMessage } from '../../utils/ipc-error';
import { AnchorTip, Button, Callout, Checkbox, Dialog, ErrorState, LoadingState, SegmentedTabs, SettingRow, Textarea, TextInput } from '../ui';
import { useEscClose } from '../../hooks/use-esc-close';

// WHY a phase rather than a boolean: the flow stopped at draft -> review, so
// sending, sent and opened-in-GitHub had no surface at all. A failure is NOT a
// phase — it renders on the review step with the draft intact, which is what
// "your details stay in the draft and you can retry" actually requires.
type Phase = 'draft' | 'review' | 'sending' | 'sent' | 'opened';

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
  const [url, setUrl] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState('');
  const review = phase === 'review';

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

  const send = async () => {
    setError('');
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

  return <Dialog open={open} onClose={onClose} size="document" title="Submit a ticket">
    <div className="p-4 space-y-4">

      {phase === 'sending' && <LoadingState verb="Sending" what="your ticket" />}

      {phase === 'sent' && <>
        <p className="text-sm text-fg">Your ticket is submitted.</p>
        <p className="text-xs text-fg-2">Anyone can read it, and maintainers decide what happens next.</p>
        {/* WHY a button and not the raw address (UX review U16): a bare
            https://github.com/… line is something to squint at, not something to
            press, and on Android a plain <a target=_blank> does nothing at all. */}
        <Button className="w-full py-2.5" onClick={() => void window.claude.shell.openExternal(url)}>Open my ticket</Button>
        <Button variant="secondary" className="w-full py-2.5" onClick={onClose}>Done</Button>
      </>}

      {phase === 'opened' && <>
        <p className="text-sm text-fg">Finish your ticket in GitHub.</p>
        {/* WHY: this is the approved attachment route — the ticket is not submitted
            here, because GitHub uploads a file the moment it is attached. Saying so
            is the difference between a hand-off and a silent failure. */}
        <p className="text-xs text-fg-2">Your ticket is open in your browser with everything you wrote. Attach your screenshots or files there, then submit it.</p>
        {/* WHY this line exists (audit E-07): the prefilled link has a length limit, and
            the old code shortened the body to fit without telling anyone — evidence went
            missing between here and GitHub with nothing said. */}
        {truncated && <p className="text-xs text-fg-2">It was too long for a browser link, so part of the details was left out. Paste anything missing from your draft before you submit.</p>}
        {/* WHY the link is here (UX review U1): the screen described something
            happening somewhere the user cannot see, with nothing to press if it did
            not. This is the way back in. */}
        <Button variant="secondary" className="w-full py-2.5" onClick={() => void window.claude.shell.openExternal(url)}>Open it again</Button>
        <Button className="w-full py-2.5" onClick={onClose}>Done</Button>
      </>}

      {(phase === 'draft' || phase === 'review') && <>
        {/* WHY: the failure sits above the draft it belongs to, and the draft is
            still here — R23. A separate failure screen would have to either carry
            the draft or throw it away. */}
        {error && <ErrorState
          title="Your ticket wasn’t sent"
          explainer={error}
          onRetry={send}
        />}
        <p className="text-sm text-fg-2">Tickets are public on GitHub. Review details before sharing.</p>
        {!review && <SegmentedTabs aria-label="Report type" variant="contained" value={kind} onChange={setKind} tabs={[{ id: 'bug', label: 'Bug' }, { id: 'feature', label: 'Feature' }]} />}
        {/* WHY: one noun for one object. The flow previously said ticket, report, bug report and
            issue for the same thing across four controls, which reads as four different actions. */}
        {review && <h3 className="text-2xs uppercase tracking-wide text-fg-muted">Review your ticket</h3>}
        <div className="space-y-2">
          <label htmlFor="report-title" className="block text-xs text-fg-2">Title</label>
          <TextInput id="report-title" className="w-full" value={title} onChange={e => setTitle(e.target.value)} placeholder="A short summary" />
          <label htmlFor="report-description" className="block text-xs text-fg-2">Description</label>
          <Textarea id="report-description" className="w-full h-28" value={description} onChange={e => setDescription(e.target.value)} placeholder={kind === 'bug' ? 'What happened? What did you expect? What steps caused it?' : 'What would you like to do, and how would it help?'} />
        </div>
        {/* WHY: separate choosing evidence from reviewing its content; don't stack a full
            editor and explanatory paragraphs between every compact selection row. */}
        {!review ? <section className="space-y-2">
          <h3 className="text-2xs uppercase tracking-wide text-fg-muted">Include with ticket</h3>
          {kind === 'bug' && <>
            <SettingRow title="Error details and version" control={<Checkbox aria-label="Include error details and YouCoded version" checked={includeContext} onChange={setIncludeContext} />} accessory={<AnchorTip label="About error details">Only the originating error and app version, not your conversation. You’ll review these before sharing.</AnchorTip>} />
            <SettingRow title="Recent logs" control={<Checkbox aria-label="Include recent logs" checked={logs} onChange={chooseLogs} />} accessory={<AnchorTip label="About recent logs">Logs record app activity and errors. They may contain private information. Review and remove private details before sharing.</AnchorTip>} />
          </>}
          {/* WHY the row says where it ends up (UX review U4): ticking it opened no
              file picker, and quietly changed the send button from "Submit public
              ticket" to "Continue in GitHub" — a tester could not tell what had
              happened or why. Files cannot be attached here at all: GitHub uploads a
              file the moment it is attached, so that step is theirs. */}
          <SettingRow title="Screenshots or files" description="Finish this ticket in your browser, where you can attach them" control={<Checkbox aria-label="Finish with attachments in GitHub" checked={attachments} onChange={setAttachments} />} accessory={<AnchorTip label="About attachments">You attach files in GitHub, not here — GitHub uploads a file as soon as you attach it, so it has to happen where you can see it.</AnchorTip>} />
        </section> : <section className="space-y-3">
          {kind === 'bug' && includeContext && <div className="space-y-1">
            <h3 className="text-2xs uppercase tracking-wide text-fg-muted">Error details and version</h3>
            {/* WHY the real version (R22): this was a hardcoded string, so the one
                thing the ticket promised to carry accurately was made up. */}
            <p className="text-xs text-fg-2 font-mono">{versionLine()}</p>
            {/* The originating error, shown before anything is sent — never attached
                to a ticket the user has not seen (R11). */}
            {context?.error && <p className="text-xs text-fg-2 font-mono break-all">{context.error}</p>}
          </div>}
          {/* WHY: both evidence blocks read as one pattern — section label, one line of
              explanation, then the content. A bare inline label made them look unrelated. */}
          {kind === 'bug' && logs && <div className="space-y-1">
            <h3 className="text-2xs uppercase tracking-wide text-fg-muted">Recent logs</h3>
            <p className="text-xs text-fg-2">Remove private details before sharing.</p>
            {/* WHY this is filled by logTail (code review C5): ticking "Recent logs"
                used to collect nothing at all, and the empty box explained itself with
                "Sample text only — no logs collected" — a mockup caption on a shipped
                screen, which R21 forbids, telling the user their choice had no effect. */}
            <Textarea id="report-logs" aria-label="Logs to review" className="w-full h-24 mt-2" value={logText} onChange={e => setLogText(e.target.value)} placeholder={logsBusy ? 'Reading recent logs…' : 'No recent log lines were found.'} />
          </div>}
        </section>}
        {attachments && <Callout>Review and crop files before attaching them. GitHub uploads a file as soon as you attach it — before you submit the issue. You’ll attach approved files yourself in the browser; nothing is uploaded here.</Callout>}
        {review ? <>
          <SettingRow title="Optional AI help" expanded={aiInfo} onClick={() => setAiInfo(!aiInfo)} />
          {aiInfo && <div className="px-3 space-y-2">
            <p className="text-sm text-fg-2">Only this draft and selected details go to your chosen assistant. Review them first. Nothing is sent automatically; provider usage may apply.</p>
            {/* WHY this reports doing nothing: the assistant call falls back to the
                user's OWN words when nothing is available to ask, which on a native
                session is the normal case. Presenting that as a result would be a
                button that silently does nothing (design review F17). */}
            {aiNote && <p className="text-xs text-fg-2">{aiNote}</p>}
            <Button variant="secondary" className="w-full py-2.5" disabled={aiBusy} onClick={improve}>
              {aiBusy ? 'Rewriting…' : 'Improve wording with the assistant'}
            </Button>
          </div>}
          {/* WHY: the app's dialogs stack full-width actions (see the legacy ContributePopup and
              BugReportPopup) — primary on top, secondary under it. Chip-sized right-aligned
              buttons were this mockup's own invention and read as a different app. */}
          {/* WHY the submit button goes away while an error is showing: Retry inside
              the error and "Submit public ticket" below it are the same action written
              twice, which reads as two different things to try. The error owns the
              retry; the footer keeps only the way back to editing. */}
          <div className="flex flex-col gap-2">
            {!error && <Button className="w-full py-2.5" onClick={send}>{attachments ? 'Continue in GitHub' : 'Submit public ticket'}</Button>}
            <Button variant="secondary" className="w-full py-2.5" onClick={() => { setError(''); setPhase('draft'); }}>Back to draft</Button>
          </div>
        </> : <>
          {/* WHY the reason is on screen (UX review U13): the button was simply
              inactive, the grey-on-grey cue was easy to miss, and no field was marked
              as needed — so pressing it appeared to do nothing at all. A control the
              user cannot use has to say what would make it usable. */}
          {(!title.trim() || !description.trim()) && (
            <p className="text-xs text-fg-2">Add a title and a description to carry on.</p>
          )}
          <Button className="w-full py-2.5" disabled={!title.trim() || !description.trim()} onClick={() => setPhase('review')}>Review ticket</Button>
        </>}
      </>}

    </div>
  </Dialog>;
}
