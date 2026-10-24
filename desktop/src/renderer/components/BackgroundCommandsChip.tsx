import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useBackgroundCommands } from '../hooks/useBackgroundCommands';
import { useChunkedReveal } from '../hooks/use-chunked-reveal';
import { summarizeBackgroundCommands, type BackgroundCommand } from '../state/background-commands';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, Dialog, Pill, SectionLabel, Tooltip } from './ui';
import BrailleSpinner from './BrailleSpinner';
import { CheckIcon, FailIcon, StoppedIcon } from './Icons';
import { useElapsed, STOP_REASON } from './tool-views/ToolBody';
import { jumpToCard } from './SpecialistsChip';
import { useScreenOpen } from '../shoot-mode';

/**
 * The Background chip in the status bar and the popup behind it (Destin, 2026-10-22: "trace
 * tracking for background commands/shells/watchers/etc, and include all of these in their own
 * separate status bar chip"). One place to see every command or watcher this conversation left
 * running — native shells and Claude Code's background Bash and Monitor, a helper's own included —
 * whether or not the card that started it is still loaded in the chat.
 *
 * Built from existing pieces only, copying two screens that do the same job:
 * - the chip is the Subagents chip's shape (SpecialistsChip.tsx): one state icon, then the count
 *   in words (background-status-review#B-1 replaced the first round's dotted bare numbers);
 * - the popup is the Open tasks popup's layout (OpenTasksPopup.tsx): a small label over one
 *   first-level card per group, one nested box per row holding its words and, at the right, its
 *   one control; the name links to the card the way the Subagents popup's names do.
 * Data: useBackgroundCommands (state/background-commands.ts) — the same record the cards settle
 * from, so the chip and a card can never disagree about a command's state.
 */
export default function BackgroundCommandsChip({ sessionId }: { sessionId: string | null | undefined }) {
  const commands = useBackgroundCommands(sessionId ?? undefined);
  const [open, setOpen] = useState(false);
  useScreenOpen('chat/background', () => setOpen(true)); // photo-only build: `shoot` opens it by name
  const counts = useMemo(() => summarizeBackgroundCommands(commands), [commands]);
  if (counts.total === 0) return null;

  // "finished" here means ended without failing: completed or stopped. A stop is not a
  // failure (a dev server you ended did its job), so it never takes the red dot.
  const finished = counts.completed + counts.stopped;
  const parts = [
    counts.running > 0 ? `${counts.running} running` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
    finished > 0 ? `${finished} finished` : null,
  ].filter(Boolean).join(', ');
  const tooltip = `Background commands: ${parts} — click to see them`;
  // WHY the Subagents chip's shape (Destin, background-status-review#B-1/B-4: "notice how loading
  // icon is before text in the subagents card? … too many different numbers and its not clear what
  // each of the 3 means"): one icon, then words — never bare dotted numbers. While anything runs,
  // that is the only count; once all have ended, failures first, then the rest, each number with
  // its word. Same words at phone width, as the Subagents chip keeps them. The noun is capitalised
  // (background-status-review-2#R-2), as the Subagents chip's is.
  const label = counts.running > 0
    ? `${counts.running} ${counts.running === 1 ? 'Command' : 'Commands'}`
    : [counts.failed > 0 && `${counts.failed} failed`, finished > 0 && `${finished} finished`].filter(Boolean).join(' · ');

  return (
    <>
      <Tooltip text={tooltip}>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm border cursor-pointer hover:brightness-125 transition-colors"
        style={{ backgroundColor: 'var(--inset)', color: 'var(--fg-muted)', borderColor: 'var(--edge-dim)' }}
        aria-label={tooltip}
        data-testid="background-chip"
      >
        {counts.running > 0 ? <BrailleSpinner size="xs" />
          : counts.failed > 0 ? <FailIcon className="w-3 h-3" />
          : <CheckIcon className="w-3 h-3" />}
        <span>{label}</span>
      </button>
      </Tooltip>
      {open && (
        <BackgroundCommandsPopup
          commands={commands}
          sessionId={sessionId ?? undefined}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function BackgroundCommandsPopup({ commands, sessionId, onClose }: {
  commands: BackgroundCommand[];
  sessionId?: string;
  onClose: () => void;
}) {
  const counts = summarizeBackgroundCommands(commands);
  // Still running: oldest first (the longest-running is the one you most likely want to stop).
  // Finished: newest first — what just ended is what you came to check.
  const running = commands.filter(c => c.status === 'running');
  const ended = useMemo(() => commands.filter(c => c.status !== 'running').reverse(), [commands]);
  // WHY chunked (renderer-lists.md): a long conversation can leave hundreds of finished
  // commands; only the first 50 are drawn until the reader scrolls toward the end. The
  // observer watches against the window (an unattached root ref): the shared popup's own
  // body is what scrolls, and this list is only part of it.
  const viewportRoot = useRef<HTMLElement | null>(null);
  const { visible: endedVisible, hasMore, sentinelRef } = useChunkedReveal(ended, { resetKey: sessionId ?? '', rootRef: viewportRoot });
  const finished = counts.completed + counts.stopped;
  const subtitle = [
    counts.running > 0 ? `${counts.running} running` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
    finished > 0 ? `${finished} finished` : null,
  ].filter(Boolean).join(' · ');
  const jump = useCallback((toolUseId: string) => { jumpToCard(toolUseId); onClose(); }, [onClose]);

  return (
    <Dialog screen="chat/background" open onClose={onClose} title="Background commands" subtitle={subtitle} size="panel">
      <div className="space-y-4">
        {running.length > 0 && (
          <section>
            <SectionLabel className="mb-2">Running</SectionLabel>
            <div className={`${CARD_LEVEL_1} p-3`}>
              <ul className="flex flex-col gap-2" aria-label="Running commands">
                {running.map(c => <CommandRow key={c.id} c={c} sessionId={sessionId} onJump={jump} />)}
              </ul>
            </div>
          </section>
        )}
        {ended.length > 0 && (
          <section>
            <SectionLabel className="mb-2">Finished</SectionLabel>
            <div className={`${CARD_LEVEL_1} p-3`}>
              <ul className="flex flex-col gap-2" aria-label="Finished commands">
                {endedVisible.map(c => <CommandRow key={c.id} c={c} sessionId={sessionId} onJump={jump} />)}
              </ul>
              {hasMore && <div ref={sentinelRef} aria-hidden className="h-px" />}
            </div>
          </section>
        )}
      </div>
    </Dialog>
  );
}

/** How a finished command ended, in words — the same words its card uses (ToolBody ShellView). */
function endedLine(c: BackgroundCommand, ranFor: string): string {
  const after = ranFor ? ` after ${ranFor}` : '';
  if (c.signal) return `Ended by ${c.signal}${after}`;
  if (c.exitUnknown) return 'Ended while the app was closed · exit code unknown';
  if (c.status === 'stopped') {
    // Native knows who stopped it ("Stopped by you"); Claude Code's own stop says only that.
    if (c.provider === 'native' && c.stopReason && c.stopReason in STOP_REASON) {
      return `${STOP_REASON[c.stopReason as keyof typeof STOP_REASON]}${after}`;
    }
    return ranFor ? `Ran ${ranFor}` : '';
  }
  if (c.exitCode != null) return `Exit code ${c.exitCode}${ranFor ? ` · ran ${ranFor}` : ''}`;
  return ranFor ? `Ran ${ranFor}` : '';
}

const CommandRow = memo(function CommandRow({ c, sessionId, onJump }: {
  c: BackgroundCommand;
  sessionId?: string;
  onJump: (toolUseId: string) => void;
}) {
  const running = c.status === 'running';
  const elapsed = useElapsed(c.startedAt, running ? undefined : c.endedAt);
  const [stopping, setStopping] = useState(false);
  // Stop only where the app can really stop it: a native shell it still owns. Claude Code
  // runs its own background commands, and a record that may still be alive after a restart
  // was never re-attached — offering Stop there would be a button that does nothing. Nor does
  // a conversation shown from disk because it is not live here (viewOnly, review F1).
  const canStop = running && c.provider === 'native' && !!c.shellId && !c.maybeStillRunning && !c.viewOnly && !!sessionId;
  const stop = async () => {
    if (!canStop) return;
    setStopping(true);
    try {
      const r = await window.claude.native.killShell(sessionId!, c.shellId!);
      // A refusal (already ended) must not leave "Stopping…" up forever.
      if (!r.ok) setStopping(false);
    } catch (err) { console.error('KillShell failed:', err); setStopping(false); }
  };

  // Each fact once: the pill at the right already says Running / Watching / Failed / Stopped /
  // Finished, so this line only adds what the pill can't — how long, how it ended, who started it.
  const facts: string[] = [];
  if (c.kind === 'watcher' && !running) facts.push('Watcher');
  if (c.ownerHelper) facts.push('Started by a helper');
  if (running) {
    if (c.maybeStillRunning) facts.push('It ended while the app was closed and may still be running');
    else if (elapsed) facts.push(`For ${elapsed}`);
  } else {
    const line = endedLine(c, elapsed);
    if (line) facts.push(line);
  }
  // The full command under the name, only when the name is the call's own description.
  const showCommand = !!c.command && c.command.split('\n')[0] !== c.label;
  const target = c.ownerHelper?.toolUseId ?? c.toolUseId;

  return (
    // WHY the Subagents popup card's own layout (background-status-review#B-2 "make the chips
    // top-right aligned"; -2#R-3 "is this alignment consistent with the subagent popup and
    // cards?"): a header line holding the name and, at its right, the status — lined up on the
    // name's text baseline (SpecialistsChip HelperCard's `items-baseline`) — then the details
    // below at full width.
    <li className={`${CARD_LEVEL_2} px-3 pt-2.5 pb-2 space-y-0.5`} data-testid={`background-row-${c.id}`}>
      <div className="flex items-baseline gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          {/* The name is the link to its card — dotted underline, like the Subagents popup. */}
          <Tooltip text={c.ownerHelper ? "Show the helper that started this" : 'Show this command in the conversation'}>
          <button
            type="button"
            onClick={() => onJump(target)}
            className="text-xs font-medium text-fg text-left align-baseline underline decoration-dotted decoration-fg-muted underline-offset-2 hover:decoration-fg break-words"
          >
            {c.label}
          </button>
          </Tooltip>
        </div>
        <div className="shrink-0 flex items-center gap-1.5">
          <StatusPill c={c} />
          {/* Stop is the small stop symbol after the Running label (background-status-review-2#C-1,
              Destin picked it over a filled or outlined button): the row still says Running like
              every other, and the hover text names the action. */}
          {canStop && (
            <Tooltip text="Stop this command">
              <Button size="icon-sm" variant="ghost" aria-label={stopping ? 'Stopping…' : 'Stop'} disabled={stopping} onClick={stop}>
                <StoppedIcon className="w-4 h-4" />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      {showCommand && <div className="text-2xs font-mono text-fg-dim truncate" title={c.command}>{c.command}</div>}
      <div className="text-2xs text-fg-muted">{facts.join(' · ')}</div>
    </li>
  );
});

/** The one word for a row's state — the Subagents popup's pills, words in the text colour. */
function StatusPill({ c }: { c: BackgroundCommand }) {
  if (c.status === 'running') {
    if (c.maybeStillRunning) return <Pill tone="warning">May be running</Pill>;
    return <Pill tone="ok" dot>{c.kind === 'watcher' ? 'Watching' : 'Running'}</Pill>;
  }
  if (c.status === 'failed') return <Pill tone="danger" className="gap-1"><FailIcon className="w-3 h-3" />Failed</Pill>;
  if (c.status === 'stopped') return <Pill tone="neutral" className="gap-1"><StoppedIcon className="w-3 h-3" />Stopped</Pill>;
  return <Pill tone="neutral" className="gap-1"><CheckIcon className="w-3 h-3" />Finished</Pill>;
}
