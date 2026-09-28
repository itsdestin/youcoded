// EditorFrame — one open document: the Euro-Office editor on its own sealed
// origin. Used by the Office page (full editor) and by the file viewers' Edit
// mode (slim: the editor's own chrome hidden, YouCoded's one-row bar instead —
// office-questions#Q-slim "YouCoded's own bar").
//
// Only small messages cross the frame, and only from this frame's window: the
// theme, the mode, "open this file", a toolbar command, and the editor's
// replies (ready, drawn, failed, which commands are on).
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ErrorState, LoadingState } from '../ui';
import type { OfficeBridge, OfficeFile } from '../../../shared/office-types';
import { OFFICE_MODE_MESSAGE, OFFICE_THEME_MESSAGE, readOfficeTheme, watchOfficeTheme } from './office-theme';
import { ScreenMark } from '../../shoot-mode';
import { useDismissTop } from '../../hooks/use-esc-close';
import { plainMessage } from '../../utils/ipc-error';

export type OfficeCommand = 'undo' | 'redo' | 'bold' | 'italic' | 'underline' | 'markers' | 'numbering' | 'align-left' | 'align-center' | 'align-right';
export type OfficeCommandState = Partial<Record<OfficeCommand, { on: boolean; enabled: boolean }>>;
export interface EditorFrameHandle { command(cmd: OfficeCommand): void }

function officeBridge(): OfficeBridge | undefined {
  return window.claude?.office;
}

/** WORKBENCH ONLY, removed in Task 6. The v2 bridge opens a document with `open` and relays
 *  the editor's own requests through `invoke`; Task 6 builds that relay. Until then the
 *  workbench fake carries this old-style shortcut — the editors served on a local origin,
 *  handed a fixture by URL — so its Office screens (office/document, office/spreadsheet,
 *  chat/files/edit/a-sent-plan) still show a document. No real host has it. */
export interface OfficeWorkbenchPreview {
  origin: string;
  sampleUrl(path: string): string;
}
function workbenchPreview(b: OfficeBridge | undefined): OfficeWorkbenchPreview | undefined {
  return (b as { workbenchPreview?: OfficeWorkbenchPreview } | undefined)?.workbenchPreview;
}

// Slim mode: the frame is drawn a little LARGER than its pane and the pane crops it, so the
// editor's own chunky scroll bars (14px, right and bottom) and the gap it keeps above the first
// page fall just outside what shows (office-review-2#A-inline, Destin: "the scroll bars look
// janky, as does the gap between the top of the doc and the edit bar"). The editor offers no
// setting for either; hiding the bars in its own page leaves their strips empty instead.
// Wheel, trackpad and touch still scroll. Numbers are the editor's own sizes at 100% UI scale.
// An iframe does not stretch between inset edges (it keeps its 300x150 default), so the
// overscan is an explicit size: 14px wider, 18px + 14px taller, lifted 18px.
const SLIM_OVERSCAN: React.CSSProperties = { top: '-1.125rem', left: 0, width: 'calc(100% + 0.875rem)', height: 'calc(100% + 2rem)' };

export function stripExt(name: string): string {
  return name.replace(/\.(docx|xlsx|pptx|odt|ods|odp|doc|xls|ppt|csv)$/i, '');
}

interface EditorFrameProps {
  file: OfficeFile;
  hidden?: boolean;
  slim?: boolean;
  /** Slim mode: which commands are on / available, for the host's bar. */
  onCommandState?: (s: OfficeCommandState) => void;
  /** Photo-only mark once the document is drawn. */
  screen?: string;
}

export const EditorFrame = forwardRef<EditorFrameHandle, EditorFrameProps>(function EditorFrame(
  { file, hidden = false, slim = false, onCommandState, screen }, handleRef,
) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<'starting' | 'open' | 'failed'>('starting');
  const [failure, setFailure] = useState('');
  // WHY the frame asks for its own origin (Task 5): every open document has its own sealed
  // office://<token> origin now, handed out by office.open, so there is no shared editor
  // origin for a parent to pass down. null until main has answered.
  const [origin, setOrigin] = useState<string | null>(null);
  // Bumped by Retry, to open the document again from the start.
  const [attempt, setAttempt] = useState(0);
  const preview = workbenchPreview(officeBridge());
  const src = origin === null ? undefined
    : preview ? `${origin}/editor?embed=1&embedOrigin=${encodeURIComponent(location.origin)}`
    : `${origin}/index.html`;
  // Escape the editor itself had no use for closes the app's top layer, as a page's does.
  const dismissTop = useDismissTop();
  const dismissRef = useRef(dismissTop);
  dismissRef.current = dismissTop;
  const stateCb = useRef(onCommandState);
  stateCb.current = onCommandState;
  const post = (msg: unknown) => { if (origin) ref.current?.contentWindow?.postMessage(msg, origin); };

  // Open the document in main, and close it again when this frame goes away, so its
  // temporary files do not outlive the tab. A late answer (this frame already gone) is closed
  // too: main counts each open of a token, so that close only ends this frame's share and
  // never the document another frame of the same file is showing.
  useEffect(() => {
    const b = officeBridge();
    const wb = workbenchPreview(b);
    if (wb) { setOrigin(wb.origin); return; }
    let gone = false;
    let token: string | null = null;
    const failWith = (message: string) => { if (!gone) { setFailure(message); setPhase('failed'); } };
    if (!b) { failWith("Office couldn't open this file."); return; }
    b.open(file.path).then((r) => {
      if (!r.ok) { failWith(r.message); return; }
      if (gone) { void b.close(r.token).catch(() => {}); return; }
      token = r.token;
      setOrigin(r.origin);
    }, (e: unknown) => failWith(
      // WHY (fix round 1): on the remote client and the phone the host refuses Office outright,
      // and that is known for certain, so say it (plainMessage names the feature and where)
      // rather than the general "couldn't open", which would suggest the file is at fault.
      /^remote-unsupported:/.test(String((e as Error)?.message ?? '')) ? plainMessage(e) : "Office couldn't open this file.",
    ));
    return () => {
      gone = true;
      if (token) void b.close(token).catch(() => {});
    };
  }, [file.path, attempt]);

  // The shown document takes focus on a tab switch, so keyboard and screen
  // reader follow what is on screen (UX review 1, U4).
  useEffect(() => { if (!hidden && phase === 'open') ref.current?.focus(); }, [hidden, phase]);

  useImperativeHandle(handleRef, () => ({ command: (cmd) => post({ type: 'yc:office-cmd', cmd }) }), [origin]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!origin || e.origin !== origin || e.source !== ref.current?.contentWindow) return;
      const d = e.data as { type?: string; payload?: { message?: string }; state?: OfficeCommandState } | null;
      if (d?.type === 'document:ready') {
        post({ type: OFFICE_THEME_MESSAGE, theme: readOfficeTheme() });
        post({ type: OFFICE_MODE_MESSAGE, slim });
        // Workbench only until Task 6 (see OfficeWorkbenchPreview): the real editor is handed
        // its document through the relay instead.
        const url = workbenchPreview(officeBridge())?.sampleUrl(file.path);
        if (url) post({ id: 'open', type: 'document:open-url', payload: { url, fileName: file.name } });
      }
      // The bridge says when the document is really drawn — "opened" only means accepted.
      if (d?.type === 'yc:office-loaded') setPhase('open');
      if (d?.type === 'yc:office-state' && d.state) stateCb.current?.(d.state);
      if (d?.type === 'yc:office-esc') dismissRef.current();
      if (d?.type === 'document:error') { setFailure(d.payload?.message ?? 'The file could not be opened.'); setPhase('failed'); }
    };
    window.addEventListener('message', onMessage);
    const stopTheme = watchOfficeTheme((theme) => post({ type: OFFICE_THEME_MESSAGE, theme }));
    return () => { window.removeEventListener('message', onMessage); stopTheme(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- post reads the ref; slim is fixed per frame
  }, [file.path, file.name, origin]);

  return (
    <div className="absolute inset-0 overflow-hidden" hidden={hidden}>
      {phase === 'open' && !hidden && screen && <ScreenMark name={screen} />}
      <iframe
        ref={ref}
        src={src}
        title={file.name}
        // The editor needs scripts, workers and its own storage — on ITS origin,
        // never the app's (no top navigation, no access to window.claude).
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"
        className={`absolute border-0 ${slim ? '' : 'inset-0 w-full h-full'} ${phase === 'open' ? '' : 'invisible'}`}
        style={slim ? SLIM_OVERSCAN : undefined}
      />
      {phase === 'starting' && <div className="absolute inset-0"><LoadingState what={stripExt(file.name)} verb="Opening" /></div>}
      {phase === 'failed' && (
        <div className="p-6 max-w-xl mx-auto">
          <ErrorState message={failure} onRetry={() => { setPhase('starting'); setOrigin(null); setAttempt((n) => n + 1); }} />
        </div>
      )}
    </div>
  );
});
