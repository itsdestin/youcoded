import React, { useCallback, useEffect, useState } from 'react';
import { Button, Dialog } from '../ui';
import { ErrorState } from '../ui/states';
import type { GoogleProposal } from '../../../shared/google-files-types';
import { useGoogleFiles } from './google-files-context';
import { GoogleAttachments, GoogleFilePicker, GoogleSaveReview } from './GoogleFiles';
import type { GoogleFile } from './google-files-model';

function exactChanges(proposal: GoogleProposal): string {
  if (proposal.create) return `Create ${proposal.create.kind}: ${proposal.create.name}\n\n${proposal.create.content}`;
  return proposal.edits.map((edit) => edit.kind === 'replaceText'
    ? `Replace:\n${edit.find}\n\nWith:\n${edit.replace}`
    : `Cells: ${edit.range}\n${edit.values.map((row) => row.map((cell) => cell ?? '').join(' | ')).join('\n')}`).join('\n\n');
}

/** Real session attachment and approval state. No polling and no simulated save responses. */
export function GoogleLiveComposer({ sessionId, picker, closePicker, onAttached }: {
  sessionId: string; picker: boolean; closePicker: () => void; onAttached: (hasFiles: boolean) => void;
}) {
  const google = useGoogleFiles();
  const api = google?.adapter.bridge;
  const [files, setFiles] = useState<GoogleFile[]>([]);
  const [pending, setPending] = useState<GoogleProposal[]>([]);
  const [review, setReview] = useState<GoogleProposal | null>(null);
  const [checking, setChecking] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (!api) return;
    const next = await api.attached(sessionId);
    setFiles(next); onAttached(next.length > 0);
  }, [api, sessionId, onAttached]);
  useEffect(() => {
    if (!api || !sessionId || sessionId.startsWith('pending-')) return;
    let active = true;
    void api.attached(sessionId).then((next) => { if (active) { setFiles(next); onAttached(next.length > 0); } }).catch(() => { if (active) setError('Couldn’t load this chat’s Google files.'); });
    return () => { active = false; };
  }, [api, sessionId, onAttached, google?.accounts]);
  if (!google || !api) return null;
  const remove = async (file: GoogleFile) => {
    if (!file.accountId) throw new Error('The Google account is unavailable.');
    await api.detach(sessionId, file.accountId, file.id); await refresh();
  };
  const inspect = async () => {
    setChecking(true); setError(''); setEmpty(false);
    try {
      const proposals = await api.proposals(sessionId);
      setPending(proposals);
      if (proposals.length === 1) setReview(proposals[0]);
      else if (!proposals.length) setEmpty(true);
    } catch { setError('Couldn’t load proposed Google changes.'); }
    finally { setChecking(false); }
  };
  return <>
    {files.length > 0 && <GoogleAttachments files={files} onRemove={(file) => { void remove(file).catch(() => setError('Couldn’t remove this Google attachment.')); }} onReview={() => { void inspect(); }} />}
    {google.accounts.length > 0 && <div className="flex justify-end px-3 py-1"><Button variant="secondary" size="sm" disabled={checking} onClick={() => { void inspect(); }}>{checking ? 'Checking Google changes…' : 'Review Google changes'}</Button></div>}
    {empty && <p className="px-3 text-2xs text-fg-muted">No Google changes are waiting for review.</p>}
    {error && <div className="px-3"><ErrorState message={error} onRetry={() => { setError(''); void refresh().catch(() => setError('Couldn’t refresh Google files.')); }} /></div>}
    {picker && <GoogleFilePicker accounts={google.accounts} files={google.files} onClose={closePicker}
      onPick={google.adapter.pick} onReconnect={async (signal) => google.setAccounts(await google.adapter.connect(signal))}
      onAdd={async (selected) => {
        const accountId = selected[0]?.accountId;
        if (!accountId || selected.some((file) => file.accountId !== accountId)) throw new Error('Choose files from one connected Google account.');
        await api.attach(sessionId, accountId, selected.map((file) => file.id));
        google.remember(selected); await refresh();
      }} />}
    {pending.length > 1 && !review && <Dialog open title="Google changes to review" onClose={() => setPending([])} noScreen="Requires pending proposals from this live conversation; the actual save dialog is captured separately.">
      <div className="space-y-2">{pending.map((proposal) => <Button key={proposal.id} variant="secondary" className="w-full" onClick={() => setReview(proposal)}>{proposal.file.name} — {proposal.file.account}</Button>)}</div>
    </Dialog>}
    {review && <GoogleSaveReview key={review.id} file={review.file} initialMode={review.mode} creating={!!review.create}
      changes={`${review.summary}\n\n${exactChanges(review)}`} onOpen={google.adapter.open}
      onClose={() => { setReview(null); setPending([]); }}
      onSave={async (target) => {
        const result = await api.approve(sessionId, review.id, target.mode);
        // WHY: a saved cloud write must not become a reported failure because metadata refresh failed.
        await refresh().catch(() => setError('Saved to Google Drive, but the file list could not refresh.'));
        setPending([]); return result;
      }} />}
  </>;
}
