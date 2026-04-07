import React, { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef } from 'react';
import { useChatDispatch } from '../state/chat-context';
import QuickChips, { QuickChip } from './QuickChips';
import { AttachIcon, CompassIcon } from './Icons';
import BrailleBurst from './BrailleBurst';

export interface InputBarHandle {
  clear: () => void;
}

interface Props {
  sessionId: string;
  disabled?: boolean;
  minimal?: boolean;
  onOpenDrawer?: (searchMode: boolean) => void;
  onCloseDrawer?: () => void;
  onDrawerSearch?: (query: string) => void;
  onResumeCommand?: () => void;
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

const InputBar = forwardRef<InputBarHandle, Props>(function InputBar({ sessionId, disabled, minimal, onOpenDrawer, onCloseDrawer, onDrawerSearch, onResumeCommand }, ref) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dispatch = useChatDispatch();

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
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'Backspace' && e.key !== 'Enter' && e.key.length !== 1) return;
      inputRef.current?.focus();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [disabled]);

  // Unfocus textarea after 0.5s of no typing so global shortcuts (e.g. Shift
  // to open session switcher) can be detected without conflicting with input
  const idleBlurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const resetTimer = () => {
      if (idleBlurTimer.current) clearTimeout(idleBlurTimer.current);
      idleBlurTimer.current = setTimeout(() => {
        if (document.activeElement === el) el.blur();
      }, 500);
    };
    el.addEventListener('keydown', resetTimer);
    el.addEventListener('input', resetTimer);
    return () => {
      el.removeEventListener('keydown', resetTimer);
      el.removeEventListener('input', resetTimer);
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
      // Intercept /resume command
      if (message.trim() === '/resume' && onResumeCommand) {
        onResumeCommand();
        return;
      }

      const parts: string[] = [];
      for (const f of files) {
        parts.push(f.path);
      }
      if (message.trim()) {
        parts.push(message.trim());
      }
      const combined = parts.join(' ');
      if (!combined || disabled) return;

      dispatch({
        type: 'USER_PROMPT',
        sessionId,
        content: combined,
        timestamp: Date.now(),
      });

      // Replace newlines with spaces so multi-line pastes don't get split
      // into separate PTY inputs (each \n would act as Enter)
      window.claude.session.sendInput(sessionId, combined.replace(/[\r\n]+/g, ' ') + '\r');
    },
    [sessionId, disabled, dispatch],
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
    onCloseDrawer?.();
    // Reset height after clearing
    if (inputRef.current) inputRef.current.style.height = 'auto';
  }, [text, attachments, sendMessage, onCloseDrawer]);

  // Keep sendRef pointing at the latest send so the global keydown handler
  // (which can't depend on send without thrashing the listener) stays current
  useEffect(() => { sendRef.current = send; }, [send]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (minimal && sessionId) {
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
  };

  const handleChip = useCallback(
    (chip: QuickChip) => {
      sendMessage(chip.prompt);
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
          <textarea
            ref={inputRef}
            value={text}
            rows={1}
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
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (minimal && sessionId) {
                  // Terminal mode: send text + Enter directly to PTY
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
            onPaste={handlePaste}
            placeholder={disabled ? 'Waiting for approval...' : 'Message Claude...'}
            disabled={disabled}
            className="flex-1 bg-transparent text-sm text-fg placeholder-fg-muted outline-none disabled:opacity-50 resize-none overflow-y-hidden leading-snug"
          />
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
