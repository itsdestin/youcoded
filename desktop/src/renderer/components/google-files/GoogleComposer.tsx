import React, { useEffect, useState } from 'react';
import { useScreenOpen, ScreenMark } from '../../shoot-mode';
import { Button, Menu, MenuItem } from '../ui';
import { AttachIcon } from '../Icons';
import { useGoogleFiles } from './google-files-context';
import { GoogleAttachments, GoogleComposerDialogs } from './GoogleFiles';
import { GoogleLiveComposer } from './GoogleLiveComposer';
import type { GoogleFile } from './google-files-model';

// WHY: keep Google's per-chat selections and overlay wiring together without
// coupling cloud picks to the composer's local filesystem attachments.
export function useGoogleComposer(sessionId: string) {
  const google = useGoogleFiles();
  const [attachMenu, setAttachMenu] = useState(false);
  const [googlePicker, setGooglePicker] = useState(false);
  const [googleReview, setGoogleReview] = useState<GoogleFile | null>(null);
  const [hasGoogleFiles, setHasGoogleFiles] = useState(false);
  // WHY: cloud picks are per-chat and never masquerade as local filesystem paths.
  const [googleByChat, setGoogleByChat] = useState<Record<string, GoogleFile[]>>(() => ({ [sessionId]: google?.adapter.attached ?? [] }));
  const googleAttached = googleByChat[sessionId] ?? [];
  useEffect(() => { setGooglePicker(false); setGoogleReview(null); setAttachMenu(false); setHasGoogleFiles(false); }, [sessionId]);
  useScreenOpen('chat/attach-menu', () => setAttachMenu(true), undefined, !!google);
  useScreenOpen('chat/google-attach', () => setGooglePicker(true), undefined, !!google);
  useScreenOpen('chat/google-save', () => setGoogleReview(google?.adapter.reviewFile ?? null), undefined, !!google);
  useScreenOpen('chat/google-attached', () => setGoogleByChat((old) => ({ ...old, [sessionId]: google?.files.slice(0, 1) ?? [] })), undefined, !!google);

  const content = google?.adapter.bridge ? <GoogleLiveComposer key={sessionId} sessionId={sessionId} picker={googlePicker} closePicker={() => setGooglePicker(false)} onAttached={setHasGoogleFiles} /> : google && (
    <>
      {googleAttached.length > 0 && (
        <>
          <ScreenMark name="chat/google-attached" />
          <GoogleAttachments
            files={googleAttached}
            reviewFile={google.adapter.reviewFile}
            onReview={setGoogleReview}
            onRemove={(file) => setGoogleByChat((old) => ({
              ...old,
              [sessionId]: (old[sessionId] ?? []).filter((f) => f.id !== file.id || f.account !== file.account),
            }))}
          />
        </>
      )}
      <GoogleComposerDialogs
        key={sessionId}
        picker={googlePicker}
        closePicker={() => setGooglePicker(false)}
        onAdd={(files) => setGoogleByChat((old) => ({
          ...old,
          [sessionId]: [
            ...(old[sessionId] ?? []).filter((f) => !files.some((a) => a.id === f.id && a.account === f.account)),
            ...files,
          ],
        }))}
        review={googleReview}
        closeReview={() => setGoogleReview(null)}
      />
    </>
  );

  const renderAttachMenu = (disabled: boolean | undefined, onAttachLocal: () => Promise<void>) => google ? (
    // WHY: Menu leaves clicks to its caller; open upward so both choices stay on screen.
    <Menu open={attachMenu} onOpenChange={setAttachMenu} side="top" className="min-w-40" label="Attach files" trigger={<Button variant="ghost" size="icon" aria-label="Attach file" aria-haspopup="menu" aria-expanded={attachMenu} onClick={() => setAttachMenu((open) => !open)} disabled={disabled}><AttachIcon className="w-5 h-5" /></Button>}>
      <ScreenMark name="chat/attach-menu" />
      <MenuItem onSelect={() => { setAttachMenu(false); void onAttachLocal(); }}>Local file</MenuItem>
      <MenuItem onSelect={() => { setAttachMenu(false); setGooglePicker(true); }}>Google Drive</MenuItem>
    </Menu>
  ) : null;

  return { content, renderAttachMenu, messageHint: hasGoogleFiles ? '\n\n[Google files are attached to this chat. Use GoogleFiles list/read to access them. Proposed changes require user approval through Review Google changes.]' : '' };
}
