import React, { useState, useRef, useCallback, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, useContext } from 'react';
import { useChatDispatch } from '../state/chat-context';
import QuickChips, { QuickChip } from './QuickChips';
import TerminalToolbar from './TerminalToolbar';
import { Button } from './ui';
import { AttachmentChip } from './AttachmentChip';
import { AttachIcon, CompassIcon } from './Icons';
import { VoiceButton, VoiceMeter, VoiceStyleContext } from './VoiceButton';
import { StatusStrip } from './ui/StatusStrip';
import { useVoiceInput } from '../hooks/useVoiceInput';
import BrailleBurst from './BrailleBurst';
import FlowingKeywordsText from './FlowingKeywords';
import StopButton from './StopButton';
import { isTypingTarget } from '../utils/is-typing-target';
// Central slash-command router. All /-prefixed messages flow through here
// so interception is consistent between typed input and drawer selection.
import { dispatchSlashCommand, type ViewMode } from '../state/slash-command-dispatcher';
import { runNativeSlashAction, routeSlashResult } from '../state/native-slash-actions';
import type { UsageSnapshot } from '../state/chat-types';
import { hasPendingInteraction } from '../state/pty-input-gate';
import { buildOutgoingMessage } from './outgoing-message';
import { sendChatMessage } from './native-send';
import type { NativeSendResult } from '../../shared/types';
import { useScrollFade } from '../hooks/useScrollFade';
import { useStreamingGate } from '../hooks/useStreamingGate';
import { isAndroid } from '../platform';

// WHY: the composer auto-focus listener must leave controls and composite widgets
// with their own keyboard behavior focused so they can handle Enter and arrows.
const isInteractiveTarget = (el: Element | null | undefined): boolean => {
  const target = el as HTMLElement | null;
  if (!target) return false;
  return !!target.closest(
    'button, a[href], input, textarea, select, summary, [role="application"], [role="button"], [role="link"], [role="menu"], [role="menuitem"], [role="listbox"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"]',
  );
};

export interface InputBarHandle {
  clear: () => void;
  // Task 11 (cancel/edit queued messages): the edit-refill idiom. There was no
  // existing "external surface reads/replaces InputBar's draft" mechanism —
  // `initialInput` fills once per session id (already consumed for an ACTIVE
  // session) and the `youcoded:compose-insert` CustomEvent only prepends
  // fire-and-forget (no way to check emptiness first, which the brief's
  // ordering — refuse BEFORE removing the queued entry — requires). Extending
  // this existing ref (already used by App for `clear()`) with a synchronous
  // read + an unconditional replace was the smallest addition that supports
  // the required check-then-act sequence; see task-11-report.md.
  /** True when the composer currently holds a non-empty (trimmed) draft. */
  hasDraft: () => boolean;
  /** Replace the composer's content with `text` and focus it. Caller must call
   *  hasDraft() first — this does not check emptiness itself. */
  fillDraft: (text: string) => void;
}

interface Props {
  sessionId: string;
  disabled?: boolean;
  minimal?: boolean;
  compact?: boolean;                // NEW: hides QuickChips for buddy chat
  view?: ViewMode;                  // Current view mode — forwarded to dispatcher (e.g. /config behaves differently in terminal view)
  onOpenDrawer?: (searchMode: boolean) => void;
  onCloseDrawer?: () => void;
  onDrawerSearch?: (query: string) => void;
  onResumeCommand?: () => void;
  // /cost and /usage — App provides the snapshot factory since stats live in statusData.
  getUsageSnapshot?: (sessionId: string) => UsageSnapshot | null;
  // /config (chat view) — App opens the PreferencesPopup
  onOpenPreferences?: () => void;
  // Toast channel for dispatcher warnings ("Attachments ignored with /clear", etc.)
  onToast?: (message: string) => void;
  // Pending-prompt send was refused. App surfaces a "Send anyway" affordance
  // wired to `retry`, which presses ESC (to neutralize any genuinely-live Ink
  // menu) then re-sends bypassing the gate. See sendMessage's gate branch.
  onSendBlocked?: (retry: () => void) => void;
  // /copy needs to read assistant turns from session state to extract blocks
  getSessionState?: (sessionId: string) => import('../state/chat-types').SessionChatState | undefined;
  // Bare /model, /fast, /effort open the unified ModelPickerPopup
  onOpenModelPicker?: () => void;
  /** Optional text to prefill when this session is first selected.
   *  Consumed exactly once per session ID via a consumed-set ref — safe to
   *  receive as a prop without triggering repeated fills on re-renders. */
  initialInput?: string;
  /** Runtime backend of the active session. Native sessions have no PTY, so the
   *  send path routes through native:send instead of the PTY paste machinery. */
  provider?: 'claude' | 'native';
}

// isImage no longer drives the chip (AttachmentChip derives the preview kind
// from the path itself) — it stays because the slash-command dispatcher's
// `files` type still carries it.
interface Attachment {
  path: string;
  name: string;
  isImage: boolean;
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

function isImagePath(p: string): boolean {
  const lower = p.toLowerCase();
  return IMAGE_EXTS.some((ext) => lower.endsWith(ext));
}

function fileNameFromPath(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || p;
}

// M1: copy for a refused/unknown native send ack, shown via onToast instead
// of dispatching a phantom bubble. Each branch names the REAL cause reported
// by the host (queue-full / not-live / starting) rather than a guessed one — see
// docs/error-message-standards.md ("never guess an unverified cause").
//
// CORRECTED 2026-09-06. That claim used to be false for one branch. The host had
// a single 'not-live' code for two opposite situations — a session that has ENDED
// and one that has not STARTED yet — so a brand-new session on a local model told
// Destin it was "no longer running" and to "start or resume it", while the engine
// was quietly loading a 29 GB model that answered him a minute later. Neither half
// was true and neither remedy existed. The host now separates them, and a message
// typed during startup is HELD and delivered rather than refused at all, so this
// branch is only reached when ten are already waiting.
function sendFailureCopy(result: NativeSendResult | undefined): string {
  if (result?.status === 'failed' && result.reason === 'queue-full') {
    return 'Send queue is full (10 messages waiting). Wait for the current turn to finish.';
  }
  if (result?.status === 'failed' && result.reason === 'starting') {
    return 'Starting up — the model is still loading, and ten messages are already waiting.';
  }
  if (result?.status === 'failed' && result.reason === 'not-live') {
    return 'This session is no longer running. Start or resume it to send messages.';
  }
  return 'The message could not be sent — no response from the session host.';
}

const InputBar = forwardRef<InputBarHandle, Props>(function InputBar({ sessionId, disabled, minimal, compact, view, onOpenDrawer, onCloseDrawer, onDrawerSearch, onResumeCommand, getUsageSnapshot, onOpenPreferences, onToast, onSendBlocked, getSessionState, onOpenModelPicker, initialInput, provider }, ref) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // Voice prompting (deck 2026-09-05). The draft stays the one source of truth:
  // `text` holds what was typed plus the words the engine has SETTLED on;
  // `voiceTail` is the engine's newest few words, still liable to change, drawn
  // grey in the mirror layer and appended to the textarea value so both layers
  // measure the same height (Q-2: "the newest few in grey until they settle").
  // `voiceBaseRef` is the draft as it stood when the mic opened — every partial
  // replaces everything after it, so a rewritten word never leaves a stale copy.
  const [voiceTail, setVoiceTail] = useState('');
  const voiceBaseRef = useRef('');
  const textRef = useRef('');
  const voice = useVoiceInput({
    onPartial: (committed, tail) => {
      setText(voiceBaseRef.current + committed);
      setVoiceTail(tail ? (committed ? ' ' : '') + tail : '');
    },
    onFinal: (final) => {
      setVoiceTail('');
      // Q-4: the text waits in the box with the caret at the end — nothing is
      // sent until the user presses Send.
      const next = voiceBaseRef.current + final + (final ? ' ' : '');
      setText(next);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.length, next.length);
      });
    },
  });
  const startVoice = useCallback(() => {
    // The textarea is the truth here, not React state: a keystroke from a
    // fraction of a second ago may not have reached state yet. (There is no
    // space to take back — a space bar held for the walkie-talkie never types
    // one in the first place. See the gesture note below.)
    const cur = inputRef.current?.value ?? textRef.current;
    // Dictation continues the draft: a typed half-sentence keeps its place and
    // the spoken words follow after one space.
    voiceBaseRef.current = cur.trim() ? cur.replace(/\s*$/, ' ') : '';
    setText(voiceBaseRef.current);
    void voice.start();
  }, [voice.start]); // eslint-disable-line react-hooks/exhaustive-deps -- reads the draft through the textarea on purpose
  // Q-3 note (Destin): "press and hold the spacebar in a bare input box for
  // walkie-talkie mode" — since widened to any box, with or without text.
  //
  // HOW THE GESTURE IS DECIDED, and why it is decided this way (Destin,
  // 2026-09-05: "still seems like a bit of a gamble as to whether the spacebar
  // does voice mode or just enters a bunch of spaces").
  //
  // The space bar goes down and NOTHING is typed. If it comes back up, or any
  // other key goes down, before the hold matures, the space is typed then — one
  // space, at the caret. If the hold matures, dictation starts and no space is
  // typed at all.
  //
  // The rule that stops it feeling like a coin flip: nothing here may depend on
  // the browser's `event.repeat` flag. The first attempt suppressed auto-repeat
  // with `if (e.repeat)`, and Electron on Linux does not reliably set it — when
  // it is missing every repeated space is typed, which is the run of spaces
  // instead of the microphone. Whether a hold is open is OUR state
  // (`spaceHoldTimer`), and every space arriving while it is open is swallowed
  // whatever the event says about itself. At most one space can ever come out.
  //
  // Typing is unharmed: a normal space is released in about a tenth of a second,
  // and the next key aborts the hold and puts the space in AHEAD of itself — so
  // "hello world" typed at speed cannot come out "hellow orld", which is what a
  // naive "insert it on key-up" would produce.
  const SPACE_HOLD_MS = 350;
  const spaceHoldTimer = useRef<number | null>(null);
  const spaceHeld = useRef(false);
  /** Type the space a pending hold swallowed, at the caret. */
  const commitPendingSpace = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const at = el.selectionStart ?? el.value.length;
    const to = el.selectionEnd ?? at;
    // WHY: insert the space and place the caret before the browser inserts
    // the next character; a deferred frame can overwrite newer input's caret.
    el.setRangeText(' ', at, to, 'end');
    setText(el.value);
  }, []);
  /** Call off the countdown; answers whether one was actually running. */
  const cancelSpaceHold = useCallback(() => {
    if (spaceHoldTimer.current === null) return false;
    window.clearTimeout(spaceHoldTimer.current);
    spaceHoldTimer.current = null;
    return true;
  }, []);
  const voiceCanStart = voice.supported && voice.readiness?.state === 'ready' && voice.phase === 'idle';
  // Round-2 alternatives for WHERE the listening feedback lives (see VoiceStyle).
  const voiceStyle = useContext(VoiceStyleContext);
  const voiceListening = voice.phase === 'listening';
  // Read by the window-level key handler further down, which is installed once
  // and must not be torn down and rebuilt every time the mic's phase changes.
  const voiceListeningRef = useRef(false);
  voiceListeningRef.current = voiceListening;
  const voiceStopRef = useRef(voice.stop);
  voiceStopRef.current = voice.stop;
  // Read by `send`, which cannot depend on them without rebuilding on every
  // partial — the same reason voiceListeningRef exists.
  const voicePhaseRef = useRef(voice.phase);
  voicePhaseRef.current = voice.phase;
  const voiceCancelRef = useRef(voice.cancel);
  voiceCancelRef.current = voice.cancel;

  // Let go of the walkie-talkie, whatever the reason.
  //
  // WHY this is not simply "on key-up": the hold has TWO stages, and both can
  // leak. For the first quarter second nothing is listening yet — only a timer
  // is counting down — and if the user alt-tabs in that window the timer still
  // fires, the microphone opens with the app in the background, and no key-up
  // ever arrives to close it. After that quarter second the microphone IS open,
  // and the same alt-tab would leave it open until the two-second silence stop
  // drops whatever the room said into the message box. So losing the box (or
  // the window, or the whole tab) cancels the countdown AND closes the mic.
  const releaseSpaceHold = useCallback(() => {
    if (spaceHoldTimer.current !== null) { window.clearTimeout(spaceHoldTimer.current); spaceHoldTimer.current = null; }
    if (spaceHeld.current) { spaceHeld.current = false; void voice.stop(); }
  }, [voice.stop]); // eslint-disable-line react-hooks/exhaustive-deps -- voice.stop is the only member read
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') releaseSpaceHold(); };
    window.addEventListener('blur', releaseSpaceHold);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', releaseSpaceHold);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [releaseSpaceHold]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Drive the same fade-edge treatment on the textarea itself. The mask fades
  // wrapped text that sits above/below the 3-line max-height viewport.
  useScrollFade<HTMLTextAreaElement>(inputRef);
  // Mirror content rendered behind the transparent textarea so ultrathink /
  // ultraplan / plan / brainstorm can flow with a gradient while the user types.
  // We translateY the inner div to keep its position in sync with the
  // textarea's scrollTop (overflow:hidden + transform is more reliable across
  // browsers than setting scrollTop on a hidden-overflow element).
  const mirrorContentRef = useRef<HTMLDivElement>(null);
  const dispatch = useChatDispatch();
  // Task 10 (Destin placement ruling): the stop control lives in the composer
  // row now, not beside ChatView's ThinkingIndicator. Fix (review finding,
  // 2026-07-22): useChatState(sessionId) here would re-render the composer —
  // a controlled textarea — on EVERY dispatch for this session, i.e. every
  // streaming token/tool delta, just to watch two booleans. useStreamingGate
  // is a derived cached selector (useSessionAttention.ts idiom) whose
  // getSnapshot returns a primitive, so useSyncExternalStore skips the
  // re-render whenever the gate itself hasn't flipped. The predicate is
  // "a turn is in flight and has not ended" — deliberately NOT
  // `attentionState === 'ok'`, which used to hide the button for the whole
  // stall countdown (see useStreamingGate.ts).
  const showStop = useStreamingGate(sessionId);

  // Per-session draft store — keeps input text and attachments separate
  // across sessions so switching away and back preserves your draft.
  const draftsRef = useRef<Map<string, { text: string; attachments: Attachment[] }>>(new Map());
  const prevSessionRef = useRef<string>(sessionId);
  useEffect(() => {
    const prev = prevSessionRef.current;
    if (prev === sessionId) return;
    // Save outgoing session's draft (read DOM directly to avoid stale closure)
    const outgoingText = inputRef.current?.value ?? text;
    if (outgoingText || attachments.length > 0) {
      draftsRef.current.set(prev, { text: outgoingText, attachments });
    } else {
      draftsRef.current.delete(prev);
    }
    // Restore incoming session's draft (or blank)
    const restored = draftsRef.current.get(sessionId);
    setText(restored?.text ?? '');
    setAttachments(restored?.attachments ?? []);
    prevSessionRef.current = sessionId;
  // ESLint needs `--` before the reason; without it the whole trailing phrase is
  // parsed as part of the rule name and the directive silently does nothing.
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps -- intentionally reads text/attachments from refs

  // Prefill support — used by dev:open-session-in (and any other caller that
  // supplies initialInput on a SessionInfo).  We track consumed session IDs in
  // a ref so the fill fires exactly once per session, never on re-renders.
  // The consumed-set approach avoids mutating the SessionInfo object directly
  // (which would be a side-effect against shared state).
  const consumedPrefillIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!initialInput?.trim() || consumedPrefillIds.current.has(sessionId)) return;
    consumedPrefillIds.current.add(sessionId);
    // Bound the set to prevent unbounded growth over long app lifetimes.
    // Oldest entries can't be re-triggered because their session IDs are
    // no longer active in the session list.
    if (consumedPrefillIds.current.size > 200) {
      const oldest = consumedPrefillIds.current.values().next().value;
      if (oldest !== undefined) consumedPrefillIds.current.delete(oldest);
    }
    setText(initialInput);
    // Focus the textarea so the user can review / edit / submit immediately.
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.setSelectionRange(initialInput.length, initialInput.length);
      }
    });
  }, [sessionId, initialInput]);

  // Ref to always-current send function so the global keydown handler
  // (which only depends on [disabled]) can call it without stale closures
  const sendRef = useRef<(force?: boolean) => void>(() => {});

  useImperativeHandle(ref, () => ({
    clear: () => {
      setText('');
      setAttachments([]);
      if (inputRef.current) inputRef.current.style.height = 'auto';
    },
    // Task 11: read the LIVE DOM value (not the `text` state closure) — mirrors
    // send()'s currentText read above, same stale-closure rationale.
    hasDraft: () => (inputRef.current?.value ?? text).trim().length > 0,
    // Mirrors the initialInput prefill effect above (setText + focus + caret
    // at the end) so an edited queued message gets the same "ready to review/
    // send" placement.
    fillDraft: (draftText: string) => {
      setText(draftText);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.setSelectionRange(draftText.length, draftText.length);
        }
      });
    },
  }));

  // Auto-focus input when user starts typing anywhere in the app.
  // When Enter is pressed while the textarea is blurred, we must also
  // preventDefault and send — otherwise the browser inserts a newline
  // into the newly-focused textarea instead of submitting the message.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (disabled) return;
      if (e.defaultPrevented) return;
      // isTypingTarget: covers INPUT/TEXTAREA and the CodeMirror editor (a
      // contenteditable DIV) — without it, every printable key typed in the
      // code editor yanks focus into the composer mid-word (spec §12.6).
      // WHY: a focused prompt/menu control owns Enter and arrows. Taking focus
      // here briefly moves it to the composer before that control can respond.
      if (isTypingTarget(e.target as Element) || isInteractiveTarget(e.target as Element)) return;
      // Focus textarea for paste shortcuts so Ctrl+V lands in the input
      // even after the idle blur timer has unfocused it
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        inputRef.current?.focus();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'Backspace' && e.key !== 'Enter' && e.key.length !== 1) return;
      inputRef.current?.focus();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        // The second of the two keyboard sites that stop the mic instead of
        // sending (the other is the textarea's own Enter branch). Enter with
        // the mic open closes it and leaves the words in the box; a second
        // Enter sends. The guard is deliberately NOT inside send(), which the
        // Send button and the "Send anyway" retry also call — see the note at
        // the textarea's Enter branch.
        if (voiceListeningRef.current) { void voiceStopRef.current(); return; }
        sendRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [disabled]);

  // Unfocus textarea after idle so global shortcuts (e.g. Shift to open
  // session switcher, Shift+Space to cycle model) work without conflicting.
  // Skip wherever a soft keyboard is in play: blurring the textarea dismisses
  // it, so the user has to re-tap the field after every brief pause. Those
  // global shortcuts are physical-keyboard-only (Shift-hold, Shift+Space,
  // Shift+Tab) and have no touch equivalent, so keeping focus costs nothing.
  //
  // Fix: this used to test isAndroid() alone, which missed a phone browser on
  // remote access — the host sends platform:'desktop' in auth:ok, so the shim
  // sets __PLATFORM__='desktop' and the device reports as neither 'android'
  // nor 'browser'. Feature-detect a coarse pointer instead of trusting the
  // platform string: it's the actual question being asked, and it correctly
  // keeps idle-blur ON for a desktop browser connecting remotely (real
  // keyboard, shortcuts useful, no soft keyboard to dismiss).
  const idleBlurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const el = inputRef.current;
    const hasSoftKeyboard = isAndroid()
      || window.matchMedia?.('(pointer: coarse)')?.matches === true;
    if (!el || hasSoftKeyboard) return;
    const resetTimer = () => {
      if (idleBlurTimer.current) clearTimeout(idleBlurTimer.current);
      idleBlurTimer.current = setTimeout(() => {
        // Never blur out from under a space-hold dictation. The hold releases on
        // blur, and this timer fires 750 ms after the last keydown — which is
        // fine while a held key repeats faster than that, but the repeat delay is
        // a system setting that can be longer, or switched off entirely. On such
        // a machine a walkie-talkie dictation would have been cut off silently,
        // three-quarters of a second in. Found reviewing T9, 2026-09-05.
        if (spaceHeld.current || spaceHoldTimer.current !== null) return;
        if (document.activeElement === el) el.blur();
      }, 750);
    };
    el.addEventListener('keydown', resetTimer);
    el.addEventListener('input', resetTimer);
    el.addEventListener('paste', resetTimer);
    return () => {
      el.removeEventListener('keydown', resetTimer);
      el.removeEventListener('input', resetTimer);
      el.removeEventListener('paste', resetTimer);
      if (idleBlurTimer.current) clearTimeout(idleBlurTimer.current);
    };
  }, []);

  const addFiles = useCallback((paths: string[]) => {
    setAttachments((prev) => {
      const existing = new Set(prev.map((a) => a.path));
      const newOnes = paths
        .filter((p) => !existing.has(p))
        .map((p) => ({ path: p, name: fileNameFromPath(p), isImage: isImagePath(p) }));
      return [...prev, ...newOnes];
    });
  }, []);

  // External attach-file entry point. Used by the buddy floater's
  // desktop-capture action — main writes the screenshot to a temp PNG and
  // pushes the path via BUDDY_ATTACH_FILE; BuddyChat re-dispatches as this
  // window CustomEvent so InputBar picks it up without prop threading.
  // The same addFiles path handles it (identical to clipboard-image paste),
  // so no special-casing for capture vs paste.
  useEffect(() => {
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<{ filePath?: string }>).detail;
      if (detail?.filePath) addFiles([detail.filePath]);
    };
    window.addEventListener('buddy:attach-file', listener);
    return () => window.removeEventListener('buddy:attach-file', listener);
  }, [addFiles]);

  // External "insert into composer" entry point — the chat right-click menu's
  // "Ask about this" action dispatches this window CustomEvent with a pre-built
  // quote + follow-up scaffold. Mirrors buddy:attach-file so no prop threading
  // is needed. We PREPEND the scaffold and drop the caret right after it, so any
  // draft the user was already typing survives as the follow-up text.
  useEffect(() => {
    const listener = (e: Event) => {
      const insert = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (!insert) return;
      setText((prev) => insert + prev);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(insert.length, insert.length);
      });
    };
    window.addEventListener('youcoded:compose-insert', listener);
    return () => window.removeEventListener('youcoded:compose-insert', listener);
  }, []);

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  }, []);

  // Returns true when the message was consumed (input can clear), false when
  // the send was refused and the draft should stay in the input bar.
  const sendMessage = useCallback(
    (message: string, files: Attachment[] = [], force = false): boolean => {
      // Prompt gate: while a permission request / AskUserQuestion / plan
      // approval / trust prompt is pending, Claude Code's native Ink select
      // menu is LIVE in the PTY. Anything we write would be interpreted as
      // menu keystrokes — the trailing \r would press Enter on the highlighted
      // option, silently answering the prompt with the user's text lost.
      // Refuse the send (keeping the draft) and tell the user why.
      //
      // Native sessions have no PTY and no Ink select menu — the pending-
      // interaction gate is a PTY-only concern, so skip it. (A provider/stream
      // failure surfaces on the error banner instead of blocking sends.)
      // `force` is the "Send anyway" override (below): the gate already refused
      // once and the user chose to push through, so skip the re-check.
      if (!force && provider !== 'native') {
        const session = getSessionState?.(sessionId);
        if (session && hasPendingInteraction(session)) {
          // Offer an ESC-first escape hatch instead of a dead-end toast: press
          // ESC (closes any genuinely-live Ink menu; a no-op on an idle input
          // bar, so it can NEVER answer a real menu), then re-send with the
          // gate bypassed. Falls back to a plain toast where App wired no
          // handler (e.g. the minimal touch bar). See pty-input-gate.ts.
          if (onSendBlocked) {
            onSendBlocked(() => {
              window.claude.session.sendInput(sessionId, '\x1b');
              sendRef.current(true);
            });
          } else {
            onToast?.('Claude is waiting for your response — answer the prompt first.');
          }
          return false;
        }
      }

      // Route slash commands through the central dispatcher BEFORE attachment
      // merging so the intercept sees the pristine command text (not "file.txt /clear").
      // The dispatcher decides: fully intercept, forward-and-intercept, or let through.
      const dispatchResult = dispatchSlashCommand({
        raw: message,
        sessionId,
        view: view ?? 'chat',
        files,
        dispatch,
        timeline: [], // Day 1: unused; will wire per-session timeline on Day 2 when commands need it
        callbacks: { onResumeCommand, getUsageSnapshot, onOpenPreferences, onToast, getSessionState, onOpenModelPicker },
        // Native /clear is durable-first — see deferUiEffectsToRuntime.
        deferUiEffectsToRuntime: provider === 'native',
      });
      // routeSlashResult owns the ordering: nativeAction is consulted BEFORE
      // `handled`, because an unrecognized slash command is handled:false — so
      // Claude Code still forwards it to the PTY untouched — while carrying an
      // invoke-skill intent for native sessions (M3 item 1).
      const route = routeSlashResult(provider, dispatchResult);
      if (route.via === 'native') {
        void runNativeSlashAction(route.action, { sessionId, dispatch, onToast });
        return true;
      }
      if (route.via === 'pty') {
        // For commands like /clear and /compact that still need Claude Code's own state to change.
        window.claude.session.sendInput(sessionId, route.text);
        return true;
      }
      if (route.via === 'none-native-no-pty') {
        // Native sessions have no PTY to forward to, and this command has no
        // harness equivalent yet. Tell the user rather than silently dropping.
        onToast?.(`${route.command} isn't available in YouCoded-runtime sessions yet.`);
        return true;
      }
      if (route.via === 'none') return true;
      // Dispatcher may rewrite the message (e.g. strip escape-hatch backslash).
      // The `handled` test is what narrows the union for TS — reaching here means
      // routeSlashResult returned 'passthrough', which only the unhandled branch
      // produces, but the compiler can't see that through the route value.
      const effectiveMessage = (!dispatchResult.handled && dispatchResult.rewritten) || message;

      // One sanitized source string for BOTH the optimistic bubble and the PTY
      // send. The transcript confirms the bubble by EXACT content match, so if
      // the bubble kept newlines the send stripped, a multiline message could
      // never be confirmed — `pending` stayed set forever and
      // useSubmitConfirmation fired a stray recovery \r. See outgoing-message.ts.
      const outgoing = buildOutgoingMessage(effectiveMessage, files.map((f) => f.path));
      if (!outgoing) return true; // nothing to send — treat as consumed
      if (disabled) return false;

      // M1 (bubble-after-ack, BUG C): native has no PTY, so the OLD code
      // dispatched the optimistic bubble unconditionally, same as the CC path
      // below. But a native send can come back QUEUED (host FIFO'd it behind
      // an in-flight turn) or FAILED (not-live / queue-full) — dispatching
      // before knowing the ack produced a phantom bubble on a refused send,
      // and a naive queued dispatch would fork the still-streaming prior turn
      // (see the `queued` branch in chat-reducer.ts USER_PROMPT). So the
      // native branch awaits the ack FIRST and dispatches (or toasts) after —
      // it RETURNs before the CC/PTY dispatch and paste machinery below.
      if (provider === 'native') {
        void (async () => {
          // Fix (final-review Important, 2026-07-22): the host's send() itself
          // never rejects (NativeSessionHost.send() is documented SYNCHRONOUS
          // and NEVER throws), but the invoke() HOP to get there can — version
          // skew on the IPC channel, or (on remote access) the WebSocket
          // dropping mid-round-trip. An unhandled rejection here would toast
          // nothing and silently vanish the draft, so a rejection is routed
          // through the EXACT same failure branch as a failed/undefined ack
          // (same toast copy, same guarded draft restore) rather than treated
          // as a distinct case — from the user's point of view a refused send
          // and a lost send look identical: their message didn't go anywhere.
          let result: NativeSendResult | undefined;
          try {
            result = await sendChatMessage('native', sessionId, outgoing.ptyText, files.map((f) => f.path));
          } catch (err) {
            console.error('native send invoke rejected:', err);
          }
          if (!result || result.status === 'failed') {
            onToast?.(sendFailureCopy(result));
            // Fix (reviewer Critical, post-de30b908): `send()` already ran
            // setText('')/setAttachments([]) synchronously right after this
            // function returned `true` — a failed ack must not silently lose
            // the draft (the file's own invariant, documented at send()'s
            // `if (!sendMessage(...)) return;`, says a refused send keeps the
            // draft). Restore effectiveMessage (pre-sanitize, keeps newlines —
            // what was actually in the textarea) and the original files.
            // Guarded: only refill if the user hasn't typed/attached something
            // new during the ack round-trip (a local IPC invoke, ~ms) — never
            // clobber newer input.
            setText((cur) => (cur.trim() ? cur : effectiveMessage));
            setAttachments((cur) => (cur.length > 0 ? cur : files));
            return;
          }
          // Task 12: a 'queued' ack dispatches QUEUED_MESSAGE_ADDED instead of
          // USER_PROMPT — the docked strip renders it, NOT the timeline (the
          // Task 3/11 bug this replaces: an enqueue-time timeline bubble
          // froze above content the still-streaming prior turn hadn't
          // emitted yet). A 'sent' ack is unchanged: nothing is streaming, so
          // the optimistic bubble's position is already correct.
          if (result.status === 'queued') {
            dispatch({
              type: 'QUEUED_MESSAGE_ADDED',
              sessionId,
              queueId: result.queueId,
              content: outgoing.content,
              timestamp: Date.now(),
            });
          } else {
            dispatch({
              type: 'USER_PROMPT',
              sessionId,
              content: outgoing.content,
              timestamp: Date.now(),
              attachments: files.map((f) => f.path),
            });
          }
        })();
        return true;
      }

      // CC/PTY path (unchanged): dispatch the optimistic bubble BEFORE
      // sending — Claude Code's transcript watcher confirms it once the JSONL
      // line lands (see TRANSCRIPT_USER_MESSAGE dedup).
      dispatch({
        type: 'USER_PROMPT',
        sessionId,
        content: outgoing.content,
        timestamp: Date.now(),
        // Exact attachment paths so UserMessage can render each as a clickable
        // pill — file-picker paths routinely contain spaces, which the joined
        // content string can't be split back out of.
        attachments: files.map((f) => f.path),
      });

      // Sending strategy:
      //
      // Claude Code's input handler auto-resolves file paths into attachments,
      // but if multiple paths arrive within Ink's 500ms PASTE_TIMEOUT, they
      // coalesce into a single paste event and each new path-detection REPLACES
      // the staged attachment instead of appending (verified via transcript
      // JSONL: a 4-image send showed only the last image in the content array).
      //
      // Fix: send each path 600ms apart (> 500ms PASTE_TIMEOUT) so each path
      // is a discrete paste event and Claude's autocomplete accumulates them.
      // Then send the user's text + \r as one write — the pty-worker splits it
      // into "text" + 600ms gap + "\r" so Enter arrives after the paste commits
      // (previously this was two scattered setTimeouts in the renderer).
      const FILE_GAP_MS = 600; // > Ink's 500ms PASTE_TIMEOUT — breaks paste buffer between paths

      files.forEach((f, idx) => {
        setTimeout(() => {
          window.claude.session.sendInput(sessionId, f.path + ' ');
        }, idx * FILE_GAP_MS);
      });

      // After all files, send text+\r as one write. pty-worker auto-splits
      // on trailing \r with a 600ms gap so Enter isn't swallowed by paste mode.
      // Attachments-only case: send just "\r" (single char, no split applied).
      const submitStart = files.length * FILE_GAP_MS;
      setTimeout(() => {
        window.claude.session.sendInput(sessionId, outgoing.ptyText + '\r');
      }, submitStart);
      return true;
    },
    [sessionId, disabled, dispatch, view, provider, onResumeCommand, getUsageSnapshot, onOpenPreferences, onToast, onSendBlocked, getSessionState, onOpenModelPicker],
  );

  // Auto-resize textarea to fit content, up to 3 lines then scroll
  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseInt(getComputedStyle(el).lineHeight) || 21;
    const maxHeight = lineHeight * 3;
    const clamped = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${clamped}px`;
    // Always keep native scrollbar hidden — scroll-fade provides the affordance
    // via mask gradient instead. overflow-y stays on 'auto' so wheel/keyboard
    // scrolling still works when content exceeds max height.
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
    // Keep the flowing-keyword mirror aligned with the textarea's scroll
    if (mirrorContentRef.current) {
      mirrorContentRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
    }
  }, []);

  // Fix (intermittent empty-input-expands-to-3-lines bug): recompute the
  // textarea height SYNCHRONOUSLY before paint, not after. The height is an
  // imperative inline style React doesn't track, so when `text` shrinks back
  // to '' via a cascading update (e.g. the session-switch effect calling
  // setText, or send/clear), a plain useEffect could let React paint one frame
  // with the empty value but the stale multi-line height still applied — the
  // placeholder floated to the top of a 3-line box until the next keystroke
  // re-ran this. useLayoutEffect closes that paint-before-correction window.
  useLayoutEffect(() => {
    autoResize();
  }, [text, autoResize]);

  const send = useCallback((force = false) => {
    // Read directly from the DOM element to avoid stale-closure races
    // where paste + immediate Enter outrun React's render cycle
    const currentText = inputRef.current?.value ?? text;
    // A refused send (pending prompt gate, disabled session) keeps the draft
    // in the input bar so the user's text isn't lost. `force` is the "Send
    // anyway" override, which re-enters here past the gate (see sendMessage).
    if (!sendMessage(currentText, attachments, force)) return;
    // The message has gone, so the dictation behind it goes too. Without this,
    // sending mid-sentence sent the unsettled GREY words along with it AND left
    // them in the box, and the next thing the engine said re-typed the whole
    // utterance — so the user had to delete a copy of what they had just sent,
    // with the microphone still open. `cancel` emits nothing (the event contract
    // in voice-types.ts), so no late words can arrive after this either.
    // Found reviewing T9, 2026-09-05.
    setVoiceTail('');
    voiceBaseRef.current = '';
    if (voicePhaseRef.current !== 'idle') void voiceCancelRef.current();
    setText('');
    setAttachments([]);
    draftsRef.current.delete(sessionId); // Clear stored draft after sending
    onCloseDrawer?.();
    // Reset height after clearing
    if (inputRef.current) inputRef.current.style.height = 'auto';
  }, [text, attachments, sendMessage, onCloseDrawer, sessionId]);

  // Keep sendRef pointing at the latest send so the global keydown handler
  // (which can't depend on send without thrashing the listener) stays current
  useEffect(() => { sendRef.current = send; }, [send]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (minimal && sessionId) {
      const val = inputRef.current?.value ?? text;
      // pty-worker auto-splits text+\r with a 600ms gap so Enter isn't
      // swallowed by Ink's paste buffer. No renderer-side setTimeout needed.
      window.claude.session.sendInput(sessionId, val + '\r');
      setText('');
      if (inputRef.current) {
        inputRef.current.value = '';
        inputRef.current.style.height = 'auto';
      }
    } else {
      send();
    }
  };

  const handleChip = useCallback(
    (chip: QuickChip) => {
      // All chips fill the input bar for the user to review/edit/send — never auto-send.
      setText(chip.prompt);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.setSelectionRange(chip.prompt.length, chip.prompt.length);
        }
      });
    },
    [],
  );

  const handleAttachClick = useCallback(async () => {
    try {
      const paths = await window.claude.dialog.openFile();
      if (paths.length > 0) {
        addFiles(paths);
      }
    } catch (err) {
      console.error('Failed to open file dialog:', err);
    }
  }, [addFiles]);

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    // Only treat as image paste if there's no text content — copying from
    // web pages often includes both text/plain and image/png items, and
    // we don't want to block the text paste in that case.
    const hasText = Array.from(items).some((item) => item.type.startsWith('text/'));
    if (hasText) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const saved = await window.claude.dialog.saveClipboardImage();
        if (saved) addFiles([saved]);
        return;
      }
    }
  }, [addFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const paths = Array.from(e.dataTransfer.files).map((f) => (f as any).path as string).filter(Boolean);
    if (paths.length > 0) addFiles(paths);
  }, [addFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  textRef.current = text;

  return (
    <div
      className="input-bar-container shrink-0"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Terminal view (minimal) renders the Esc/Tab/Ctrl/arrow helper row in
          the same slot QuickChips occupies in chat view, so both modes share
          the same "pill row above input bar" visual inside one container. */}
      {minimal && <TerminalToolbar sessionId={sessionId} />}
      {!minimal && !compact && <QuickChips onChipTap={handleChip} />}

      {attachments.length > 0 && (
        <div className="flex gap-2 px-3 py-2 overflow-x-auto">
          {/* Design C (Destin, 2026-08-27, ledger P-19): a 128×96 card with a
              real preview — picture, RENDERED markdown, or mono text — the name
              in a strip along the bottom, and the ✕ always visible. The card
              itself lives in AttachmentChip.tsx; the mock-up page renders the
              same component so the two cannot drift. */}
          {attachments.map((att) => (
            <AttachmentChip
              key={att.path}
              path={att.path}
              name={att.name}
              onRemove={() => removeAttachment(att.path)}
            />
          ))}
        </div>
      )}

      {/* Feedback B: the app's thin status band, above the box, while listening. */}
      {voiceListening && voiceStyle.feedback === 'strip' && (
        <div className="px-2 sm:px-3 pb-1.5">
          <StatusStrip
            tone="ok"
            action={<Button variant="secondary" size="sm" onClick={() => { void voice.stop(); }}>Stop</Button>}
          >
            <span className="inline-flex items-center gap-3">Listening <VoiceMeter level={voice.level} seconds={voice.seconds} /></span>
          </StatusStrip>
        </div>
      )}
      <div className="px-2 sm:px-3 pb-1 sm:pb-1.5">
        <form onSubmit={handleSubmit} className="flex items-center gap-1.5 sm:gap-2 bg-inset rounded-xl px-2 sm:px-3 py-2">
          <BrailleBurst
            onTrigger={handleAttachClick}
            disabled={disabled}
            className="shrink-0 text-fg-dim hover:text-fg disabled:opacity-30 transition-colors"
            title="Attach file"
          >
            <AttachIcon className="w-5 h-5" />
          </BrailleBurst>
          {!minimal && (
            <BrailleBurst
              onTrigger={() => onOpenDrawer?.(false)}
              disabled={disabled}
              className="shrink-0 text-fg-dim hover:text-fg disabled:opacity-30 transition-colors"
              title="Browse skills"
            >
              <CompassIcon className="w-5 h-5" />
            </BrailleBurst>
          )}
          <div className="relative flex-1">
            {/* Feedback C: meter and clock in the empty line, gone once words arrive. */}
            {voiceListening && voiceStyle.feedback === 'placeholder' && !text && !voiceTail && (
              <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 flex items-center gap-2 text-sm text-fg-muted">
                <span>Listening</span>
                <VoiceMeter level={voice.level} seconds={voice.seconds} />
              </div>
            )}
            {/* Mirror layer: renders the same text behind the transparent
                textarea, with keyword spans that animate via CSS. aria-hidden
                because the textarea still owns the accessible value. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden"
            >
              <div
                ref={mirrorContentRef}
                // input-bar-mirror-content: lets the ≤768px media query bump
                // this div's font-size to 16px so it stays in lockstep with
                // the textarea (which is already forced to 16px to prevent
                // iOS auto-zoom). Without this, narrow windows and Android
                // rendered the mirror at 14px while the caret was placed
                // for 16px text — characters drifted off the caret.
                className="input-bar-mirror-content text-sm text-fg leading-snug whitespace-pre-wrap break-words"
              >
                <FlowingKeywordsText text={text} />
                {voiceTail && <span className="text-fg-muted">{voiceTail}</span>}
                {/* Zero-width char keeps a trailing newline visible in the mirror */}
                {'\u200B'}
              </div>
            </div>
          <textarea
            ref={inputRef}
            value={text + voiceTail}
            rows={1}
            // Disable spellcheck — with transparent text + mirror overlay, the
            // red/blue squiggles render on top of the mirror and look like bugs.
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            onScroll={(e) => {
              if (mirrorContentRef.current) {
                mirrorContentRef.current.style.transform = `translateY(${-e.currentTarget.scrollTop}px)`;
              }
            }}
            onChange={(e) => {
              const val = e.target.value;
              // Typing while the mic is open ends dictation, and EVERYTHING in the
              // box stays — including the grey, still-being-reconsidered words.
              //
              // Fix (whole-branch review F4): this comment used to say the grey
              // words were dropped, which is the opposite of what happens. The
              // textarea's value is the solid text plus the grey tail, so a
              // keystroke arrives as all of it plus the new character, and the
              // line below promotes the lot to solid. That is the RIGHT behaviour
              // — words the user watched appear must not vanish when they reach
              // for the keyboard — but the comment claiming otherwise would have
              // sent the next session "fixing" it in the wrong direction.
              if (voice.phase !== 'idle') { void voice.cancel(); setVoiceTail(''); }
              setText(val);
              // Detect "/" typed as first character — open drawer in search mode
              if (val === '/' && text === '') {
                onOpenDrawer?.(true);
                onDrawerSearch?.('');
              } else if (val.startsWith('/') && text.startsWith('/')) {
                // Continue updating drawer filter as user types after "/"
                onDrawerSearch?.(val.slice(1));
              } else if (!val.startsWith('/') && text.startsWith('/')) {
                // User deleted the "/" — close the drawer
                onCloseDrawer?.();
              }
            }}
            onKeyDown={(e) => {
              // Hold Space anywhere in the box = walkie-talkie (see spaceHoldTimer).
              if (e.key === ' ' && !minimal) {
                // Already talking: the space bar belongs to the microphone.
                if (spaceHeld.current) { e.preventDefault(); return; }
                // A hold is already counting down, so this is the keyboard
                // repeating itself — swallowed WITHOUT asking the event whether
                // it is a repeat, which is the question that made this a gamble.
                if (spaceHoldTimer.current !== null) { e.preventDefault(); return; }
                if (voiceCanStart) {
                  // Type nothing yet. Either the hold matures and this was never
                  // meant to be a space, or it does not and the space goes in
                  // below — in the right place, exactly once.
                  e.preventDefault();
                  spaceHoldTimer.current = window.setTimeout(() => {
                    spaceHoldTimer.current = null;
                    spaceHeld.current = true;
                    startVoice();
                  }, SPACE_HOLD_MS);
                  return;
                }
              }
              // Any other key while a hold is counting down means the user was
              // typing, not reaching for the microphone. The swallowed space goes
              // in BEFORE this key does.
              if (spaceHoldTimer.current !== null && e.key !== ' ') {
                cancelSpaceHold();
                commitPendingSpace();
              }
              // Enter sends, Shift+Enter inserts newline
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                // Enter while the mic is open STOPS it and sends nothing: the
                // words wait in the box and a second Enter sends them, exactly
                // as if they had been typed (deck V-6, contract R3).
                //
                // WHY the guard is here and in the window-level handler above,
                // and NOT inside send(): the Send button submits the form
                // through send(), and so does the "Send anyway" retry after a
                // blocked send. A guard inside send() would silently turn both
                // of those into a stop — a button that says Send and doesn't.
                if (voiceListening) { void voice.stop(); return; }
                if (minimal && sessionId) {
                  // Terminal mode: send text + Enter directly to PTY.
                  // pty-worker auto-splits text+\r with a 600ms gap so Ink
                  // sees Enter as a distinct keystroke after paste commits.
                  const val = inputRef.current?.value ?? text;
                  window.claude.session.sendInput(sessionId, val + '\r');
                  setText('');
                  if (inputRef.current) {
                    inputRef.current.value = '';
                    inputRef.current.style.height = 'auto';
                  }
                } else {
                  send();
                }
              }
            }}
            onKeyUp={(e) => {
              if (e.key !== ' ') return;
              // Let go before the hold matured: that was a space, not a walkie-
              // talkie. This is the only place a held space ever becomes text.
              const wasPending = cancelSpaceHold();
              releaseSpaceHold();
              if (wasPending) commitPendingSpace();
            }}
            // The box losing focus mid-hold ends the hold too — see
            // releaseSpaceHold. (The idle-unfocus timer below cannot trip this:
            // a held key repeats, and every repeat resets that timer.)
            onBlur={releaseSpaceHold}
            onPaste={handlePaste}
            placeholder={disabled ? 'Waiting for approval...' : voiceListening ? (voiceStyle.feedback === 'placeholder' ? '' : 'Listening…') : 'Message Claude...'}
            disabled={disabled}
            // Text color is transparent so the mirror div behind it shows
            // through (with animated keyword spans). caret-color keeps the
            // cursor visible. Selection highlight still renders from the
            // browser. Placeholder uses its own color token so it's unaffected.
            // Fix: Chromium's UA default font-family for <textarea> is
            // monospace, which makes glyph widths diverge from the sans-font
            // mirror div behind it — the caret drifts ahead of the visible
            // keyword text as you type, and selection reveals a second copy
            // of the text. Inherit font metrics from the parent so both
            // layers measure identically.
            style={{ caretColor: 'var(--fg)', fontFamily: 'inherit', letterSpacing: 'inherit' }}
            // break-words makes the textarea wrap long URLs/paths at the same
            // character position as the mirror (which also has break-words).
            // Without this, textarea used Chromium's default algorithm and
            // picked slightly different break points — every subsequent line's
            // offset compounded, so the caret drift got worse the longer the
            // message. Both layers now use overflow-wrap: break-word.
            className="input-bar-textarea scroll-fade relative block w-full bg-transparent text-sm text-transparent placeholder-fg-muted outline-none disabled:opacity-50 resize-none leading-snug p-0 m-0 align-middle break-words"
          />
          </div>
          {/* Task 10: stop control moved here from ChatView (beside the
              ThinkingIndicator) per Destin's placement ruling — immediately
              left of send, same size="icon" scale, shrink-0 so it doesn't
              squeeze the textarea.
              `visible` is useStreamingGate(sessionId) — "a turn is in flight
              and has not ENDED". It is NO LONGER `isThinking &&
              attentionState === 'ok'` (that stale wording was corrected here
              on 2026-08-16): the button deliberately stays through the amber
              stall warning and the red parked card, because those turns are
              still running and that is precisely when a user with no ESC key
              needs a way out. See useStreamingGate.ts. */}
          {/* Voice prompting: the mic sits where the eye already goes to
              send. Hidden entirely when the host has no speech engine
              (remote browser, older builds) and in terminal view. */}
          {!minimal && voice.supported && (
            <VoiceButton
              phase={voice.phase}
              readiness={voice.readiness}
              level={voice.level}
              seconds={voice.seconds}
              error={voice.error}
              disabled={disabled}
              onStart={startVoice}
              onStop={() => { void voice.stop(); }}
              onDownload={() => { void voice.download(); }}
              onRecheck={() => { void voice.recheck(); }}
              onClearError={voice.clearError}
              onReady={() => onToast?.('Voice is ready — tap the mic to talk.')}
            />
          )}
          <StopButton sessionId={sessionId} provider={provider} visible={showStop} />
          {/* The app's most-used control. Geometry is unchanged — 28x28 is exactly
              what size="icon" emits — and it keeps `bg-accent`, which matters:
              community packs style the send button through `.bg-accent` (Halftone's
              custom_css glow), so a variant without that class would silently drop
              their glow. What changes: a real hover (hover:brightness-110 is
              imperceptible on Light/Creme's near-black accent) and a focus ring.
              disabled:opacity-30 is kept deliberately — it is dimmer than the
              primitive's 50%, because an un-sendable composer should read as clearly
              inert rather than merely faded. */}
          <Button
            type="submit"
            size="icon"
            aria-label="Send message"
            disabled={disabled || (!minimal && !text.trim() && attachments.length === 0)}
            className="shrink-0 disabled:opacity-30"
          >
            <svg className="w-4 h-4 text-on-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </Button>
        </form>
      </div>
    </div>
  );
});

export default InputBar;
