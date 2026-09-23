import type { ReactNode, RefObject } from 'react';
import { PERMISSION_DISPLAY } from '../StatusBar';
import { fullAutoStopCopy } from './deny-list-copy';

/** Full Auto's exceptional asks share the same status-colored explanation and
 * one-time-first button order. The outside-folder grant alone has a second,
 * explicit confirmation because it widens consent for the rest of this session. */
export function FullAutoStops({ kind, confirmingExternal, toolName, command, specialistName, folderName,
  responding, focusIdx, buttonsRef, pad, ring, unconfirmedNote, onAllow, onDeny, onAlways,
  onOpenExternal, onBackExternal, onGrantExternal,
}: {
  kind: 'external' | 'budget' | 'danger';
  confirmingExternal: boolean;
  toolName?: string;
  command?: string;
  specialistName?: string;
  folderName?: string;
  responding: boolean;
  focusIdx: number;
  buttonsRef: RefObject<(HTMLButtonElement | null)[]>;
  pad: string;
  ring: string;
  unconfirmedNote: ReactNode;
  onAllow: () => void;
  onDeny: () => void;
  onAlways: () => void;
  onOpenExternal: () => void;
  onBackExternal: () => void;
  onGrantExternal: () => void;
}) {
  // WHY: the first broad-grant choice uses standard Always Allow blue, while its
  // consequence-confirmation button stays green as approved by Destin.
  const broadAllowColors = 'bg-blue-600/60 hover:bg-blue-600/80 text-blue-100';
  if (confirmingExternal) return (
    <div className="px-3 py-2 space-y-2 border-t border-edge bg-inset/30">
      <p className="text-xs font-medium text-fg-2">Allow outside edits for this session?</p>
      <p className="text-2xs text-fg-2 leading-relaxed">
        This approves this {toolName === 'Write' ? 'write' : 'edit'} and lets the main assistant edit files in all outside folders, not just this one.
        {folderName ? ` The project folder is ${folderName}.` : ''}
        {' '}Specialists stay within their assigned work directories. The allowance ends when this session closes and resets if you resume it. Credential and secret files stay blocked.
      </p>
      <div className="flex items-center gap-2">
        <button disabled={responding} onClick={onBackExternal} className={`px-3 ${pad} text-xs font-medium rounded-lg bg-inset text-fg-2`}>Back</button>
        <button disabled={responding} onClick={onGrantExternal} className={`px-3 ${pad} text-xs font-medium rounded-lg bg-green-400/60 hover:bg-green-400/80 text-green-100`}>{toolName === 'Write' ? 'Confirm and write' : 'Confirm and edit'}</button>
      </div>
      {unconfirmedNote}
    </div>
  );

  const fa = PERMISSION_DISPLAY['full-auto'];
  const isEdit = toolName === 'Edit';
  const stop = kind === 'danger' ? fullAutoStopCopy(command) : null;
  const header = stop?.header ?? (kind === 'budget'
    ? toolName === 'doom_loop' ? 'Stopped before repeating a tool call' : 'Stopped at the tool-call limit'
    : `Stopped before ${isEdit ? 'editing' : 'writing'} outside this project`);
  const subline = stop
    ? specialistName
      ? `Full auto still stops here — ${specialistName === 'the specialist' ? specialistName : `specialist ${specialistName}`} requested this command.${stop.subline === 'Full auto still stops here.' ? '' : ` ${stop.subline.replace(/^Full auto still stops here — this /, 'This ')}`}`
      : stop.subline
    : kind === 'budget'
      ? `Full auto still stops here — ${specialistName ? (specialistName === 'the specialist' ? specialistName : `specialist ${specialistName}`) : 'the assistant'} ${toolName === 'doom_loop' ? 'is repeating the same call' : 'has reached the tool-call limit'}.`
      : 'Full auto still stops here — this file is outside the session’s working folder.';
  const action = kind === 'external' ? 'Approve' : kind === 'budget' ? 'Continue' : 'Run it';
  // WHY: green is the one-time approval and red is Deny; broader grants share blue.
  const alwaysAllowClass = `px-3 ${pad} text-xs font-medium rounded-lg ${broadAllowColors} transition-colors disabled:opacity-50 ${focusIdx === 2 ? ring : ''}`;

  return (
    <div className="px-3 py-2 space-y-2 border-t" style={{ background: fa.bg, borderColor: fa.border }}>
      <div className="space-y-0.5">
        <p className="text-xs font-medium" style={{ color: fa.color }}>{header}</p>
        <p className="text-2xs text-fg-dim leading-relaxed">{subline}</p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button ref={el => { buttonsRef.current[0] = el; }} disabled={responding} onClick={onAllow} className={`px-3 ${pad} text-xs font-medium rounded-lg bg-green-400/60 hover:bg-green-400/80 text-green-100 transition-colors disabled:opacity-50 ${focusIdx === 0 ? ring : ''}`}>{action}</button>
        <button ref={el => { buttonsRef.current[1] = el; }} disabled={responding} onClick={onDeny} className={`px-3 ${pad} text-xs font-medium rounded-lg bg-red-400/60 hover:bg-red-400/80 text-red-100 transition-colors disabled:opacity-50 ${focusIdx === 1 ? ring : ''}`}>Deny</button>
        {kind !== 'budget' && <>
          <span aria-hidden="true" className="w-px h-3.5 bg-edge shrink-0" />
          <button ref={el => { buttonsRef.current[2] = el; }} disabled={responding} onClick={kind === 'external' ? onOpenExternal : onAlways} className={alwaysAllowClass}>{kind === 'external' ? 'Allow for This Session' : 'Always Allow'}</button>
        </>}
      </div>
      {unconfirmedNote}
    </div>
  );
}
