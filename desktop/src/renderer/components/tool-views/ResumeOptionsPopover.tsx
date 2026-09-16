// The little "how do I relaunch this?" sheet the preview header's Resume button
// opens, instead of resuming the instant it is clicked.
//
// Destin (2026-08-27 gate, M-header): "i also want it to open a brief little
// popup that offers model/skip permissions choices if relevant for claude/native
// sessions and a final resume confirm menu. same as resume menus used elsewhere."
//
// "Elsewhere" is ResumeBrowser.tsx's `renderExpandedOptions` — one model control
// for both runtimes, a Skip Permissions toggle that only exists for Claude Code,
// and a confirm button whose danger styling follows that toggle. This is the same
// three controls in a popover-sized frame; the Resume Browser keeps its own copy
// because its panel also carries launch-in-new-window and lives inside a row that
// already knows the session. Both call the same event with the same arguments, so
// a resume started here and a resume started there reach App identically.
import { useEffect, useRef, useState } from 'react';
import { Button, Toggle } from '../ui';
import ModelPicker, { type ModelChoice } from '../model/ModelPicker';
import { SkipPermissionsInfoTooltip } from '../SkipPermissionsInfoTooltip';
import { requestResume } from './SessionRefActions';
import type { ResolvedConversation } from '../../../shared/chatsearch-refs';
import type { ModelBinding } from '../../../shared/provider-types';
import { SkipPermissionsCaption } from '../SkipPermissionsCaption';

type Ok = Extract<ResolvedConversation, { status: 'ok' }>;

export default function ResumeOptionsPopover({
  conversation,
  defaultModel,
  defaultSkipPermissions,
  onClose,
}: {
  conversation: Ok;
  defaultModel: string;
  defaultSkipPermissions: boolean;
  onClose: () => void;
}) {
  const native = conversation.provider === 'native';
  const [model, setModel] = useState(defaultModel);
  // A native conversation has no PTY and therefore no permission flow, so the
  // toggle never applies to it — start it off rather than inheriting a default
  // that cannot be honoured.
  const [dangerous, setDangerous] = useState(native ? false : defaultSkipPermissions);
  const [binding, setBinding] = useState<ModelBinding | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Click-away and Escape, matching the tag/note sheet this sits beside.
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [onClose]);

  const choice: ModelChoice | null = native
    ? (binding ? { runtime: 'native', providerId: binding.providerId, modelId: binding.modelId } : null)
    : (model ? { runtime: 'claude', alias: model } : null);

  // Same rule as the Resume Browser: a native resume stays disabled until a
  // model binding exists, so nothing ever launches without one.
  const blocked = native && !binding;

  return (
    <div
      ref={ref}
      className="layer-surface absolute right-0 top-full mt-2 w-[280px] p-3 z-30 flex flex-col gap-2"
      role="dialog"
      aria-label="Resume options"
    >
      <div>
        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">Model</label>
        <ModelPicker
          value={choice}
          onSelect={(c) => { if (c.runtime === 'native') setBinding({ providerId: c.providerId, modelId: c.modelId }); else setModel(c.alias); }}
          includeClaude={!native}
          includeNative={native}
          onManageModels={() => window.dispatchEvent(new CustomEvent('youcoded:open-model-providers'))}
        />
      </div>

      {!native && (
        <>
          <div className="flex items-center justify-between">
            <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase inline-flex items-center">
              Skip Permissions
              <SkipPermissionsInfoTooltip />
            </label>
            <Toggle checked={dangerous} onChange={setDangerous} tone="danger" aria-label="Skip Permissions" />
          </div>
          {dangerous && (
            <SkipPermissionsCaption />
          )}
        </>
      )}

      <Button
        variant={dangerous ? 'danger' : 'primary'}
        size="md"
        className="w-full"
        disabled={blocked}
        onClick={() => { requestResume(conversation, { model, dangerous, binding: binding ?? undefined }); onClose(); }}
      >
        {dangerous ? 'Resume (Dangerous)' : 'Resume Session'}
      </Button>
    </div>
  );
}
