import { useState } from 'react';
import { AnchorTip, Button, Callout, Checkbox, Dialog, SegmentedTabs, SettingRow, Textarea, TextInput } from '../ui';
import { useEscClose } from '../../hooks/use-esc-close';

export function ReportDesign({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEscClose(open, onClose);
  // WHY: closing or going back must not discard a draft. Persistence beyond this mounted
  // component, real originating context and all asynchronous operations remain unbuilt.
  const [kind, setKind] = useState('bug');
  const [review, setReview] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [context, setContext] = useState(true);
  const [logs, setLogs] = useState(false);
  const [logText, setLogText] = useState('');
  const [attachments, setAttachments] = useState(false);
  const [aiInfo, setAiInfo] = useState(false);
  return <Dialog open={open} onClose={onClose} size="document" title="Submit a ticket">
    <div className="p-4 space-y-4">
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
          <SettingRow title="Error details and version" control={<Checkbox aria-label="Include error details and YouCoded version" checked={context} onChange={setContext} />} accessory={<AnchorTip label="About error details">Only the originating error and app version, not your conversation. You’ll review these before sharing.</AnchorTip>} />
          <SettingRow title="Recent logs" control={<Checkbox aria-label="Include recent logs" checked={logs} onChange={setLogs} />} accessory={<AnchorTip label="About recent logs">Logs record app activity and errors. They may contain private information. Review and remove private details before sharing.</AnchorTip>} />
        </>}
        <SettingRow title="Screenshots or files" control={<Checkbox aria-label="Finish with attachments in GitHub" checked={attachments} onChange={setAttachments} />} accessory={<AnchorTip label="About attachments">Attach reviewed files yourself in GitHub.</AnchorTip>} />
      </section> : <section className="space-y-3">
        {kind === 'bug' && context && <div className="space-y-1">
          <h3 className="text-2xs uppercase tracking-wide text-fg-muted">Error details and version</h3>
          <p className="text-xs text-fg-2 font-mono">YouCoded 1.2.4 · Linux x64 · Electron 41.10.3</p>
        </div>}
        {/* WHY: both evidence blocks read as one pattern — section label, one line of
            explanation, then the content. A bare inline label made them look unrelated. */}
        {kind === 'bug' && logs && <div className="space-y-1">
          <h3 className="text-2xs uppercase tracking-wide text-fg-muted">Recent logs</h3>
          <p className="text-xs text-fg-2">Remove private details before sharing.</p>
          <Textarea id="report-logs" aria-label="Logs to review" className="w-full h-24 mt-2" value={logText} onChange={e => setLogText(e.target.value)} placeholder="Sample text only — no logs collected" />
        </div>}
      </section>}
      {attachments && <Callout>Review and crop files before attaching them. GitHub uploads a file as soon as you attach it — before you submit the issue. You’ll attach approved files yourself in the browser; nothing is uploaded here.</Callout>}
      {review ? <>
        <SettingRow title="Optional AI help" expanded={aiInfo} onClick={() => setAiInfo(!aiInfo)} />
        {aiInfo && <div className="px-3 space-y-2">
          <p className="text-sm text-fg-2">Only this draft and selected details go to your chosen assistant. Review them first. Nothing is sent automatically; provider usage may apply.</p>
          <Button variant="secondary" className="w-full py-2.5">Improve wording with AI</Button>
        </div>}
        {/* WHY: the app's dialogs stack full-width actions (see the legacy ContributePopup and
            BugReportPopup) — primary on top, secondary under it. Chip-sized right-aligned
            buttons were this mockup's own invention and read as a different app. */}
        <div className="flex flex-col gap-2">
          <Button className="w-full py-2.5">{attachments ? 'Continue in GitHub' : 'Submit public ticket'}</Button>
          <Button variant="secondary" className="w-full py-2.5" onClick={() => setReview(false)}>Back to draft</Button>
        </div>
      </> : <Button className="w-full py-2.5" disabled={!title.trim() || !description.trim()} onClick={() => setReview(true)}>Review ticket</Button>}
    </div>
  </Dialog>;
}
