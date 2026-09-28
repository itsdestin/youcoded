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

export type OfficeCommand = 'undo' | 'redo' | 'bold' | 'italic' | 'underline' | 'markers' | 'numbering' | 'align-left' | 'align-center' | 'align-right';
export type OfficeCommandState = Partial<Record<OfficeCommand, { on: boolean; enabled: boolean }>>;
export interface EditorFrameHandle { command(cmd: OfficeCommand): void }

function officeBridge(): OfficeBridge | undefined {
  return (window as unknown as { claude?: { office?: OfficeBridge } }).claude?.office;
}

export function stripExt(name: string): string {
  return name.replace(/\.(docx|xlsx|pptx|odt|ods|odp|doc|xls|ppt|csv)$/i, '');
}

interface EditorFrameProps {
  file: OfficeFile;
  origin: string;
  hidden?: boolean;
  slim?: boolean;
  /** Slim mode: which commands are on / available, for the host's bar. */
  onCommandState?: (s: OfficeCommandState) => void;
  /** Photo-only mark once the document is drawn. */
  screen?: string;
}

export const EditorFrame = forwardRef<EditorFrameHandle, EditorFrameProps>(function EditorFrame(
  { file, origin, hidden = false, slim = false, onCommandState, screen }, handleRef,
) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<'starting' | 'open' | 'failed'>('starting');
  const [failure, setFailure] = useState('');
  const src = `${origin}/editor?embed=1&embedOrigin=${encodeURIComponent(location.origin)}`;
  // Escape the editor itself had no use for closes the app's top layer, as a page's does.
  const dismissTop = useDismissTop();
  const dismissRef = useRef(dismissTop);
  dismissRef.current = dismissTop;
  const stateCb = useRef(onCommandState);
  stateCb.current = onCommandState;
  const post = (msg: unknown) => ref.current?.contentWindow?.postMessage(msg, origin);

  // The shown document takes focus on a tab switch, so keyboard and screen
  // reader follow what is on screen (UX review 1, U4).
  useEffect(() => { if (!hidden && phase === 'open') ref.current?.focus(); }, [hidden, phase]);

  useImperativeHandle(handleRef, () => ({ command: (cmd) => post({ type: 'yc:office-cmd', cmd }) }), [origin]);

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== ref.current?.contentWindow) return;
      const d = e.data as { type?: string; payload?: { message?: string }; state?: OfficeCommandState } | null;
      if (d?.type === 'document:ready') {
        post({ type: OFFICE_THEME_MESSAGE, theme: readOfficeTheme() });
        post({ type: OFFICE_MODE_MESSAGE, slim });
        const source = await officeBridge()?.source(file.path);
        if (!source?.ok) { setFailure(source?.message ?? 'The file could not be read.'); setPhase('failed'); return; }
        post({ id: 'open', type: 'document:open-url', payload: { url: source.url, fileName: file.name } });
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
    <div className="absolute inset-0" hidden={hidden}>
      {phase === 'open' && !hidden && screen && <ScreenMark name={screen} />}
      <iframe
        ref={ref}
        src={src}
        title={file.name}
        // The editor needs scripts, workers and its own storage — on ITS origin,
        // never the app's (no top navigation, no access to window.claude).
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"
        className={`absolute inset-0 w-full h-full border-0 ${phase === 'open' ? '' : 'invisible'}`}
      />
      {phase === 'starting' && <div className="absolute inset-0"><LoadingState what={stripExt(file.name)} verb="Opening" /></div>}
      {phase === 'failed' && (
        <div className="p-6 max-w-xl mx-auto">
          <ErrorState message={failure} onRetry={() => { setPhase('starting'); if (ref.current) ref.current.src = src; }} />
        </div>
      )}
    </div>
  );
});
