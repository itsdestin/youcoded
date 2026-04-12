import React, { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef } from 'react';
import { useChatDispatch } from '../state/chat-context';
import QuickChips, { QuickChip } from './QuickChips';
import { AttachIcon, CompassIcon } from './Icons';
import BrailleBurst from './BrailleBurst';
import FlowingKeywordsText from './FlowingKeywords';
// Central slash-command router. All /-prefixed messages flow through here
// so interception is consistent between typed input and drawer selection.
import { dispatchSlashCommand, type ViewMode } from '../state/slash-command-dispatcher';
import type { UsageSnapshot } from '../state/chat-types';

export interface InputBarHandle {
  clear: () => void;
}

interface Props {
  sessionId: string;
  disabled?: boolean;
  minimal?: boolean;
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
  // /copy needs to read assistant turns from session state to extract blocks
  getSessionState?: (sessionId: string) => import('../state/chat-types').SessionChatState | undefined;
  // Bare /model, /fast, /effort open the unified ModelPickerPopup
  onOpenModelPicker?: () => void;
}

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

const InputBar = forwardRef<InputBarHandle, Props>(function InputBar({ sessionId, disabled, minimal, view, onOpenDrawer, onCloseDrawer, onDrawerSearch, onResumeCommand, getUsageSnapshot, onOpenPreferences, onToast, getSessionState, onOpenModelPicker }, ref) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Mirror content rendered behind the transparent textarea so ultrathink /
  // ultraplan / plan / brainstorm can flow with a gradient while the user types.
  // We translateY the inner div to keep its position in sync with the
  // textarea's scrollTop (overflow:hidden + transform is more reliable across
  // browsers than setting scrollTop on a hidden-overflow element).
  const mirrorContentRef = useRef<HTMLDivElement>(null);
  const dispatch = useChatDispatch();

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
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps — intentionally reads text/attachments from refs

  // Ref to always-current send function so the global keydown handler
  // (which only depends on [disabled]) can call it without stale closures
  const sendRef = useRef<() => void>(() => {});

  useImperativeHandle(ref, () => ({
    clear: () => {
      setText('');
      setAttachments([]);
      if (inputRef.current) inputRef.current.style.height = 'auto';
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
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
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
        sendRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [disabled]);

  // Unfocus textarea after idle so global shortcuts (e.g. Shift to open
  // session switcher, Shift+Space to cycle model) work without conflicting
  const idleBlurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const resetTimer = () => {
      if (idleBlurTimer.current) clearTimeout(idleBlurTimer.current);
      idleBlurTimer.current = setTimeout(() => {
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

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  }, []);

  const sendMessage = useCallback(
    (message: string, files: Attachment[] = []) => {
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
      });
      if (dispatchResult.handled) {
        if (dispatchResult.alsoSendToPty) {
          // For commands like /clear and /compact that still need Claude Code's own state to change.
          window.claude.session.sendInput(sessionId, dispatchResult.alsoSendToPty);
        }
        return;
      }
      // Dispatcher may rewrite the message (e.g. strip escape-hatch backslash)
      const effectiveMessage = dispatchResult.rewritten ?? message;

      const userText = effectiveMessage.trim();
      const hasFiles = files.length > 0;
      if (!userText && !hasFiles) return;
      if (disabled) return;

      // Optimistic chat bubble: show what the user sent (paths + text,
      // space-joined) before Claude's transcript event arrives.
      const displayCombined = [...files.map((f) => f.path), userText].filter(Boolean).join(' ');
      dispatch({
        type: 'USER_PROMPT',
        sessionId,
        content: displayCombined,
        timestamp: Date.now(),
      });

      // Sending strategy:
      //
      // Claude Code's input handler auto-resolves file paths into attachments
      // — but if multiple paths arrive in one PTY write, each new detection
      // REPLACES the staged attachment instead of appending. Result: only
      // the last image survives (verified via transcript JSONL — content
      // array had only [Image #4] when 4 were attached).
      //
      // Fix: send each path as its own PTY write with a gap between so
      // Claude processes each as a discrete attachment and they accumulate.
      // Then send the user's text (if any), wait 700ms for Ink's 500ms
      // PASTE_TIMEOUT to clear, then \r to submit.
      //
      // Newlines in user text are replaced with spaces so they don't act
      // as early Enters.
      const FILE_GAP_MS = 350; // time for Claude to ingest each attachment
      const PASTE_SETTLE_MS = 700; // > Ink's 500ms PASTE_TIMEOUT
      const sanitizedText = userText.replace(/[\r\n]+/g, ' ');

      files.forEach((f, idx) => {
        setTimeout(() => {
          window.claude.session.sendInput(sessionId, f.path + ' ');
        }, idx * FILE_GAP_MS);
      });

      const textStart = files.length * FILE_GAP_MS;
      if (sanitizedText) {
        setTimeout(() => {
          window.claude.session.sendInput(sessionId, sanitizedText);
        }, textStart);
      }

      setTimeout(() => {
        window.claude.session.sendInput(sessionId, '\r');
      }, textStart + PASTE_SETTLE_MS);
    },
    [sessionId, disabled, dispatch, view, onResumeCommand, getUsageSnapshot, onOpenPreferences, onToast, getSessionState, onOpenModelPicker],
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
    // Only show scrollbar when content actually overflows the max height
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
    // Keep the flowing-keyword mirror aligned with the textarea's scroll
    if (mirrorContentRef.current) {
      mirrorContentRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
    }
  }, []);

  useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  const send = useCallback(() => {
    // Read directly from the DOM element to avoid stale-closure races
    // where paste + immediate Enter outrun React's render cycle
    const currentText = inputRef.current?.value ?? text;
    sendMessage(currentText, attachments);
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
      // Split text and Enter into separate PTY writes (see sendMessage comment)
      window.claude.session.sendInput(sessionId, val);
      setTimeout(() => window.claude.session.sendInput(sessionId, '\r'), 50);
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
      // If prompt ends with a space, it's a template — insert into input for the user to complete
      if (chip.prompt.endsWith(' ')) {
        setText(chip.prompt);
        requestAnimationFrame(() => {
          if (inputRef.current) {
            inputRef.current.focus();
            inputRef.current.setSelectionRange(chip.prompt.length, chip.prompt.length);
          }
        });
      } else {
        sendMessage(chip.prompt);
      }
    },
    [sendMessage],
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

  return (
    <div
      className="input-bar-container border-t border-edge shrink-0"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {!minimal && <QuickChips onChipTap={handleChip} />}

      {attachments.length > 0 && (
        <div className="flex gap-2 px-3 py-2 overflow-x-auto">
          {attachments.map((att) => (
            <div key={att.path} className="relative shrink-0 group">
              {att.isImage ? (
                <img
                  src={`file://${att.path.replace(/\\/g, '/')}`}
                  alt={att.name}
                  loading="lazy"
                  className="w-12 h-12 rounded-md object-cover border border-edge"
                />
              ) : (
                <div className="w-12 h-12 rounded-md border border-edge bg-panel flex items-center justify-center">
                  <span className="text-[9px] text-fg-dim text-center leading-tight px-1 truncate">
                    {att.name}
                  </span>
                </div>
              )}
              <button
                onClick={() => removeAttachment(att.path)}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-inset text-fg-2 hover:bg-edge flex items-center justify-center text-[10px] leading-none opacity-0 group-hover:opacity-100 transition-opacity"
              >
                ×
              </button>
            </div>
          ))}
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
            {/* Mirror layer: renders the same text behind the transparent
                textarea, with keyword spans that animate via CSS. aria-hidden
                because the textarea still owns the accessible value. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden"
            >
              <div
                ref={mirrorContentRef}
                className="text-sm text-fg leading-snug whitespace-pre-wrap break-words"
              >
                <FlowingKeywordsText text={text} />
                {/* Zero-width char keeps a trailing newline visible in the mirror */}
                {'\u200B'}
              </div>
            </div>
          <textarea
            ref={inputRef}
            value={text}
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
              // Enter sends, Shift+Enter inserts newline
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (minimal && sessionId) {
                  // Terminal mode: send text + Enter directly to PTY.
                  // Split into two writes so Ink processes them in separate reads.
                  const val = inputRef.current?.value ?? text;
                  window.claude.session.sendInput(sessionId, val);
                  setTimeout(() => window.claude.session.sendInput(sessionId, '\r'), 50);
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
            onPaste={handlePaste}
            placeholder={disabled ? 'Waiting for approval...' : 'Message Claude...'}
            disabled={disabled}
            // Text color is transparent so the mirror div behind it shows
            // through (with animated keyword spans). caret-color keeps the
            // cursor visible. Selection highlight still renders from the
            // browser. Placeholder uses its own color token so it's unaffected.
            style={{ caretColor: 'var(--fg)' }}
            className="relative block w-full bg-transparent text-sm text-transparent placeholder-fg-muted outline-none disabled:opacity-50 resize-none overflow-y-hidden leading-snug p-0 m-0 align-middle"
          />
          </div>
          <button
            type="submit"
            disabled={disabled || (!minimal && !text.trim() && attachments.length === 0)}
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg bg-accent hover:brightness-110 disabled:opacity-30 transition-colors"
          >
            <svg className="w-4 h-4 text-on-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
});

export default InputBar;
