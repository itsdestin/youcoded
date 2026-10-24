import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, Callout, Checkbox, Dialog, OneJobCard, OneJobLabel, Select, TextInput } from '../ui';
import { BackupLogo } from '../BackupLogo';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { useChunkedReveal } from '../../hooks/use-chunked-reveal';
import { AttachmentChip } from '../AttachmentChip';
import { useGoogleFiles } from './google-files-context';
import { saveTarget, type GoogleFile, type GoogleSaveTarget } from './google-files-model';

const FileRow = memo(function FileRow({ file, checked, toggle }: { file: GoogleFile; checked: boolean; toggle: (id: string) => void }) {
  return <div className="flex items-center gap-3 py-2">
    <BackupLogo type="drive" className="shrink-0 text-fg-muted" />
    <Checkbox checked={checked} onChange={() => toggle(file.id)} aria-label={file.name} />
    <div className="min-w-0 flex-1"><div className="text-xs text-fg truncate">{file.name}</div><div className="text-2xs text-fg-muted">Google {file.kind}</div></div>
  </div>;
});

export function GoogleFilePicker({ accounts, files, state = 'ready', onClose, onAdd, onPick, onReconnect }: {
  accounts: string[]; files: GoogleFile[]; state?: 'ready' | 'error' | 'reconnect';
  onClose: () => void; onAdd: (files: GoogleFile[]) => void | Promise<void>;
  onPick: (account: string, signal: AbortSignal) => Promise<GoogleFile[]>;
  onReconnect?: (signal: AbortSignal) => Promise<void>;
}) {
  const [account, setAccount] = useState(accounts[0] ?? '');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [returned, setReturned] = useState<GoogleFile[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState(state === 'error');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(false);
  const [reconnect, setReconnect] = useState(state === 'reconnect' || !accounts.length);
  useEffect(() => { if (!account && accounts[0]) setAccount(accounts[0]); }, [account, accounts]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const close = () => { controller.current?.abort(); onClose(); };
  const allFiles = useMemo(() => [...files.filter((f) => !returned.some((r) => r.id === f.id && r.account === f.account)), ...returned], [files, returned]);
  const filtered = useMemo(() => allFiles.filter((f) => f.account === account && f.name.toLowerCase().includes(query.toLowerCase())), [allFiles, account, query]);
  const rootRef = useRef<HTMLDivElement>(null);
  const { visible, hasMore, sentinelRef } = useChunkedReveal(filtered, { resetKey: `${account}:${query}`, rootRef });
  const toggle = useCallback((id: string) => setSelected((old) => old.includes(id) ? old.filter((s) => s !== id) : [...old, id]), []);
  // WHY: a pending external return is tentative too; close/cancel cannot attach or persist it.
  const handoff = async () => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setWaiting(true); setError(false);
    try {
      if (reconnect && onReconnect) { await onReconnect(request.signal); if (!request.signal.aborted) setReconnect(false); }
      else {
        const result = await onPick(account, request.signal);
        if (!request.signal.aborted) {
          const own = result.filter((f) => f.account === account);
          setReturned((old) => [...old.filter((f) => !own.some((r) => r.id === f.id && r.account === f.account)), ...own]);
          setSelected((old) => [...new Set([...old, ...own.map((f) => f.id)])]);
        }
      }
    } catch { if (!request.signal.aborted) setError(true); }
    finally { if (!request.signal.aborted) setWaiting(false); }
  };
  const chosen = allFiles.filter((f) => f.account === account && selected.includes(f.id));
  const add = () => {
    if (!chosen.length || waiting || reconnect || error || adding) return;
    // WHY: the real backend must accept the chat grant before the picker reports success.
    try {
      const result = onAdd(chosen);
      if (!result) { close(); return; }
      setAdding(true);
      void result.then(close).catch(() => setAddError(true)).finally(() => setAdding(false));
    } catch { setAddError(true); }
  };
  return <Dialog open onClose={close} title="Attach from Google Drive" subtitle="Only files you’ve selected in Google are available here." screen="chat/google-attach" size="panel" busy={adding} onEnter={add}
    footer={<div className="flex justify-end gap-2"><Button variant="secondary" disabled={adding} onClick={close}>Cancel</Button><Button disabled={!chosen.length || waiting || reconnect || error || adding} onClick={add}>{adding ? 'Adding…' : 'Add'}</Button></div>}>
    <div className="space-y-3">
      <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
        <Select aria-label="Google account" value={account} options={accounts.map((a) => ({ value: a, label: a }))} onChange={(a) => { controller.current?.abort(); setWaiting(false); setAccount(a); setSelected([]); }} />
        <TextInput aria-label="Search selected files" placeholder="Search selected files" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className={`${CARD_LEVEL_2} px-3`}>
          {waiting ? <LoadingState what="Google" verb="Waiting for" /> : reconnect ? <EmptyState message={accounts.length ? 'Reconnect this Google account to choose files.' : 'Connect Google to choose files for this chat.'} action={{ label: accounts.length ? 'Reconnect Google' : 'Connect Google', onClick: () => { void handoff(); } }} /> : error ? <ErrorState message="Couldn’t load your selected Google files." onRetry={() => setError(false)} /> : <div ref={rootRef} className="scroll-mask-y max-h-64 overflow-y-auto">
            {visible.map((file) => <FileRow key={`${file.account}:${file.id}`} file={file} checked={selected.includes(file.id)} toggle={toggle} />)}
            {!filtered.length && <EmptyState message={query ? 'No selected files match your search.' : 'No files selected for this account yet.'} />}
            {hasMore && <div ref={sentinelRef} className="h-1" />}
          </div>}
        </div>
        {waiting ? <p className="text-2xs text-fg-muted">Finish choosing files in your usual browser. You can cancel here at any time.</p> : <div className="flex justify-end"><Button variant="secondary" disabled={!account || reconnect} onClick={() => { void handoff(); }}>Add from Google Drive</Button></div>}
      </div>
      {addError && <ErrorState message="Couldn’t attach the selected Google files." onRetry={() => { setAddError(false); add(); }} />}
      <p className="text-2xs text-fg-muted">Files are attached only to this chat when you press Add.</p>
    </div>
  </Dialog>;
}

export function GoogleSaveReview({ file, changes, onSave, onClose, onOpen, initialMode = 'original', creating = false }: { file: GoogleFile; changes: string; onSave: (target: GoogleSaveTarget) => Promise<GoogleFile | void>; onClose: () => void; onOpen: (file: GoogleFile) => Promise<void>; initialMode?: 'original' | 'copy'; creating?: boolean }) {
  const [savedFile, setSavedFile] = useState(file);
  const [mode, setMode] = useState<string>(initialMode);
  const [status, setStatus] = useState<'review' | 'saving' | 'saved' | 'opened'>('review');
  const [error, setError] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const save = async () => {
    setStatus('saving'); setError(false);
    try { const result = await onSave(saveTarget(file, file.account, mode === 'copy')); if (mounted.current) { setSavedFile(result ?? file); setStatus('saved'); } }
    catch { if (mounted.current) { setStatus('review'); setError(true); } }
  };
  const saved = status === 'saved' || status === 'opened';
  return <Dialog open onClose={onClose} title={saved ? 'Saved to Google Drive' : 'Review Google changes'} screen="chat/google-save" size="prompt" busy={status === 'saving'}>
    <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
      <div><div className="text-sm text-fg font-medium">{saved ? savedFile.name : file.name}</div><div className="text-2xs text-fg-muted">Google {file.kind} · {file.account}</div></div>
      {saved ? <><p role="status" className="text-xs text-fg-muted">{creating ? 'Your new file was saved to Google Drive.' : mode === 'copy' ? 'A new copy was saved. The original is unchanged.' : 'Your changes were saved to the original file.'}</p>
        <Button className="w-full" onClick={() => { void onOpen(savedFile).then(() => { if (mounted.current) setStatus('opened'); }).catch(() => setError(true)); }}>Open in Google</Button>
        {status === 'opened' && <p role="status" className="text-2xs text-fg-muted">Opening in your usual browser.</p>}
        <Button variant="secondary" className="w-full" onClick={onClose}>Done</Button></> : <>
        <div className={`${CARD_LEVEL_2} p-3 space-y-2`}><div className="text-xs text-fg font-medium">Changes to save</div><p className="text-xs text-fg-muted whitespace-pre-wrap break-words scroll-mask-y max-h-64 overflow-y-auto">{changes}</p></div>
        {!creating && <Select aria-label="Save as" value={mode} onChange={setMode} disabled={status === 'saving'} options={[{ value: 'original', label: 'Original file', disabled: file.canEdit === false }, { value: 'copy', label: 'New copy', disabled: file.canCopy === false }]} />}
        <p className="text-2xs text-fg-muted">{creating ? 'Create this file in the Google account shown above.' : mode === 'copy' ? 'Keep the original and save a new copy in the same account.' : 'Apply these changes to the file shown above.'}</p>
        <Button className="w-full" disabled={status === 'saving'} onClick={() => { void save(); }}>{status === 'saving' ? 'Saving…' : 'Save'}</Button>
        <Button className="w-full" variant="secondary" disabled={status === 'saving'} onClick={onClose}>Cancel</Button>
      </>}
      {error && <ErrorState message={saved ? 'Couldn’t open Google.' : 'Couldn’t save your changes.'} onRetry={() => { if (saved) { void onOpen(savedFile).then(() => setStatus('opened')).catch(() => setError(true)); } else { void save(); } }} />}
    </div>
  </Dialog>;
}

/** Real composer attachments, but kept separate from local paths and message submission. */
export function GoogleAttachments({ files, onRemove, onReview, reviewFile }: {
  files: GoogleFile[];
  onRemove: (file: GoogleFile) => void;
  onReview: (file: GoogleFile) => void;
  reviewFile?: GoogleFile;
}) {
  return (
    <div className="scroll-mask-x flex gap-2 px-3 py-2 overflow-x-auto">
      {files.map((file) => (
        <div key={`${file.account}:${file.id}`} className="shrink-0 space-y-2">
          <AttachmentChip
            path={`Google.${file.kind === 'Doc' ? 'docx' : file.kind === 'Sheet' ? 'xlsx' : 'pptx'}`}
            name={file.name}
            onRemove={() => onRemove(file)}
            preview={
              <div className="h-full flex flex-col justify-center px-2 gap-1">
                <span className="text-xs text-fg">Google {file.kind}</span>
                <span className="text-3xs text-fg-muted truncate">{file.account}</span>
              </div>
            }
          />
          {reviewFile?.id === file.id && reviewFile.account === file.account && (
            <Button variant="secondary" size="sm" className="w-full" onClick={() => onReview(file)}>
              Review changes
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export function GoogleAccountRow() {
  const context = useGoogleFiles();
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  if (!context) return null;
  const connect = async () => {
    const request = new AbortController(); controller.current = request;
    setWaiting(true); setError('');
    try { const result = await context.adapter.connect(request.signal); if (!request.signal.aborted) context.setAccounts(result); }
    catch (err) { if (!request.signal.aborted) setError(err instanceof Error ? err.message : 'Couldn’t connect Google.'); }
    finally { if (!request.signal.aborted) setWaiting(false); }
  };
  return <div className={`${CARD_LEVEL_2} p-3 space-y-3`}>
    <div className="flex items-center gap-3"><div className="flex-1"><div className="text-xs text-fg font-medium">Google</div><p className="text-2xs text-fg-muted">Docs, Sheets and Slides — only files you select.</p></div>
      {!waiting && <Button size="sm" variant="secondary" onClick={() => { void connect(); }}>{context.accounts.length ? 'Add account' : 'Connect Google'}</Button>}</div>
    {context.accounts.map((account) => <div key={account} className="flex items-center justify-between gap-2"><span className="text-xs text-fg truncate">{account}</span><Button variant="secondary" size="sm" onClick={() => {
      if (context.adapter.disconnect) void context.adapter.disconnect(account).then(context.setAccounts).catch(() => setError('Couldn’t disconnect Google.'));
      else context.setAccounts((old) => old.filter((a) => a !== account));
    }}>Disconnect</Button></div>)}
    {context.accounts.length > 0 && <p className="text-2xs text-fg-muted">Disconnect removes the saved sign-in from this device.</p>}
    {waiting && <><LoadingState what="Google sign-in" verb="Waiting for" /><p className="text-2xs text-fg-muted">Continue in your usual browser. YouCoded can access only files you select.</p><div className="flex justify-end"><Button variant="secondary" onClick={() => { controller.current?.abort(); setWaiting(false); }}>Cancel</Button></div></>}
    {(error || context.adapter.loadError) && <ErrorState message={error || context.adapter.loadError!} onRetry={() => { void connect(); }} />}
  </div>;
}

export function GoogleComposerDialogs({ picker, closePicker, onAdd, review, closeReview }: { picker: boolean; closePicker: () => void; onAdd: (files: GoogleFile[]) => void; review: GoogleFile | null; closeReview: () => void }) {
  const context = useGoogleFiles();
  if (!context) return null;
  return <>{picker && <GoogleFilePicker accounts={context.accounts} files={context.files} state={context.adapter.state} onClose={closePicker} onAdd={(files) => { context.remember(files); onAdd(files); }} onPick={context.adapter.pick} onReconnect={async (signal) => { context.setAccounts(await context.adapter.connect(signal)); }} />}
    {review && <GoogleSaveReview file={review} changes={context.adapter.changes} onClose={closeReview} onSave={context.adapter.save} onOpen={context.adapter.open} />}</>;
}
